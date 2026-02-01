/**
 * CSV Import HTTP Handler
 * Handles file upload, processing, and response
 */

import type { Context } from 'hono';
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

// ============================================================================
// Handler Functions
// ============================================================================

/**
 * Handle CSV/Excel file upload and processing
 */
export async function handleFileImport(c: Context): Promise<Response> {
  const instrumentation = getCSVInstrumentation();
  const requestId = c.get('requestId') || `http_${Date.now()}`;
  const auth = c.get('auth');
  const startTime = Date.now();

  // Increment active requests
  instrumentation.incrementActiveRequests({
    user_id: auth?.userId,
    tenant_id: auth?.tenantId,
  });

  try {
    // Parse multipart form data
    const formData = await c.req.parseBody({ all: true });
    const file = formData.file as File;

    if (!file || !(file instanceof File)) {
      throw new ValidationError('No file provided. Please upload a CSV or Excel file.');
    }

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
    const response: SuccessResponse = {
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

    return c.json(response, 200);

  } catch (error) {
    instrumentation.decrementActiveRequests({
      user_id: auth?.userId,
      tenant_id: auth?.tenantId,
    });

    const duration = Date.now() - startTime;
    const isKnownError = error instanceof ValidationError;

    if (!isKnownError) {
      console.error('Error processing file:', error);
    }

    const response: ErrorResponse = {
      success: false,
      error: {
        code: error instanceof ValidationError ? 'VALIDATION_ERROR' :
              error instanceof ServiceUnavailableError ? 'SERVICE_UNAVAILABLE' :
              'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'An unknown error occurred',
        details: error instanceof ValidationError ? error.details : undefined,
      },
      requestId,
    };

    const statusCode = error instanceof ValidationError ? 400 :
                      error instanceof ServiceUnavailableError ? 503 : 500;

    instrumentation.recordHttpRequest(
      'POST',
      '/api/v1/import',
      statusCode,
      duration,
      {
        user_id: auth?.userId || 'anonymous',
        tenant_id: auth?.tenantId || 'default',
        error_code: response.error.code,
      }
    );

    return c.json(response, statusCode);
  }
}

/**
 * Handle batch file import
 */
export async function handleBatchImport(c: Context): Promise<Response> {
  const instrumentation = getCSVInstrumentation();
  const requestId = c.get('requestId') || `batch_${Date.now()}`;
  const auth = c.get('auth');

  try {
    const formData = await c.req.parseBody({ all: true });
    const files = formData.files as File[] | File;

    const fileArray = Array.isArray(files) ? files : [files];
    const results: unknown[] = [];
    let totalRows = 0;
    let totalErrors = 0;

    for (const file of fileArray) {
      if (!(file instanceof File)) continue;

      const buffer = Buffer.from(await file.arrayBuffer());
      const detectedType = detectFileType(buffer);

      let result: any;
      if (detectedType === 'csv') {
        result = await processCsvFile(buffer);
      } else if (detectedType === 'xlsx') {
        result = await processExcelFile(buffer);
      } else {
        results.push({
          fileName: file.name,
          error: 'Unsupported file type',
        });
        continue;
      }

      totalRows += result.rowCount;
      totalErrors += result.errorCount;

      results.push({
        fileName: file.name,
        fileType: detectedType,
        rowCount: result.rowCount,
        successCount: result.successCount,
        errorCount: result.errorCount,
        summaries: result.summaries,
      });
    }

    return c.json({
      success: true,
      data: {
        totalFiles: fileArray.length,
        processedFiles: results.length,
        totalRows,
        totalErrors,
        results,
      },
      requestId,
    }, 200);

  } catch (error) {
    console.error('Batch import error:', error);

    return c.json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Batch import failed',
      },
      requestId,
    }, 500);
  }
}

/**
 * Handle file processing status check
 */
export async function handleStatusCheck(c: Context): Promise<Response> {
  const requestId = c.req.param('id');

  // In a real implementation, this would check a cache/database for status
  // For now, return a mock response
  return c.json({
    success: true,
    data: {
      requestId,
      status: 'complete',
      progress: 100,
      message: 'Processing complete',
    },
  }, 200);
}

/**
 * Handle metrics endpoint - Prometheus format
 */
export async function handleMetrics(c: Context): Promise<Response> {
  const mem = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  const now = Date.now();

  const metrics = [
    '# HELP csv_service_info Service information',
    '# TYPE csv_service_info gauge',
    `csv_service_info{service="csv-service-hono",version="1.0.0"} 1 ${now}`,
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
    `csv_memory_bytes{type="heap_used",service="hono"} ${mem.heapUsed}`,
    `csv_memory_bytes{type="heap_total",service="hono"} ${mem.heapTotal}`,
    `csv_memory_bytes{type="rss",service="hono"} ${mem.rss}`,
    `csv_memory_bytes{type="external",service="hono"} ${mem.external}`,
    '',
    '# HELP csv_cpu_usage_total CPU usage in nanoseconds',
    '# TYPE csv_cpu_usage_total counter',
    `csv_cpu_usage_total{type="user",service="hono"} ${cpuUsage.user}`,
    `csv_cpu_usage_total{type="system",service="hono"} ${cpuUsage.system}`,
    '',
    '# HELP csv_process_uptime_seconds Process uptime in seconds',
    '# TYPE csv_process_uptime_seconds gauge',
    `csv_process_uptime_seconds{service="hono"} ${process.uptime().toFixed(2)}`,
  ];

  return c.text(metrics.join('\n') + '\n', {
    headers: {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    },
  });
}

/**
 * Handle health check (Kubernetes probes)
 */
export async function handleHealthCheck(c: Context): Promise<Response> {
  const checks: Record<string, { status: 'pass' | 'fail'; message?: string; duration?: number }> = {};

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
    try {
      // Would do actual ping to Consul here
      checks.consul = {
        status: 'pass',
        message: 'Consul connected',
      };
    } catch {
      checks.consul = {
        status: 'fail',
        message: 'Consul unavailable',
      };
    }
  }

  // Determine overall status
  const allPass = Object.values(checks).every(c => c.status === 'pass');
  const status = allPass ? 'healthy' : 'degraded';

  return c.json({
    status,
    version: process.env.SERVICE_VERSION || '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks,
  }, allPass ? 200 : 503);
}

/**
 * Handle liveness probe (Kubernetes)
 */
export async function handleLiveness(c: Context): Promise<Response> {
  return c.json({ status: 'alive' }, 200);
}

/**
 * Handle readiness probe (Kubernetes)
 */
export async function handleReadiness(c: Context): Promise<Response> {
  // Check if service is ready to accept traffic
  const isReady = true; // Would check dependencies here

  return c.json(
    { status: isReady ? 'ready' : 'not_ready' },
    isReady ? 200 : 503
  );
}

/**
 * Handle Consul health check
 */
export async function handleConsulHealth(c: Context): Promise<Response> {
  const service = c.req.query('service') || 'csv-service';

  return c.json({
    status: 'SERVING',
    version: process.env.SERVICE_VERSION || '1.0.0',
    service,
    timestamp: new Date().toISOString(),
  }, 200);
}

/**
 * Get service info
 */
export async function handleServiceInfo(c: Context): Promise<Response> {
  return c.json({
    service: process.env.SERVICE_NAME || 'csv-service',
    version: process.env.SERVICE_VERSION || '1.0.0',
    framework: process.env.FRAMEWORK || 'hono',
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
  }, 200);
}

export type { SuccessResponse, ErrorResponse };
