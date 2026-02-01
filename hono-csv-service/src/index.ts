/**
 * Hono CSV Service - Main Entry Point
 * HTTP + gRPC servers with OTEL, Consul, and production middleware
 */

import { Hono } from 'hono';
import { serve } from 'bun';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serveStatic } from 'hono/bun';
import { initializeOpenTelemetry, shutdownOpenTelemetry } from './telemetry/otel.js';
// Auth middleware removed for benchmarking
import {
  rateLimitMiddleware,
  rateLimitByUser,
  rateLimitFileUploads,
  cleanupRateLimiter,
} from './middleware/rate-limit.js';
import {
  securityMiddleware,
  requestIdMiddleware,
  corsMiddleware,
  securityHeadersMiddleware,
  requestLoggingMiddleware,
} from './middleware/cors-security.js';
import {
  handleFileImport,
  handleBatchImport,
  handleHealthCheck,
  handleLiveness,
  handleReadiness,
  handleMetrics,
  handleConsulHealth,
  handleServiceInfo,
} from './handlers/csv-import.js';
import { createGrpcServer } from './handlers/grpc-service.js';
import { createConsulClient, buildServiceConfig } from './discovery/consul.js';
import { ERROR_CODES, REQUIRED_SCOPES } from './types.js';

// ============================================================================
// Environment Configuration
// ============================================================================

const ENV = {
  SERVICE_NAME: process.env.SERVICE_NAME || 'csv-service-hono',
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
// Create Hono App
// ============================================================================

const app = new Hono();

// ============================================================================
// Global Middleware
// ============================================================================

app.use('*', requestIdMiddleware);
app.use('*', corsMiddleware);
app.use('*', securityHeadersMiddleware);

// Request logging (only in non-test environments)
if (ENV.ENVIRONMENT !== 'test') {
  app.use('*', requestLoggingMiddleware);
}

// ============================================================================
// Public Endpoints (No Auth Required)
// ============================================================================

const publicRoutes = new Hono();

// Health checks for Kubernetes
publicRoutes.get('/health', handleHealthCheck);
publicRoutes.get('/live', handleLiveness);
publicRoutes.get('/ready', handleReadiness);

// Consul health check
publicRoutes.get('/consul/health', handleConsulHealth);

// Service info
publicRoutes.get('/', handleServiceInfo);
publicRoutes.get('/info', handleServiceInfo);

// Mount public routes
app.route('/', publicRoutes);

// ============================================================================
// Metrics Endpoint
// ============================================================================

app.get('/metrics', handleMetrics);

// ============================================================================
// API v1 Routes
// ============================================================================

const apiV1 = new Hono();

// Auth and rate limiting disabled for benchmarking

// Public info
apiV1.get('/', handleServiceInfo);

// ============================================================================
// Import Endpoints
// ============================================================================

const importRoutes = new Hono();

// File import endpoint (no auth/rate limiting for benchmarking)
importRoutes.post('/', handleFileImport);

// Batch import endpoint (no auth/rate limiting for benchmarking)
importRoutes.post('/batch', handleBatchImport);

// Mount import routes
apiV1.route('/import', importRoutes);

// ============================================================================
// Mount API v1
// ============================================================================

app.route('/api/v1', apiV1);

// ============================================================================
// Error Handling
// ============================================================================

app.onError((err, c) => {
  const requestId = c.get('requestId') || 'unknown';
  const auth = c.get('auth');

  console.error('[Error]', {
    error: err.message,
    stack: err.stack,
    requestId,
    userId: auth?.userId,
  });

  // Record error metric
  instrumentation.recordHttpRequest(
    c.req.method,
    c.req.path,
    500,
    0,
    { error_type: err.name }
  );

  return c.json({
    success: false,
    error: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: ENV.ENVIRONMENT === 'production'
        ? 'An internal error occurred'
        : err.message,
    },
    requestId,
  }, 500);
});

// 404 handler
app.notFound((c) => {
  const requestId = c.get('requestId') || 'unknown';

  return c.json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route not found: ${c.req.method} ${c.req.path}`,
    },
    requestId,
  }, 404);
});

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
    const { createConsulClient, buildServiceConfig } = await import('./discovery/consul.js');

    consulClient = createConsulClient(ENV.SERVICE_NAME, ENV.PORT, {
      enabled: true,
      host: ENV.CONSUL_HOST,
      port: ENV.CONSUL_PORT,
    });

    const serviceConfig = buildServiceConfig(
      ENV.SERVICE_NAME,
      ENV.PORT,
      'hono',
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
  }, 30000); // 30 second timeout

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
  // Don't shutdown on unhandled rejections, just log
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

  // Start HTTP server using Bun's native server
  const server = serve({
    fetch: app.fetch,
    hostname: ENV.HOST,
    port: ENV.PORT,
  });

  console.log(`[HTTP] Server listening on http://${ENV.HOST}:${ENV.PORT}`);
  console.log(`[HTTP] Environment: ${ENV.ENVIRONMENT}`);
  console.log(`[HTTP] Framework: Hono (Bun runtime)`);
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
}

// Start the service
start().catch((error) => {
  console.error('[Startup] Failed to start service:', error);
  process.exit(1);
});

// Export for testing (no default export to avoid Bun's auto-server detection)
export { app, ENV, instrumentation };
