/**
 * Elysia CSV Service - Main Entry Point
 * HTTP + gRPC servers with OTEL, Consul, and production middleware
 */

import { Elysia } from 'elysia';
import { initializeOpenTelemetry, shutdownOpenTelemetry } from './telemetry/otel.js';
// Auth middleware removed for benchmarking
// Rate limiting imports removed for benchmarking
import {
  corsPlugin,
  securityHeadersPlugin,
  requestIdPlugin,
  requestLoggingPlugin,
} from './middleware/cors-security.js';
import {
  handleFileImport,
  handleHealthCheck,
  handleServiceInfo,
  handleLiveness,
  handleReadiness,
  handleMetrics,
  handleConsulHealth,
} from './handlers/csv-import.js';
import { createGrpcServer } from './handlers/grpc-service.js';
import { createConsulClient, buildServiceConfig } from './discovery/consul.js';
import { ERROR_CODES, REQUIRED_SCOPES } from './types.js';

// ============================================================================
// Environment Configuration
// ============================================================================

const ENV = {
  SERVICE_NAME: process.env.SERVICE_NAME || 'csv-service-elysia',
  SERVICE_VERSION: process.env.SERVICE_VERSION || '1.0.0',
  ENVIRONMENT: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '3000', 10),
  GRPC_PORT: parseInt(process.env.GRPC_PORT || '50051', 10),
  HOST: process.env.HOST || '0.0.0.0',

  // Auth
  JWT_SECRET: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  JWT_ISSUER: process.env.JWT_ISSUER || 'csv-service',

  // OTEL
  OTEL_ENABLED: process.env.OTEL_ENABLED !== 'false',
  OTEL_COLLECTOR_ENDPOINT: process.env.OTEL_COLLECTOR_ENDPOINT || 'http://otel-collector:4318',

  // Consul
  CONSUL_ENABLED: process.env.CONSUL_ENABLED === 'true',
  CONSUL_HOST: process.env.CONSUL_HOST || 'localhost',
  CONSUL_PORT: parseInt(process.env.CONSUL_PORT || '8500', 10),
};

// ============================================================================
// Initialize OTEL
// ============================================================================

const instrumentation = await initializeOpenTelemetry();
console.log(`[${ENV.SERVICE_NAME}] OpenTelemetry initialized`);

// ============================================================================
// Create Elysia App
// ============================================================================

const app = new Elysia({
  name: ENV.SERVICE_NAME,
  prefix: '',
});

// ============================================================================
// Global Plugins
// ============================================================================

app
  .use(requestIdPlugin())
  .use(corsPlugin())
  .use(securityHeadersPlugin())
  .use(requestLoggingPlugin());

// ============================================================================
// Request Context Store
// ============================================================================

interface RequestContext {
  requestId: string;
  startTime: number;
  auth?: {
    isAuthenticated: boolean;
    userId: string;
    tenantId?: string;
    scopes: string[];
  };
}

// ============================================================================
// Public Endpoints (No Auth Required)
// ============================================================================

// Health checks for Kubernetes
app.get('/health', () => handleHealthCheck());
app.get('/live', () => handleLiveness());
app.get('/ready', () => handleReadiness());

// Consul health check
app.get('/consul/health', ({ query }) => handleConsulHealth(query.service as string));

// Service info
app.get('/', () => handleServiceInfo());
app.get('/info', () => handleServiceInfo());

// Metrics endpoint
app.get('/metrics', () => handleMetrics());

// ============================================================================
// API v1 Routes
// ============================================================================

const apiV1 = new Elysia({
  prefix: '/api/v1',
  name: 'api-v1',
});
// Auth and rate limiting disabled for benchmarking

// ============================================================================
// Public Info
// ============================================================================

apiV1.get('/', () => handleServiceInfo());

// ============================================================================
// Import Endpoints
// ============================================================================

// File import endpoint (direct route, no sub-app for bundling compatibility)
apiV1.post(
  '/import',
  async ({ request, set, requestId }) => {
    // Get file from multipart form
    const formData = await request.formData();
    const file = formData.get('file') as File;

    if (!file || !(file instanceof File)) {
      set.status = 400;
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'No file provided. Please upload a CSV or Excel file.',
        },
        requestId,
      };
    }

    try {
      const result = await handleFileImport(file, requestId, { userId: 'anonymous' });
      set.status = 200;
      return result;
    } catch (error) {
      const statusCode = error instanceof Error && error.message.includes('size')
        ? 413
        : 500;

      set.status = statusCode;

      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
        requestId,
      };
    }
  }
);

// Batch import endpoint (no auth for benchmarking)
apiV1.post(
  '/import/batch',
  async ({ request, set, requestId }) => {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];

    if (!files || files.length === 0) {
      set.status = 400;
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'No files provided.',
        },
        requestId,
      };
    }

    const results: unknown[] = [];
    let totalRows = 0;
    let totalErrors = 0;

    for (const file of files) {
      if (!(file instanceof File)) continue;

      try {
        const result = await handleFileImport(file, requestId, { userId: 'anonymous' });
        totalRows += result.data.rowCount;
        totalErrors += result.data.errorCount;
        results.push({
          fileName: result.fileName,
          fileType: result.fileType,
          rowCount: result.data.rowCount,
          successCount: result.data.successCount,
          errorCount: result.data.errorCount,
        });
      } catch (error) {
        results.push({
          fileName: file.name,
          error: error instanceof Error ? error.message : 'Processing failed',
        });
      }
    }

    return {
      success: true,
      data: {
        totalFiles: files.length,
        processedFiles: results.length,
        totalRows,
        totalErrors,
        results,
      },
      requestId,
    };
  }
);

// Mount API v1 routes
app.mount(apiV1);

// ============================================================================
// Error Handling
// ============================================================================

app.onError(({ error, set, requestId }) => {
  console.error('[Error]', {
    error: error.message,
    stack: error.stack,
    requestId,
  });

  set.status = 500;

  return {
    success: false,
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: ENV.ENVIRONMENT === 'production'
        ? 'An internal error occurred'
        : error.message,
    },
    requestId,
  };
});

// 404 handler removed for bundling compatibility (use default Elysia 404)

// ============================================================================
// gRPC Server (disabled for production builds due to bundling limitations)
// ============================================================================

let grpcServer: ReturnType<typeof createGrpcServer> | null = null;

// Only initialize gRPC for development builds (proto files don't bundle correctly)
if (process.env.NODE_ENV === 'development') {
  try {
    grpcServer = createGrpcServer(ENV.GRPC_PORT);
  } catch (error) {
    console.warn('[gRPC] Failed to initialize, continuing without gRPC:', error);
  }
} else {
  console.log('[gRPC] Disabled in production builds (HTTP only mode)');
}

// ============================================================================
// Consul Registration
// ============================================================================

let consulClient: import('./discovery/consul.js').ConsulClient | null = null;

async function registerWithConsul() {
  if (!ENV.CONSUL_ENABLED) {
    console.log('[Consul] Service discovery disabled');
    return;
  }

  try {
    consulClient = createConsulClient(ENV.SERVICE_NAME, ENV.PORT, {
      enabled: true,
      host: ENV.CONSUL_HOST,
      port: ENV.CONSUL_PORT,
    });

    const serviceConfig = buildServiceConfig(
      ENV.SERVICE_NAME,
      ENV.PORT,
      'elysia',
      {
        healthCheckPath: '/health',
        tags: [
          `version=${ENV.SERVICE_VERSION}`,
          `environment=${ENV.ENVIRONMENT}`,
          'http',
          'grpc',
        ],
      }
    );

    await consulClient.registerService(serviceConfig);
    console.log(`[Consul] Service registered: ${ENV.SERVICE_NAME}`);

  } catch (error) {
    console.error('[Consul] Failed to register service:', error);
  }
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    console.log('[Shutdown] Already in progress, ignoring signal:', signal);
    return;
  }

  isShuttingDown = true;
  console.log(`[Shutdown] Received ${signal}, starting graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    console.error('[Shutdown] Forced shutdown after timeout');
    process.exit(1);
  }, 30000);

  try {
    // Deregister from Consul
    if (consulClient) {
      console.log('[Shutdown] Deregistering from Consul...');
      await consulClient.close();
    }

    // Shutdown gRPC server (if initialized)
    if (grpcServer) {
      console.log('[Shutdown] Stopping gRPC server...');
      await grpcServer.forceShutdown();
    }

    // Shutdown OTEL
    console.log('[Shutdown] Flushing OTEL telemetry...');
    await shutdownOpenTelemetry();

    // Cleanup rate limiter
    await cleanupRateLimiter();

    console.log('[Shutdown] Graceful shutdown complete');
    clearTimeout(shutdownTimeout);
    process.exit(0);

  } catch (error) {
    console.error('[Shutdown] Error during shutdown:', error);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

// Register signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[Uncaught Exception]', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection]', reason, 'at:', promise);
});

// ============================================================================
// Start Servers
// ============================================================================

async function start() {
  console.log('='.repeat(60));
  console.log(`${ENV.SERVICE_NAME} v${ENV.SERVICE_VERSION}`);
  console.log('='.repeat(60));

  // Start gRPC server (if initialized)
  if (grpcServer) {
    try {
      await grpcServer.start();
      console.log(`[gRPC] Server listening on port ${ENV.GRPC_PORT}`);
    } catch (error) {
      console.error('[gRPC] Failed to start:', error);
      // Don't exit, continue with HTTP only
    }
  } else {
    console.log('[gRPC] Disabled for binary build (HTTP only mode)');
  }

  // Register with Consul
  await registerWithConsul();

  console.log(`[HTTP] Server starting on http://${ENV.HOST}:${ENV.PORT}`);
  console.log(`[HTTP] Environment: ${ENV.ENVIRONMENT}`);
  console.log(`[HTTP] Framework: Elysia (Bun runtime)`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET  /health          - Health check (Kubernetes readiness)');
  console.log('  GET  /ready           - Readiness probe');
  console.log('  GET  /live            - Liveness probe');
  console.log('  POST /api/v1/import   - Upload and process CSV/Excel files');
  console.log('  POST /api/v1/batch    - Batch file upload');
  console.log('  GET  /metrics         - Service metrics');
  console.log('  GET  /                - Service information');
  console.log('');
  console.log('gRPC Service (port 50051):');
  console.log('  CSVService.ProcessFile    - Process file via gRPC');
  console.log('  CSVService.HealthCheck    - Health check via gRPC');
  console.log('');
  console.log('Press Ctrl+C to stop');
  console.log('='.repeat(60));

  // Start HTTP server using Bun's native server (app.listen doesn't work with minified builds)
  Bun.serve({
    fetch: app.fetch,
    hostname: ENV.HOST,
    port: ENV.PORT,
  });

  console.log(`[HTTP] Server listening on http://${ENV.HOST}:${ENV.PORT}`);
}

// Start the service
start().catch((error) => {
  console.error('[Startup] Failed to start service:', error);
  process.exit(1);
});

// Export for testing (no default export to avoid Bun's auto-server detection)
export { app, ENV, instrumentation };
