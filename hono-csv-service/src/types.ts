/**
 * Shared type definitions and Zod schemas for CSV Service
 */

import { z } from 'zod';

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Schema for file upload validation
 */
export const FileUploadSchema = z.object({
  file: z.instanceof(File)
    .refine((file) => file.size > 0, 'File cannot be empty')
    .refine((file) => file.size <= 100 * 1024 * 1024, 'File size cannot exceed 100MB')
    .refine(
      (file) => ['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(file.type),
      'Only CSV and Excel files are supported'
    ),
  metadata: z.record(z.string()).optional().default({}),
});

export type FileUploadInput = z.infer<typeof FileUploadSchema>;

/**
 * Schema for CSV row validation
 */
export const CsvRowSchema = z.object({
  id: z.string().optional(),
  region: z.string().min(1, 'Region is required'),
  country: z.string().min(1, 'Country is required'),
  amount: z.string().or(z.number()).transform((val) => typeof val === 'string' ? parseFloat(val) : val).refine((val) => !isNaN(val), 'Amount must be a valid number'),
  date: z.string().optional(),
  category: z.string().optional(),
});

export type CsvRow = z.infer<typeof CsvRowSchema>;

/**
 * Schema for region summary aggregation
 */
export const RegionSummarySchema = z.object({
  region: z.string(),
  country: z.string(),
  count: z.number().int().nonnegative(),
  amountSum: z.number().nonnegative(),
  amountAvg: z.number().nonnegative(),
});

export type RegionSummary = z.infer<typeof RegionSummarySchema>;

/**
 * Schema for processing result
 */
export const ProcessingResultSchema = z.object({
  rowCount: z.number().int().nonnegative(),
  successCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  summaries: z.array(RegionSummarySchema),
  stats: z.object({
    parseDurationMs: z.number().nonnegative(),
    validateDurationMs: z.number().nonnegative(),
    aggregateDurationMs: z.number().nonnegative(),
    totalDurationMs: z.number().nonnegative(),
  }),
  requestId: z.string(),
  fileName: z.string(),
  fileType: z.string(),
});

export type ProcessingResult = z.infer<typeof ProcessingResultSchema>;

/**
 * Schema for health check response
 */
export const HealthCheckResponseSchema = z.object({
  status: z.enum(['healthy', 'unhealthy', 'degraded']),
  version: z.string(),
  uptime: z.number(),
  timestamp: z.string(),
  checks: z.record(z.object({
    status: z.enum(['pass', 'fail', 'warn']),
    message: z.string().optional(),
    duration: z.number().optional(),
  })),
});

export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;

/**
 * Schema for gRPC ProcessFileRequest
 */
export const GrpcProcessFileRequestSchema = z.object({
  fileData: z.instanceof(Buffer),
  fileType: z.enum(['csv', 'xlsx']),
  fileName: z.string(),
  metadata: z.record(z.string()).optional(),
});

export type GrpcProcessFileRequest = z.infer<typeof GrpcProcessFileRequestSchema>;

/**
 * Schema for JWT payload
 */
export const JwtPayloadSchema = z.object({
  sub: z.string(), // user ID
  tenant_id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  scopes: z.array(z.string()).default([]),
  exp: z.number(),
  iat: z.number(),
  iss: z.string(),
  aud: z.string().optional(),
});

export type JwtPayload = z.infer<typeof JwtPayloadSchema>;

/**
 * Schema for rate limit configuration
 */
export const RateLimitConfigSchema = z.object({
  windowMs: z.number().default(60000), // 1 minute
  maxRequests: z.number().default(100),
  keyGenerator: z.function().returns(z.string()).optional(),
  skipSuccessfulRequests: z.boolean().default(false),
  skipFailedRequests: z.boolean().default(false),
});

export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;

/**
 * Schema for Consul service registration
 */
export const ConsulServiceConfigSchema = z.object({
  name: z.string(),
  tags: z.array(z.string()),
  port: z.number().int().positive(),
  address: z.string().optional(),
  check: z.object({
    http: z.string().optional(),
    grpc: z.string().optional(),
    interval: z.string().default('10s'),
    timeout: z.string().default('5s'),
    deregisterCriticalServiceAfter: z.string().default('30s'),
  }),
  meta: z.record(z.string()).optional(),
});

export type ConsulServiceConfig = z.infer<typeof ConsulServiceConfigSchema>;

// ============================================================================
// TypeScript Interfaces
// ============================================================================

/**
 * Authentication context attached to requests
 */
export interface AuthContext {
  userId: string;
  tenantId?: string;
  scopes: string[];
  isAuthenticated: boolean;
}

/**
 * Extended request context with auth and telemetry
 */
export interface RequestContext {
  requestId: string;
  auth?: AuthContext;
  startTime: number;
  traceId?: string;
}

/**
 * Error types
 */
export class CsvProcessingError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CsvProcessingError';
  }
}

export class ValidationError extends CsvProcessingError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_ERROR', 400, details);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends CsvProcessingError {
  constructor(message: string = 'Authentication failed') {
    super(message, 'AUTHENTICATION_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends CsvProcessingError {
  constructor(message: string = 'Insufficient permissions') {
    super(message, 'AUTHORIZATION_ERROR', 403);
    this.name = 'AuthorizationError';
  }
}

export class RateLimitError extends CsvProcessingError {
  constructor(message: string = 'Rate limit exceeded', public retryAfter?: number) {
    super(message, 'RATE_LIMIT_ERROR', 429);
    this.name = 'RateLimitError';
  }
}

export class ServiceUnavailableError extends CsvProcessingError {
  constructor(message: string = 'Service temporarily unavailable') {
    super(message, 'SERVICE_UNAVAILABLE', 503);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * Parsed file result
 */
export interface ParsedFileResult {
  rows: unknown[];
  headers: string[];
  rowCount: number;
  fileName: string;
  fileType: string;
}

/**
 * Aggregated summary by region
 */
export interface AggregatedSummary {
  region: string;
  country: string;
  count: number;
  amountSum: number;
  amountAvg: number;
}

/**
 * Processing statistics
 */
export interface ProcessingStats {
  parseDurationMs: number;
  validateDurationMs: number;
  aggregateDurationMs: number;
  totalDurationMs: number;
}

/**
 * Environment configuration
 */
export interface EnvConfig {
  // Service
  SERVICE_NAME: string;
  SERVICE_VERSION: string;
  ENVIRONMENT: string;
  PORT: number;
  GRPC_PORT: number;

  // Auth
  JWT_SECRET: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE?: string;

  // OTEL
  OTEL_ENABLED: boolean;
  OTEL_COLLECTOR_ENDPOINT: string;
  OTEL_TRACE_SAMPLE_RATIO: number;

  // Consul
  CONSUL_ENABLED: boolean;
  CONSUL_HOST: string;
  CONSUL_PORT: number;
  CONSUL_TOKEN?: string;

  // Redis (for rate limiting)
  REDIS_ENABLED: boolean;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  REDIS_DB: number;

  // Processing
  MAX_FILE_SIZE: number;
  MAX_ROWS_PER_FILE: number;
  PROCESSING_TIMEOUT_MS: number;

  // CORS
  CORS_ORIGINS: string[];
  CORS_CREDENTIALS: boolean;
}

/**
 * Health check status
 */
export enum HealthStatus {
  Healthy = 'healthy',
  Unhealthy = 'unhealthy',
  Degraded = 'degraded',
}

/**
 * Individual health check result
 */
export interface HealthCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message?: string;
  duration?: number;
  dependencies?: string[];
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Make specific properties optional
 */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Async function type
 */
export type AsyncFn<TArgs = unknown, TReturn = unknown> = (...args: TArgs[]) => Promise<TReturn>;

/**
 * Circuit breaker states
 */
export enum CircuitBreakerState {
  Closed = 'closed',
  Open = 'open',
  HalfOpen = 'half-open',
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  monitoringPeriod: number;
  halfOpenMaxCalls: number;
}

/**
 * Retry configuration
 */
export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

// ============================================================================
// Constants
// ============================================================================

export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  INVALID_FILE_TYPE: 'INVALID_FILE_TYPE',
  PARSE_ERROR: 'PARSE_ERROR',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export const REQUIRED_SCOPES = {
  CSV_READ: 'csv:read',
  CSV_PROCESS: 'csv:process',
  CSV_WRITE: 'csv:write',
  CSV_ADMIN: 'csv:admin',
} as const;

export const METADATA_KEYS = {
  USER_ID: 'user_id',
  TENANT_ID: 'tenant_id',
  REQUEST_ID: 'request_id',
  FILE_NAME: 'file_name',
  FILE_TYPE: 'file_type',
  TRACE_ID: 'trace_id',
} as const;
