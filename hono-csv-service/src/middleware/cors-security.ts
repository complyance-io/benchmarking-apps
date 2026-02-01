/**
 * CORS and Security Headers Middleware
 * Production-ready security configuration
 */

import type { Context, Next } from 'hono';

// ============================================================================
// Configuration
// ============================================================================

const CORS_CONFIG = {
  origins: (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:3001').split(','),
  credentials: process.env.CORS_CREDENTIALS === 'true',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  headers: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-API-Key',
    'X-Request-ID',
    'X-Tenant-ID',
    'Accept',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
  ],
  exposedHeaders: [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-Request-ID',
    'X-Trace-ID',
    'Retry-After',
  ],
  maxAge: 86400, // 24 hours
};

const CSP_CONFIG = {
  defaultSrc: "'self'",
  scriptSrc: "'self' 'unsafe-inline' 'unsafe-eval'",
  styleSrc: "'self' 'unsafe-inline'",
  imgSrc: "'self' data: blob:",
  fontSrc: "'self' data:",
  connectSrc: "'self'",
  frameSrc: "'none'",
  objectSrc: "'none'",
  baseUri: "'self'",
  formAction: "'self'",
  frameAncestors: "'none'",
  upgradeInsecureRequests: process.env.NODE_ENV === 'production',
};

const SECURITY_CONFIG = {
  hsts: process.env.NODE_ENV === 'production' ? 'max-age=31536000; includeSubDomains; preload' : 'max-age=3600',
  nosniff: true,
  noopen: true,
  xssProtection: '1; mode=block',
  referrerPolicy: 'strict-origin-when-cross-origin',
  permissionsPolicy: [
    'geolocation=()',
    'microphone=()',
    'camera=()',
    'payment=()',
  ].join(', '),
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if origin is allowed
 */
function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;

  // Allow all origins in development if configured
  if (process.env.NODE_ENV === 'development' && process.env.CORS_ALLOW_ALL === 'true') {
    return true;
  }

  return CORS_CONFIG.origins.some(allowed => {
    if (allowed === '*') return true;
    if (allowed.endsWith('*')) {
      const prefix = allowed.slice(0, -1);
      return origin.startsWith(prefix);
    }
    return origin === allowed;
  });
}

/**
 * Get allowed origins for CORS headers
 */
function getAllowedOrigin(requestOrigin: string | null): string {
  if (CORS_CONFIG.origins.includes('*')) {
    return '*';
  }

  if (requestOrigin && isOriginAllowed(requestOrigin)) {
    return requestOrigin;
  }

  return CORS_CONFIG.origins[0] || '*';
}

// ============================================================================
// CORS Middleware
// ============================================================================

/**
 * Comprehensive CORS middleware for Hono
 */
export async function corsMiddleware(c: Context, next: Next) {
  const origin = c.req.header('Origin');
  const method = c.req.method;

  // Handle preflight requests
  if (method === 'OPTIONS') {
    const allowedOrigin = getAllowedOrigin(origin);

    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': CORS_CONFIG.methods.join(', '),
        'Access-Control-Allow-Headers': CORS_CONFIG.headers.join(', '),
        'Access-Control-Max-Age': CORS_CONFIG.maxAge.toString(),
        'Access-Control-Allow-Credentials': CORS_CONFIG.credentials.toString(),
        'Access-Control-Expose-Headers': CORS_CONFIG.exposedHeaders.join(', '),
        'Content-Length': '0',
        'Date': new Date().toUTCString(),
      },
    });
  }

  // Handle actual requests
  await next();

  // Add CORS headers to response
  const allowedOrigin = getAllowedOrigin(origin);
  c.header('Access-Control-Allow-Origin', allowedOrigin);
  c.header('Access-Control-Allow-Credentials', CORS_CONFIG.credentials.toString());
  c.header('Access-Control-Expose-Headers', CORS_CONFIG.exposedHeaders.join(', '));

  // Handle Vary header for proper caching
  if (origin && isOriginAllowed(origin)) {
    const existingVary = c.res.headers.get('Vary');
    c.header('Vary', existingVary ? `${existingVary}, Origin` : 'Origin');
  }
}

// ============================================================================
// Security Headers Middleware
// ============================================================================

/**
 * Build Content-Security-Policy header
 */
function buildCSPHeader(): string {
  const directives = [
    `default-src ${CSP_CONFIG.defaultSrc}`,
    `script-src ${CSP_CONFIG.scriptSrc}`,
    `style-src ${CSP_CONFIG.styleSrc}`,
    `img-src ${CSP_CONFIG.imgSrc}`,
    `font-src ${CSP_CONFIG.fontSrc}`,
    `connect-src ${CSP_CONFIG.connectSrc}`,
    `frame-src ${CSP_CONFIG.frameSrc}`,
    `object-src ${CSP_CONFIG.objectSrc}`,
    `base-uri ${CSP_CONFIG.baseUri}`,
    `form-action ${CSP_CONFIG.formAction}`,
    `frame-ancestors ${CSP_CONFIG.frameAncestors}`,
  ];

  if (CSP_CONFIG.upgradeInsecureRequests) {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

/**
 * Security headers middleware
 */
export async function securityHeadersMiddleware(c: Context, next: Next) {
  await next();

  // HTTP Strict Transport Security (HSTS)
  c.header('Strict-Transport-Security', SECURITY_CONFIG.hsts);

  // Content Type Options
  if (SECURITY_CONFIG.nosniff) {
    c.header('X-Content-Type-Options', 'nosniff');
  }

  // X-Download-Options
  if (SECURITY_CONFIG.noopen) {
    c.header('X-Download-Options', 'noopen');
  }

  // XSS Protection
  c.header('X-XSS-Protection', SECURITY_CONFIG.xssProtection);

  // Referrer Policy
  c.header('Referrer-Policy', SECURITY_CONFIG.referrerPolicy);

  // Permissions Policy
  c.header('Permissions-Policy', SECURITY_CONFIG.permissionsPolicy);

  // Content Security Policy
  if (process.env.ENABLE_CSP !== 'false') {
    c.header('Content-Security-Policy', buildCSPHeader());
  }

  // Remove X-Powered-By header (if set by framework)
  c.res.headers.delete('X-Powered-By');

  // Custom server header
  c.header('Server', 'CSV-Service');
}

// ============================================================================
// Request ID Middleware
// ============================================================================

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Request ID middleware for traceability
 */
export async function requestIdMiddleware(c: Context, next: Next) {
  const existingRequestId = c.req.header('X-Request-ID');
  const requestId = existingRequestId || generateRequestId();

  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);

  await next();
}

// ============================================================================
// Request Logging Middleware
// ============================================================================

/**
 * Structured request logging middleware
 */
export async function requestLoggingMiddleware(c: Context, next: Next) {
  const startTime = Date.now();
  const requestId = c.get('requestId') || generateRequestId();
  const auth = c.get('auth');

  // Set request context
  c.set('startTime', startTime);

  await next();

  const duration = Date.now() - startTime;
  const status = c.res.status;

  // Structured log entry
  const logEntry = {
    timestamp: new Date().toISOString(),
    request_id: requestId,
    trace_id: c.get('traceId'),
    method: c.req.method,
    path: c.req.path,
    query: c.req.query(),
    status,
    duration_ms: duration,
    user_id: auth?.userId,
    tenant_id: auth?.tenantId,
    user_agent: c.req.header('User-Agent'),
    ip: c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP') || 'unknown',
    content_length: c.req.header('Content-Length'),
  };

  // Log based on status code
  if (status >= 500) {
    console.error(JSON.stringify({ level: 'error', ...logEntry }));
  } else if (status >= 400) {
    console.warn(JSON.stringify({ level: 'warn', ...logEntry }));
  } else {
    console.log(JSON.stringify({ level: 'info', ...logEntry }));
  }
}

// ============================================================================
// Body Size Limit Middleware
// ============================================================================

/**
 * Body size limiting middleware
 */
export function bodySizeLimitMiddleware(maxSize: number = 100 * 1024 * 1024) {
  return async (c: Context, next: Next) => {
    const contentLength = c.req.header('Content-Length');

    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (size > maxSize) {
        return c.json({
          error: 'Request body too large',
          code: 'PAYLOAD_TOO_LARGE',
          maxSize: `${maxSize / 1024 / 1024}MB`,
        }, 413);
      }
    }

    await next();
  };
}

// ============================================================================
// Timeout Middleware
// ============================================================================

/**
 * Request timeout middleware
 */
export function timeoutMiddleware(timeoutMs: number = 30000) {
  return async (c: Context, next: Next) => {
    const timeout = setTimeout(() => {
      if (!c.res.finished) {
        c.json({
          error: 'Request timeout',
          code: 'REQUEST_TIMEOUT',
        }, 404); // 404 in Hono to prevent double response
      }
    }, timeoutMs);

    try {
      await next();
    } finally {
      clearTimeout(timeout);
    }
  };
}

// ============================================================================
// Compose All Security Middlewares
// ============================================================================

/**
 * Combined security middleware bundle
 */
export const securityMiddleware = [
  requestIdMiddleware,
  corsMiddleware,
  securityHeadersMiddleware,
];

/**
 * Production middleware bundle (security + logging)
 */
export const productionMiddleware = [
  ...securityMiddleware,
  requestLoggingMiddleware,
  bodySizeLimitMiddleware(parseInt(process.env.MAX_BODY_SIZE || '104857600', 10)),
];

export { CORS_CONFIG, CSP_CONFIG, SECURITY_CONFIG };
