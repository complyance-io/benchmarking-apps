/**
 * gRPC Server Implementation
 * Handles ProcessFile and HealthCheck RPCs
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
import { processCsvFile, processExcelFile } from '../utils/csv-parser.js';
import { getCSVInstrumentation } from '../telemetry/otel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Types
// ============================================================================

interface GrpcContext {
  metadata: grpc.Metadata;
  getPeer(): string;
}

interface ProcessFileRequest {
  file_data: Buffer;
  file_type: string;
  file_name: string;
  metadata?: Record<string, string>;
}

interface ProcessFileResponse {
  row_count: number;
  success_count: number;
  error_count: number;
  summaries: RegionSummary[];
  stats: ProcessingStatsResponse;
  request_id: string;
}

interface RegionSummary {
  region: string;
  country: string;
  count: number;
  amount_sum: number;
  amount_avg: number;
}

interface ProcessingStatsResponse {
  parse_duration_ms: number;
  validate_duration_ms: number;
  aggregate_duration_ms: number;
  total_duration_ms: number;
}

interface HealthCheckRequest {
  service: string;
}

interface HealthCheckResponse {
  status: 'UNKNOWN' | 'SERVING' | 'NOT_SERVING' | 'SERVICE_UNKNOWN';
  version: string;
  details: Record<string, string>;
}

// ============================================================================
// gRPC Service Handler
// ============================================================================

export class GrpcServiceHandler {
  private server: grpc.Server | null = null;
  private port: number;
  private instrumentation: ReturnType<typeof getCSVInstrumentation>;
  private packageDefinition: any;
  private protoDescriptor: any;

  constructor(port: number = 50051) {
    this.port = port;
    this.instrumentation = getCSVInstrumentation();
    this.loadProto();
  }

  private loadProto(): void {
    const protoPath = path.join(__dirname, '../../proto/csvservice.proto');

    this.packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    this.protoDescriptor = grpc.loadPackageDefinition(this.packageDefinition);
  }

  /**
   * Start the gRPC server
   */
  async start(): Promise<void> {
    if (this.server) {
      console.log('gRPC server already running');
      return;
    }

    this.server = new grpc.Server({
      'grpc.max_receive_message_length': 100 * 1024 * 1024, // 100MB
      'grpc.max_send_message_length': 100 * 1024 * 1024,
      'grpc.keepalive_time_ms': 10000,
      'grpc.keepalive_timeout_ms': 5000,
      'grpc.keepalive_permit_without_calls': 1,
    });

    // Add CSV Service
    this.server.addService(
      (this.protoDescriptor.csvservice as any).CSVService.service,
      {
        processFile: this.processFile.bind(this),
        healthCheck: this.healthCheck.bind(this),
        processFileStream: this.processFileStream.bind(this),
      }
    );

    // Get port from binding
    const bindAddress = `0.0.0.0:${this.port}`;
    const port = this.server.bindAsync(
      bindAddress,
      grpc.ServerCredentials.createInsecure(),
      (error: Error | null, port: number) => {
        if (error) {
          console.error('Failed to bind gRPC server:', error);
          throw error;
        }
        console.log(`gRPC server bound on port ${port}`);
      }
    );

    if (typeof port === 'number') {
      this.port = port;
    }

    this.server.start();

    console.log(`gRPC server listening on ${bindAddress}`);
  }

  /**
   * Stop the gRPC server
   */
  async forceShutdown(): Promise<void> {
    if (!this.server) {
      return;
    }

    return new Promise((resolve) => {
      this.server!.tryShutdown((error) => {
        if (error) {
          console.error('gRPC shutdown error:', error);
        }
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Get server credentials (for TLS)
   */
  private getCredentials(): grpc.ServerCredentials {
    // Use insecure credentials for development
    // In production, use createSsl with actual certificates
    if (process.env.GRPC_SSL_ENABLED === 'true') {
      const fs = require('fs');
      const key = fs.readFileSync(process.env.GRPC_SSL_KEY || 'key.pem');
      const cert = fs.readFileSync(process.env.GRPC_SSL_CERT || 'cert.pem');
      const ca = process.env.GRPC_SSL_CA ? fs.readFileSync(process.env.GRPC_SSL_CA) : undefined;

      return grpc.ServerCredentials.createSsl(
        ca,
        [{ private_key: key, cert_chain: cert }],
        false
      );
    }

    return grpc.ServerCredentials.createInsecure();
  }

  // ========================================================================
  // RPC Handlers
  // ========================================================================

  /**
   * ProcessFile RPC handler
   */
  private async processFile(
    call: grpc.ServerUnaryCall<ProcessFileRequest, ProcessFileResponse>,
    callback: grpc.sendUnaryData<ProcessFileResponse>
  ): Promise<void> {
    const startTime = Date.now();
    const request = call.request;
    const metadata = call.metadata;

    // Extract trace context from metadata
    const traceId = metadata.get('traceparent')?.[0] || undefined;
    const userId = metadata.get('user-id')?.[0];
    const tenantId = metadata.get('tenant-id')?.[0];

    const requestId = `grpc_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;

    console.log(`[gRPC] ProcessFile request: ${request.file_name}, size: ${request.file_data.length}, type: ${request.file_type}`);

    try {
      // Parse and process file
      let result: any;

      if (request.file_type === 'csv') {
        result = await processCsvFile(request.file_data);
      } else if (request.file_type === 'xlsx') {
        result = await processExcelFile(request.file_data);
      } else {
        throw new Error(`Unsupported file type: ${request.file_type}`);
      }

      const duration = Date.now() - startTime;

      // Record metrics
      this.instrumentation.recordGrpcRequest(
        'CSVService.ProcessFile',
        'OK',
        duration,
        {
          user_id: userId || 'unknown',
          tenant_id: tenantId || 'unknown',
          file_type: request.file_type,
          request_id: requestId,
        }
      );

      // Build response
      const response: ProcessFileResponse = {
        row_count: result.rowCount,
        success_count: result.successCount,
        error_count: result.errorCount,
        summaries: result.summaries.map((s: any) => ({
          region: s.region,
          country: s.country,
          count: s.count,
          amount_sum: s.amountSum,
          amount_avg: s.amountAvg,
        })),
        stats: {
          parse_duration_ms: result.stats.parseDurationMs,
          validate_duration_ms: result.stats.validateDurationMs,
          aggregate_duration_ms: result.stats.aggregateDurationMs,
          total_duration_ms: duration,
        },
        request_id: requestId,
      };

      callback(null, response);

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.instrumentation.recordGrpcRequest(
        'CSVService.ProcessFile',
        'ERROR',
        duration,
        {
          user_id: userId || 'unknown',
          tenant_id: tenantId || 'unknown',
          file_type: request.file_type,
          error: errorMessage,
        }
      );

      callback({
        code: grpc.status.INTERNAL,
        message: errorMessage,
        details: errorMessage,
      });
    }
  }

  /**
   * HealthCheck RPC handler
   */
  private healthCheck(
    call: grpc.ServerUnaryCall<HealthCheckRequest, HealthCheckResponse>,
    callback: grpc.sendUnaryData<HealthCheckResponse>
  ): void {
    const response: HealthCheckResponse = {
      status: 'SERVING',
      version: process.env.SERVICE_VERSION || '1.0.0',
      details: {
        service: process.env.SERVICE_NAME || 'csv-service',
        runtime: 'bun',
        framework: process.env.FRAMEWORK || 'hono',
        uptime: process.uptime().toString(),
      },
    };

    callback(null, response);
  }

  /**
   * ProcessFileStream RPC handler (for large files)
   */
  private async processFileStream(
    call: grpc.ServerDuplexStream<any, any>
  ): Promise<void> {
    const chunks: Buffer[] = [];
    let fileType = 'csv';
    let fileName = 'unknown';
    let totalChunks = 0;

    // Collect incoming chunks
    call.on('data', (chunk: any) => {
      if (chunk.chunk_data) {
        chunks.push(Buffer.from(chunk.chunk_data));
        fileType = chunk.file_type || 'csv';
        fileName = chunk.file_name || 'unknown';
        totalChunks++;

        // Send progress update
        call.write({
          processed_rows: 0,
          total_rows: totalChunks,
          status: 'receiving',
          message: `Received chunk ${chunks.length}`,
        });
      }
    });

    call.on('end', async () => {
      try {
        // Combine chunks
        const fileData = Buffer.concat(chunks);

        // Process file
        let result: any;
        if (fileType === 'csv') {
          result = await processCsvFile(fileData);
        } else if (fileType === 'xlsx') {
          result = await processExcelFile(fileData);
        } else {
          throw new Error(`Unsupported file type: ${fileType}`);
        }

        // Send final result
        call.write({
          processed_rows: result.rowCount,
          total_rows: result.rowCount,
          status: 'complete',
          message: 'Processing complete',
        });

        call.end();
      } catch (error) {
        call.emit('error', error);
      }
    });

    call.on('error', (error: Error) => {
      console.error('Stream error:', error);
      call.write({
        status: 'error',
        message: error.message,
      });
      call.end();
    });
  }

  /**
   * Get current server state
   */
  getServerState(): string {
    if (!this.server) return 'NOT_STARTED';

    // Check internal state (implementation-specific)
    return 'RUNNING';
  }
}

// ============================================================================
// Server Factory
// ============================================================================

export function createGrpcServer(port: number = 50051): GrpcServiceHandler {
  return new GrpcServiceHandler(port);
}

export type { ProcessFileRequest, ProcessFileResponse, HealthCheckRequest, HealthCheckResponse };
