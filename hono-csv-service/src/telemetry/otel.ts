/**
 * OpenTelemetry Setup for CSV Service
 * Provides comprehensive tracing, metrics, and instrumentation
 */

import {
  trace,
  metrics,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
} from '@opentelemetry/api';
import {
  NodeTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
} from '@opentelemetry/sdk-metrics';
import {
  Resource,
  detectResources,
  processDetectorSync,
} from '@opentelemetry/resources';
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import type { Span, Metrics, HrTime } from '@opentelemetry/api';

// Configuration
const OTEL_CONFIG = {
  enabled: process.env.OTEL_ENABLED === 'false' ? false : true,
  collectorEndpoint: process.env.OTEL_COLLECTOR_ENDPOINT || 'http://otel-collector:4318',
  serviceName: process.env.OTEL_SERVICE_NAME || 'csv-service-hono',
  serviceVersion: process.env.OTEL_SERVICE_VERSION || '1.0.0',
  environment: process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'development',
  traceSampleRatio: parseFloat(process.env.OTEL_TRACE_SAMPLE_RATIO || '1.0'),
  metricsExportInterval: parseInt(process.env.OTEL_METRICS_EXPORT_INTERVAL || '60000', 10),
};

// Logger for diagnostics
if (process.env.OTEL_DEBUG === 'true') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

/**
 * Custom CSV Processing Instrumentation
 * Creates spans for CSV operations
 */
export class CSVInstrumentation {
  private tracer = trace.getTracer(OTEL_CONFIG.serviceName, OTEL_CONFIG.serviceVersion);
  private meter = metrics.getMeter(OTEL_CONFIG.serviceName, OTEL_CONFIG.serviceVersion);

  // Metrics
  private httpRequestsTotal = this.meter.createCounter('http_requests_total', {
    description: 'Total number of HTTP requests',
  });

  private httpRequestDuration = this.meter.createHistogram('http_request_duration_ms', {
    description: 'HTTP request duration in milliseconds',
    unit: 'ms',
  });

  private csvRowsProcessed = this.meter.createCounter('csv_rows_processed_total', {
    description: 'Total number of CSV rows processed',
  });

  private csvProcessingDuration = this.meter.createHistogram('csv_processing_duration_ms', {
    description: 'CSV processing duration in milliseconds',
    unit: 'ms',
  });

  private csvValidationErrors = this.meter.createCounter('csv_validation_errors_total', {
    description: 'Total number of CSV validation errors',
  });

  private grpcRequestsTotal = this.meter.createCounter('grpc_requests_total', {
    description: 'Total number of gRPC requests',
  });

  private grpcRequestDuration = this.meter.createHistogram('grpc_request_duration_ms', {
    description: 'gRPC request duration in milliseconds',
    unit: 'ms',
  });

  private activeRequests = this.meter.createUpDownCounter('http_active_requests', {
    description: 'Number of active HTTP requests',
  });

  // Gauge for memory usage
  private memoryUsage = this.meter.createObservableGauge('process_memory_bytes', {
    description: 'Process memory usage in bytes',
  });

  constructor() {
    this.setupMemoryGauge();
  }

  private setupMemoryGauge() {
    this.memoryUsage.addCallback((observableResult) => {
      const usage = process.memoryUsage();
      observableResult.observe(usage.heapUsed, { type: 'heap' });
      observableResult.observe(usage.external, { type: 'external' });
      observableResult.observe(usage.rss, { type: 'rss' });
    });
  }

  /**
   * Record HTTP request metrics
   */
  recordHttpRequest(method: string, route: string, statusCode: number, duration: number, attributes: Record<string, string> = {}) {
    this.httpRequestsTotal.add(
      1,
      {
        method,
        route,
        status_code: statusCode.toString(),
        ...attributes,
      }
    );

    this.httpRequestDuration.record(
      duration,
      {
        method,
        route,
        status_code: statusCode.toString(),
        ...attributes,
      }
    );
  }

  /**
   * Record gRPC request metrics
   */
  recordGrpcRequest(method: string, status: string, duration: number, attributes: Record<string, string> = {}) {
    this.grpcRequestsTotal.add(
      1,
      {
        method,
        status,
        ...attributes,
      }
    );

    this.grpcRequestDuration.record(
      duration,
      {
        method,
        status,
        ...attributes,
      }
    );
  }

  /**
   * Increment active requests counter
   */
  incrementActiveRequests(attributes: Record<string, string> = {}) {
    this.activeRequests.add(1, attributes);
  }

  /**
   * Decrement active requests counter
   */
  decrementActiveRequests(attributes: Record<string, string> = {}) {
    this.activeRequests.add(-1, attributes);
  }

  /**
   * Record CSV processing metrics
   */
  recordCsvProcessing(rowCount: number, duration: number, errorCount: number = 0, attributes: Record<string, string> = {}) {
    this.csvRowsProcessed.add(rowCount, attributes);
    this.csvProcessingDuration.record(duration, attributes);

    if (errorCount > 0) {
      this.csvValidationErrors.add(errorCount, attributes);
    }
  }

  /**
   * Create a span for CSV parsing
   */
  async withCsvParseSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes: Record<string, string> = {}
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      `csv.parse`,
      { attributes: { operation: 'parse', ...attributes } },
      async (span) => {
        try {
          const result = await fn(span);
          span.setStatus({ code: 1 }); // OK
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: 2, message: (error as Error).message }); // ERROR
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Create a span for CSV validation
   */
  async withCsvValidateSpan<T>(
    fn: (span: Span) => Promise<T>,
    attributes: Record<string, string> = {}
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      `csv.validate`,
      { attributes: { operation: 'validate', ...attributes } },
      async (span) => {
        try {
          const result = await fn(span);
          span.setAttribute('validation.errors', 0);
          span.setStatus({ code: 1 });
          return result;
        } catch (error) {
          const errorCount = (error as any).errorCount || 1;
          span.setAttribute('validation.errors', errorCount);
          span.recordException(error as Error);
          span.setStatus({ code: 2, message: (error as Error).message });
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Create a span for CSV aggregation
   */
  async withCsvAggregateSpan<T>(
    fn: (span: Span) => Promise<T>,
    attributes: Record<string, string> = {}
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      `csv.aggregate`,
      { attributes: { operation: 'aggregate', ...attributes } },
      async (span) => {
        try {
          const result = await fn(span);
          span.setStatus({ code: 1 });
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: 2, message: (error as Error).message });
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Create a span for file processing
   */
  async withFileProcessSpan<T>(
    fileName: string,
    fileType: string,
    fn: (span: Span) => Promise<T>,
    attributes: Record<string, string> = {}
  ): Promise<T> {
    return this.tracer.startActiveSpan(
      'file.process',
      {
        attributes: {
          'file.name': fileName,
          'file.type': fileType,
          ...attributes,
        },
      },
      async (span) => {
        try {
          const result = await fn(span);
          span.setStatus({ code: 1 });
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: 2, message: (error as Error).message });
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  /**
   * Get current trace ID for logging correlation
   */
  getCurrentTraceId(): string | undefined {
    const currentSpan = trace.getActiveSpan();
    if (!currentSpan) return undefined;

    const spanContext = currentSpan.spanContext();
    return spanContext.traceId;
  }

  /**
   * Inject trace context into headers for distributed tracing
   */
  injectTraceContext(headers: Record<string, string>): void {
    const currentSpan = trace.getActiveSpan();
    if (!currentSpan) return;

    this.tracer.inject(
      trace.setSpan(context.active(), currentSpan).traceContext,
      'tracecontext',
      headers
    );
  }

  /**
   * Extract trace context from headers
   */
  extractTraceContext(headers: Record<string, string>): any {
    return this.tracer.extract('tracecontext', headers);
  }
}

// Singleton instance
let csvInstrumentation: CSVInstrumentation | null = null;

/**
 * Initialize OpenTelemetry
 */
export async function initializeOpenTelemetry(): Promise<CSVInstrumentation> {
  if (csvInstrumentation) {
    return csvInstrumentation;
  }

  if (!OTEL_CONFIG.enabled) {
    console.log('OpenTelemetry disabled, creating no-op instrumentation');
    csvInstrumentation = new CSVInstrumentation();
    return csvInstrumentation;
  }

  // Create resource with service info
  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: OTEL_CONFIG.serviceName,
    [SEMRESATTRS_SERVICE_VERSION]: OTEL_CONFIG.serviceVersion,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: OTEL_CONFIG.environment,
    'runtime.name': 'bun',
    'runtime.version': process.version,
    'framework.name': OTEL_CONFIG.serviceName.includes('hono') ? 'hono' : 'elysia',
  });

  // Initialize tracer provider
  const tracerProvider = new NodeTracerProvider({
    resource,
    traceSampleRatio: OTEL_CONFIG.traceSampleRatio,
  });

  // Add OTLP trace exporter
  const traceExporter = new OTLPTraceExporter({
    url: `${OTEL_CONFIG.collectorEndpoint}/v1/traces`,
    headers: {},
  });

  tracerProvider.addSpanProcessor(new BatchSpanProcessor(traceExporter));
  tracerProvider.register();

  // Initialize meter provider
  const meterProvider = new MeterProvider({ resource });

  // Add OTLP metric exporter
  const metricExporter = new OTLPMetricExporter({
    url: `${OTEL_CONFIG.collectorEndpoint}/v1/metrics`,
    headers: {},
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: OTEL_CONFIG.metricsExportInterval,
  });

  meterProvider.addMetricReader(metricReader);
  metrics.setGlobalMeterProvider(meterProvider);

  // Register instrumentations
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        applyCustomAttributesOnSpan: (span) => {
          const attributes = trace.getActiveSpan()?.attributes;
          if (attributes) {
            span.setAttributes(attributes);
          }
        },
      }),
      new GrpcInstrumentation(),
    ],
  });

  console.log(`OpenTelemetry initialized: ${OTEL_CONFIG.serviceName} -> ${OTEL_CONFIG.collectorEndpoint}`);

  csvInstrumentation = new CSVInstrumentation();
  return csvInstrumentation;
}

/**
 * Get the CSV instrumentation instance
 */
export function getCSVInstrumentation(): CSVInstrumentation {
  if (!csvInstrumentation) {
    throw new Error('CSVInstrumentation not initialized. Call initializeOpenTelemetry() first.');
  }
  return csvInstrumentation;
}

/**
 * Shutdown OpenTelemetry gracefully
 */
export async function shutdownOpenTelemetry(): Promise<void> {
  if (!OTEL_CONFIG.enabled) {
    console.log('OpenTelemetry disabled, skipping shutdown');
    return;
  }

  const tracerProvider = trace.getTracerProvider() as NodeTracerProvider;
  const meterProvider = metrics.getMeterProvider() as MeterProvider;

  await Promise.all([
    tracerProvider.shutdown(),
    meterProvider.shutdown(),
  ]);

  console.log('OpenTelemetry shutdown complete');
}

// Export types and config
export { OTEL_CONFIG };
export type * from '@opentelemetry/api';

/**
 * Helper to create trace context middleware attributes
 */
export function createTraceAttributes(
  userId?: string,
  tenantId?: string,
  requestId?: string
): Record<string, string> {
  const attributes: Record<string, string> = {};

  if (userId) attributes['user.id'] = userId;
  if (tenantId) attributes['tenant.id'] = tenantId;
  if (requestId) attributes['request.id'] = requestId;

  return attributes;
}

/**
 * Helper to add baggage for distributed context propagation
 */
import * as context from '@opentelemetry/api';
import { propagation } from '@opentelemetry/api';

export function addBaggage(key: string, value: string): void {
  const currentContext = context.active();
  const baggage = propagation.createBaggage({ [key]: value });
  context.setBaggage(currentContext, baggage);
}

export function getBaggageValue(key: string): string | undefined {
  const baggage = propagation.getBaggage(context.active());
  return baggage?.getEntry(key)?.value;
}
