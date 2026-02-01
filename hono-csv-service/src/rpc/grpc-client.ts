/**
 * gRPC Client for CSV Service
 * Handles connections to remote gRPC servers
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { fileURLToPath } from 'url';
import { CircuitBreakerState, CircuitBreakerConfig } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================

const GRPC_CONFIG = {
  maxReceiveMessageLength: 100 * 1024 * 1024, // 100MB
  maxSendMessageLength: 100 * 1024 * 1024,
  maxRetryDelay: 60000,
  initialRetryDelay: 1000,
  maxRetries: 5,
};

// ============================================================================
// Circuit Breaker
// ============================================================================

interface CircuitBreakerOptions {
  failureThreshold: number;
  recoveryTimeout: number;
  monitoringPeriod: number;
}

class CircuitBreaker {
  private state: CircuitBreakerState = CircuitBreakerState.Closed;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private nextAttemptTime = 0;
  private options: CircuitBreakerOptions;

  constructor(options: CircuitBreakerOptions) {
    this.options = options;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we should attempt recovery
    if (this.state === CircuitBreakerState.Open && Date.now() >= this.nextAttemptTime) {
      this.state = CircuitBreakerState.HalfOpen;
      this.successCount = 0;
    }

    // Reject if circuit is open
    if (this.state === CircuitBreakerState.Open) {
      throw new Error('Circuit breaker is OPEN');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.successCount++;

    if (this.state === CircuitBreakerState.HalfOpen) {
      if (this.successCount >= 3) {
        this.state = CircuitBreakerState.Closed;
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = CircuitBreakerState.Open;
      this.nextAttemptTime = Date.now() + this.options.recoveryTimeout;
    }
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  reset(): void {
    this.state = CircuitBreakerState.Closed;
    this.failureCount = 0;
    this.successCount = 0;
  }

  getStats() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

// ============================================================================
// gRPC Client Pool
// ============================================================================

interface ClientConnection {
  client: any;
  channel: grpc.Channel;
  lastUsed: number;
  circuitBreaker: CircuitBreaker;
}

export class GrpcClientPool {
  private connections: Map<string, ClientConnection> = new Map();
  private packageDefinition: any;
  private protoDescriptor: any;
  private csvService: any;

  constructor() {
    this.loadProto();
  }

  private loadProto(): void {
    const protoPath = path.join(__dirname, '../../proto/csvservice.proto');

    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    this.packageDefinition = packageDefinition;
    this.protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
    this.csvService = this.protoDescriptor.csvservice;
  }

  /**
   * Get or create a gRPC client connection
   */
  private getConnection(target: string): ClientConnection {
    let connection = this.connections.get(target);

    if (!connection || !this.isChannelReady(connection.channel)) {
      connection = this.createConnection(target);
      this.connections.set(target, connection);
    }

    connection.lastUsed = Date.now();
    return connection;
  }

  /**
   * Create a new gRPC connection
   */
  private createConnection(target: string): ClientConnection {
    const credentials = grpc.credentials.createInsecure();

    const channel = new grpc.Channel(
      target,
      credentials,
      {
        'grpc.max_receive_message_length': GRPC_CONFIG.maxReceiveMessageLength,
        'grpc.max_send_message_length': GRPC_CONFIG.maxSendMessageLength,
        'grpc.keepalive_time_ms': 10000,
        'grpc.keepalive_timeout_ms': 5000,
        'grpc.keepalive_permit_without_calls': 1,
      }
    );

    const client = new this.csvService.CSVService(target, credentials);

    const circuitBreaker = new CircuitBreaker({
      failureThreshold: 5,
      recoveryTimeout: 30000,
      monitoringPeriod: 60000,
    });

    return {
      client,
      channel,
      lastUsed: Date.now(),
      circuitBreaker,
    };
  }

  /**
   * Check if channel is ready
   */
  private isChannelReady(channel: grpc.Channel): boolean {
    return channel.getState() === grpc.connectivityState.READY;
  }

  /**
   * Process file via gRPC
   */
  async processFile(
    target: string,
    fileData: Buffer,
    fileType: string,
    fileName: string,
    metadata: Record<string, string> = {}
  ): Promise<any> {
    const connection = this.getConnection(target);

    return connection.circuitBreaker.execute(async () => {
      return new Promise((resolve, reject) => {
        const request = {
          file_data: fileData,
          file_type: fileType,
          file_name: fileName,
          metadata,
        };

        const deadline = new Date();
        deadline.setSeconds(deadline.getSeconds() + 30);

        connection.client.process_file(
          request,
          { deadline },
          (error: Error | null, response: any) => {
            if (error) {
              reject(error);
            } else {
              resolve(response);
            }
          }
        );
      });
    });
  }

  /**
   * Health check via gRPC
   */
  async healthCheck(target: string, service = 'csv-service'): Promise<any> {
    const connection = this.getConnection(target);

    return new Promise((resolve, reject) => {
      const request = { service };

      connection.client.health_check(
        request,
        { timeout: 5000 },
        (error: Error | null, response: any) => {
          if (error) {
            reject(error);
          } else {
            resolve(response);
          }
        }
      );
    });
  }

  /**
   * Stream file processing
   */
  async processFileStream(
    target: string,
    chunks: Buffer[],
    fileType: string,
    fileName: string
  ): Promise<any> {
    const connection = this.getConnection(target);

    return connection.circuitBreaker.execute(async () => {
      return new Promise((resolve, reject) => {
        const call = connection.client.process_file_stream();

        // Send chunks
        for (let i = 0; i < chunks.length; i++) {
          call.write({
            chunk_data: chunks[i],
            chunk_index: i,
            is_last: i === chunks.length - 1,
          });
        }

        call.end();

        // Collect responses
        const responses: any[] = [];
        call.on('data', (response: any) => {
          responses.push(response);
        });

        call.on('end', () => {
          resolve(responses);
        });

        call.on('error', (error: Error) => {
          reject(error);
        });
      });
    });
  }

  /**
   * Close a specific connection
   */
  async closeConnection(target: string): Promise<void> {
    const connection = this.connections.get(target);
    if (connection) {
      connection.channel.close();
      this.connections.delete(target);
    }
  }

  /**
   * Close all connections
   */
  async closeAll(): Promise<void> {
    for (const [target] of this.connections) {
      await this.closeConnection(target);
    }
  }

  /**
   * Get connection statistics
   */
  getStats() {
    const stats: Record<string, any> = {};

    for (const [target, connection] of this.connections) {
      stats[target] = {
        state: connection.channel.getState(),
        circuitBreaker: connection.circuitBreaker.getStats(),
        lastUsed: connection.lastUsed,
      };
    }

    return stats;
  }

  /**
   * Reset circuit breaker for a target
   */
  resetCircuitBreaker(target: string): void {
    const connection = this.connections.get(target);
    if (connection) {
      connection.circuitBreaker.reset();
    }
  }
}

// ============================================================================
// Singleton Pool
// ============================================================================

export const grpcClientPool = new GrpcClientPool();

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get gRPC service address from service discovery
 */
export async function getServiceAddress(
  serviceName: string,
  defaultPort: number = 50051
): Promise<string> {
  // In production, this would query Consul or other service discovery
  // For now, use environment variable or default
  const envVar = `${serviceName.toUpperCase().replace(/-/g, '_')}_GRPC_ENDPOINT`;

  return process.env[envVar] || `localhost:${defaultPort}`;
}

/**
 * Convert region summaries to proto format
 */
export function toProtoRegionSummaries(summaries: any[]): any[] {
  return summaries.map(summary => ({
    region: summary.region,
    country: summary.country,
    count: summary.count,
    amount_sum: summary.amountSum || summary.amount_sum,
    amount_avg: summary.amountAvg || summary.amount_avg,
  }));
}

/**
 * Convert processing stats to proto format
 */
export function toProtoStats(stats: any): any {
  return {
    parse_duration_ms: stats.parseDurationMs || stats.parse_duration_ms,
    validate_duration_ms: stats.validateDurationMs || stats.validate_duration_ms,
    aggregate_duration_ms: stats.aggregateDurationMs || stats.aggregate_duration_ms,
    total_duration_ms: stats.totalDurationMs || stats.total_duration_ms,
  };
}

export { GRPC_CONFIG };
export type { ClientConnection };
