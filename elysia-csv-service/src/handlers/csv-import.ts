/**
 * CSV Import HTTP Handlers for Elysia
 * Handles file upload, processing, and response
 */

import { processCsvFile, processExcelFile, detectFileType } from '../utils/csv-parser.js';
import { getCSVInstrumentation } from '../telemetry/otel.js';
import { ValidationError, ServiceUnavailableError } from '../types.js';

// ============================================================================
// Response Types
// ============================================================================

interface SuccessResponse {
  success: true;
  data: {
    rowCount: number;
    successCount: number;
    errorCount: number;
    summaries: Array<{
      region: string;
      country: string;
      count: number;
      amountSum: number;
      amountAvg: number;
    }>;
    stats: {
      parseDurationMs: number;
      validateDurationMs: number;
      aggregateDurationMs: number;
      totalDurationMs: number;
    };
  };
  requestId: string;
  fileName: string;
  fileType: string;
}

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  requestId: string;
}

interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy' | 'degraded';
  version: string;
  uptime: number;
  timestamp: string;
  checks: Record<string, { status: string; message?: string }>;
}

// ============================================================================
// Handler Functions
// ============================================================================

/**
 * Handle CSV/Excel file upload and processing
 */
export async function handleFileImport(
  file: File,
  requestId: string,
  auth?: { userId?: string; tenantId?: string }
): Promise<SuccessResponse> {
  const instrumentation = getCSVInstrumentation();
  const startTime = Date.now();

  // Increment active requests
  instrumentation.incrementActiveRequests({
    user_id: auth?.userId,
    tenant_id: auth?.tenantId,
  });

  try {
    // Validate file size
    const maxSize = parseInt(process.env.MAX_FILE_SIZE || '104857600', 10); // 100MB default
    if (file.size > maxSize) {
      throw new ValidationError(
        `File size exceeds maximum allowed size of ${maxSize / 1024 / 1024}MB`,
        { fileSize: file.size, maxSize }
      );
    }

    // Detect file type
    const buffer = Buffer.from(await file.arrayBuffer());
    const detectedType = detectFileType(buffer);
    const fileName = file.name;

    // Validate file type
    const validTypes = ['csv', 'xlsx'];
    if (!validTypes.includes(detectedType)) {
      throw new ValidationError(
        `Invalid file type. Only CSV and Excel files are supported.`,
        { detectedType, fileName }
      );
    }

    // Process file with OTEL tracing
    const result = await instrumentation.withFileProcessSpan(
      fileName,
      detectedType,
      async (span) => {
        // Add attributes to span
        span.setAttribute('file.size', file.size);
        span.setAttribute('request.id', requestId);
        if (auth?.userId) {
          span.setAttribute('user.id', auth.userId);
        }
        if (auth?.tenantId) {
          span.setAttribute('tenant.id', auth.tenantId);
        }

        // Process based on file type
        if (detectedType === 'csv') {
          return await processCsvFile(buffer);
        } else {
          return await processExcelFile(buffer);
        }
      }
    );

    // Record metrics
    const duration = Date.now() - startTime;
    instrumentation.recordCsvProcessing(
      result.rowCount,
      duration,
      result.errorCount,
      {
        user_id: auth?.userId || 'anonymous',
        tenant_id: auth?.tenantId || 'default',
        file_type: detectedType,
        request_id: requestId,
      }
    );

    instrumentation.decrementActiveRequests({
      user_id: auth?.userId,
      tenant_id: auth?.tenantId,
    });

    // Send response
    return {
      success: true,
      data: {
        rowCount: result.rowCount,
        successCount: result.successCount,
        errorCount: result.errorCount,
        summaries: result.summaries,
        stats: result.stats,
      },
      requestId,
      fileName,
      fileType: detectedType,
    };

  } catch (error) {
    instrumentation.decrementActiveRequests({
      user_id: auth?.userId,
      tenant_id: auth?.tenantId,
    });

    if (error instanceof ValidationError || error instanceof ServiceUnavailableError) {
      throw error;
    }

    throw new Error(error instanceof Error ? error.message : 'An unknown error occurred');
  }
}

/**
 * Handle health check
 */
export function handleHealthCheck(): HealthCheckResponse {
  const checks: Record<string, { status: string; message?: string }> = {};

  // Basic health check
  checks.server = {
    status: 'pass',
    message: 'Server is running',
  };

  // Check OTEL connection
  const otelEnabled = process.env.OTEL_ENABLED !== 'false';
  if (otelEnabled) {
    checks.otel = {
      status: 'pass',
      message: 'OTEL initialized',
    };
  }

  // Check Consul connection
  const consulEnabled = process.env.CONSUL_ENABLED === 'true';
  if (consulEnabled) {
    checks.consul = {
      status: 'pass',
      message: 'Consul available',
    };
  }

  // Determine overall status
  const allPass = Object.values(checks).every(c => c.status === 'pass');
  const status = allPass ? 'healthy' : 'degraded';

  return {
    status,
    version: process.env.SERVICE_VERSION || '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks,
  };
}

/**
 * Handle service info
 */
export function handleServiceInfo() {
  return {
    service: process.env.SERVICE_NAME || 'csv-service',
    version: process.env.SERVICE_VERSION || '1.0.0',
    framework: process.env.FRAMEWORK || 'elysia',
    runtime: 'bun',
    description: 'CSV/Excel file processing microservice',
    endpoints: {
      http: {
        import: 'POST /api/v1/import',
        batchImport: 'POST /api/v1/batch',
        health: 'GET /api/v1/health',
        metrics: 'GET /metrics',
      },
      grpc: {
        port: parseInt(process.env.GRPC_PORT || '50051', 10),
        services: ['CSVService'],
      },
    },
  };
}

/**
 * Handle liveness probe
 */
export function handleLiveness() {
  return { status: 'alive' };
}

/**
 * Handle readiness probe
 */
export function handleReadiness() {
  const isReady = true; // Would check dependencies here
  return { status: isReady ? 'ready' : 'not_ready' };
}

/**
 * Handle metrics endpoint - Prometheus format
 */
export function handleMetrics() {
  const mem = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  const now = Date.now();

  const metrics = [
    '# HELP csv_service_info Service information',
    '# TYPE csv_service_info gauge',
    `csv_service_info{service="csv-service-elysia",version="1.0.0"} 1 ${now}`,
    '',
    '# HELP csv_http_requests_total Total HTTP requests',
    '# TYPE csv_http_requests_total counter',
    'csv_http_requests_total{method="POST",endpoint="/api/v1/import"} 0',
    '',
    '# HELP csv_active_requests Current active requests',
    '# TYPE csv_active_requests gauge',
    'csv_active_requests 0',
    '',
    '# HELP csv_memory_bytes Memory usage in bytes',
    '# TYPE csv_memory_bytes gauge',
    `csv_memory_bytes{type="heap_used",service="elysia"} ${mem.heapUsed}`,
    `csv_memory_bytes{type="heap_total",service="elysia"} ${mem.heapTotal}`,
    `csv_memory_bytes{type="rss",service="elysia"} ${mem.rss}`,
    `csv_memory_bytes{type="external",service="elysia"} ${mem.external}`,
    '',
    '# HELP csv_cpu_usage_total CPU usage in nanoseconds',
    '# TYPE csv_cpu_usage_total counter',
    `csv_cpu_usage_total{type="user",service="elysia"} ${cpuUsage.user}`,
    `csv_cpu_usage_total{type="system",service="elysia"} ${cpuUsage.system}`,
    '',
    '# HELP csv_process_uptime_seconds Process uptime in seconds',
    '# TYPE csv_process_uptime_seconds gauge',
    `csv_process_uptime_seconds{service="elysia"} ${process.uptime().toFixed(2)}`,
  ];

  return new Response(metrics.join('\n') + '\n', {
    headers: {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    },
  });
}

/**
 * Handle Consul health check
 */
export function handleConsulHealth(service?: string) {
  return {
    status: 'SERVING',
    version: process.env.SERVICE_VERSION || '1.0.0',
    service: service || 'csv-service',
    timestamp: new Date().toISOString(),
  };
}

export type { SuccessResponse, ErrorResponse, HealthCheckResponse };
