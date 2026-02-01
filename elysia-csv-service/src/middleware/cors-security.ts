/**
 * CORS and Security Headers Middleware for Elysia
 * Production-ready security configuration
 */

import type { Elysia } from 'elysia';

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
  ];

  return directives.join('; ');
}

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

// ============================================================================
// CORS Plugin for Elysia
// ============================================================================

export const corsPlugin = () => {
  return (app: Elysia) =>
    app.onBeforeHandle(({ request, set }) => {
      const origin = request.headers.get('Origin');
      const method = request.method;
      const allowedOrigin = getAllowedOrigin(origin);

      // Handle preflight requests
      if (method === 'OPTIONS') {
        set.headers['Access-Control-Allow-Origin'] = allowedOrigin;
        set.headers['Access-Control-Allow-Methods'] = CORS_CONFIG.methods.join(', ');
        set.headers['Access-Control-Allow-Headers'] = CORS_CONFIG.headers.join(', ');
        set.headers['Access-Control-Max-Age'] = CORS_CONFIG.maxAge.toString();
        set.headers['Access-Control-Allow-Credentials'] = CORS_CONFIG.credentials.toString();
        set.headers['Access-Control-Expose-Headers'] = CORS_CONFIG.exposedHeaders.join(', ');
        set.headers['Content-Length'] = '0';
        set.status = 204;
        return;
      }

      // Handle actual requests
      set.headers['Access-Control-Allow-Origin'] = allowedOrigin;
      set.headers['Access-Control-Allow-Credentials'] = CORS_CONFIG.credentials.toString();
      set.headers['Access-Control-Expose-Headers'] = CORS_CONFIG.exposedHeaders.join(', ');

      if (origin && isOriginAllowed(origin)) {
        const vary = set.headers['Vary'];
        set.headers['Vary'] = vary ? `${vary}, Origin` : 'Origin';
      }
    });
};

// ============================================================================
// Security Headers Plugin for Elysia
// ============================================================================

export const securityHeadersPlugin = () => {
  return (app: Elysia) =>
    app.onAfterHandle(({ set }) => {
      // HTTP Strict Transport Security
      set.headers['Strict-Transport-Security'] = SECURITY_CONFIG.hsts;

      // X-Content-Type-Options
      if (SECURITY_CONFIG.nosniff) {
        set.headers['X-Content-Type-Options'] = 'nosniff';
      }

      // X-Download-Options
      if (SECURITY_CONFIG.noopen) {
        set.headers['X-Download-Options'] = 'noopen';
      }

      // X-XSS-Protection
      set.headers['X-XSS-Protection'] = SECURITY_CONFIG.xssProtection;

      // Referrer Policy
      set.headers['Referrer-Policy'] = SECURITY_CONFIG.referrerPolicy;

      // Permissions Policy
      set.headers['Permissions-Policy'] = SECURITY_CONFIG.permissionsPolicy;

      // Content Security Policy
      if (process.env.ENABLE_CSP !== 'false') {
        set.headers['Content-Security-Policy'] = buildCSPHeader();
      }

      // Server header
      set.headers['Server'] = 'CSV-Service';

      // Remove X-Powered-By
      delete set.headers['X-Powered-By'];
    });
};

// ============================================================================
// Request ID Plugin for Elysia
// ============================================================================

export const requestIdPlugin = () => {
  return (app: Elysia) =>
    app.derive(({ request, set }) => {
      const existingRequestId = request.headers.get('X-Request-ID');
      const requestId = existingRequestId || generateRequestId();

      set.headers['X-Request-ID'] = requestId;

      return {
        requestId,
        startTime: Date.now(),
      };
    });
};

// ============================================================================
// Request Logging Plugin for Elysia
// ============================================================================

export const requestLoggingPlugin = () => {
  return (app: Elysia) =>
    app.onAfterHandle(({ request, set, requestId, startTime }) => {
      const duration = Date.now() - (startTime || Date.now());
      const status = set.status || 200;

      const logEntry = {
        timestamp: new Date().toISOString(),
        request_id: requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status,
        duration_ms: duration,
        user_agent: request.headers.get('User-Agent'),
        ip: request.headers.get('X-Forwarded-For') || request.headers.get('X-Real-IP') || 'unknown',
      };

      if (status >= 500) {
        console.error(JSON.stringify({ level: 'error', ...logEntry }));
      } else if (status >= 400) {
        console.warn(JSON.stringify({ level: 'warn', ...logEntry }));
      } else {
        console.log(JSON.stringify({ level: 'info', ...logEntry }));
      }
    });
};

// ============================================================================
// Body Size Limit Plugin for Elysia
// ============================================================================

export const bodySizeLimitPlugin = (maxSize: number = 100 * 1024 * 1024) => {
  return (app: Elysia) =>
    app.onBeforeHandle(({ request, set }) => {
      const contentLength = request.headers.get('Content-Length');

      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (size > maxSize) {
          set.status = 413;
          return {
            error: 'Request body too large',
            code: 'PAYLOAD_TOO_LARGE',
            maxSize: `${maxSize / 1024 / 1024}MB`,
          };
        }
      }
    });
};

// ============================================================================
// Combined Security Plugin Bundle
// ============================================================================

export const securityPlugins = [
  requestIdPlugin(),
  corsPlugin(),
  securityHeadersPlugin(),
];

export const productionPlugins = [
  ...securityPlugins,
  requestLoggingPlugin(),
  bodySizeLimitPlugin(parseInt(process.env.MAX_BODY_SIZE || '104857600', 10)),
];

export { CORS_CONFIG, CSP_CONFIG, SECURITY_CONFIG };
