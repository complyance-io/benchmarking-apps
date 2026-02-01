/**
 * Authentication & Authorization Middleware
 * JWT validation with RBAC support
 */

import type { Context, Next } from 'hono';
import { jwt, sign } from 'hono/jwt';
import type { JwtPayload, AuthContext, REQUIRED_SCOPES } from '../types.js';

// Configuration
const AUTH_CONFIG = {
  secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  issuer: process.env.JWT_ISSUER || 'csv-service',
  audience: process.env.JWT_AUDIENCE || 'csv-api',
  tokenExpiry: process.env.JWT_TOKEN_EXPIRY || '1h',
};

// Token extraction patterns
const BEARER_TOKEN_PATTERN = /^Bearer\s+(.+)$/i;

/**
 * Extract JWT token from Authorization header
 */
export function extractToken(authHeader: string | null): string | null {
  if (!authHeader) return null;

  const match = authHeader.match(BEARER_TOKEN_PATTERN);
  return match ? match[1] : null;
}

/**
 * Verify JWT token and return payload
 */
export async function verifyToken(token: string): Promise<JwtPayload> {
  const { jwt: jwtVerify } = await import('jose');

  try {
    const secretKey = new TextEncoder().encode(AUTH_CONFIG.secret);
    const { payload } = await jwtVerify.jwtVerify(token, secretKey, {
      issuer: AUTH_CONFIG.issuer,
      audience: AUTH_CONFIG.audience,
    });

    return payload as unknown as JwtPayload;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('expired')) {
        throw new Error('Token expired');
      }
      if (error.message.includes('signature')) {
        throw new Error('Invalid token signature');
      }
    }
    throw new Error('Token verification failed');
  }
}

/**
 * Create signed JWT token
 */
export async function createToken(payload: Record<string, unknown>): Promise<string> {
  const { jwt: jwtSign } = await import('jose');

  const secretKey = new TextEncoder().encode(AUTH_CONFIG.secret);
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + (60 * 60), // 1 hour default
    iss: AUTH_CONFIG.issuer,
    aud: AUTH_CONFIG.audience,
  };

  const token = await jwtSign.jwtSign(fullPayload, secretKey);
  return token;
}

/**
 * Hono JWT middleware with RBAC support
 */
export const authMiddleware = jwt({
  secret: AUTH_CONFIG.secret,
  alg: 'HS256',
  issuer: AUTH_CONFIG.issuer,
  audience: AUTH_CONFIG.audience,
});

/**
 * Enhanced authentication middleware that sets auth context
 */
export async function authenticationMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  const token = extractToken(authHeader);

  // Set anonymous context if no token
  if (!token) {
    c.set('auth', {
      isAuthenticated: false,
      userId: 'anonymous',
      scopes: [],
    } as AuthContext);
    return next();
  }

  try {
    const payload = await verifyToken(token);

    const authContext: AuthContext = {
      isAuthenticated: true,
      userId: payload.sub || 'unknown',
      tenantId: payload.tenant_id,
      scopes: payload.scopes || [],
    };

    c.set('auth', authContext);
    c.set('jwtPayload', payload);

    return next();
  } catch (error) {
    return c.json({
      error: 'Authentication failed',
      message: error instanceof Error ? error.message : 'Invalid token',
      code: 'AUTHENTICATION_ERROR',
    }, 401);
  }
}

/**
 * Authorization middleware - check required scopes
 */
export function requireScopes(...requiredScopes: string[]) {
  return async (c: Context, next: Next) => {
    const auth = c.get('auth') as AuthContext | undefined;

    if (!auth || !auth.isAuthenticated) {
      return c.json({
        error: 'Authentication required',
        code: 'AUTHENTICATION_ERROR',
      }, 401);
    }

    const userScopes = auth.scopes || [];
    const hasAllScopes = requiredScopes.every(scope => userScopes.includes(scope));

    if (!hasAllScopes) {
      return c.json({
        error: 'Insufficient permissions',
        code: 'AUTHORIZATION_ERROR',
        required: requiredScopes,
        message: `Missing required scopes: ${requiredScopes.join(', ')}`,
      }, 403);
    }

    return next();
  };
}

/**
 * Check if user has specific scope
 */
export function hasScope(auth: AuthContext | undefined, scope: string): boolean {
  return auth?.scopes?.includes(scope) ?? false;
}

/**
 * Check if user has any of the specified scopes
 */
export function hasAnyScope(auth: AuthContext | undefined, scopes: string[]): boolean {
  if (!auth?.scopes) return false;
  return scopes.some(scope => auth.scopes.includes(scope));
}

/**
 * Admin-only middleware
 */
export const requireAdmin = requireScopes('csv:admin');

/**
 * Standard CSV processing permission middleware
 */
export const requireCsvProcess = requireScopes('csv:process');

/**
 * Read-only permission middleware
 */
export const requireCsvRead = requireScopes('csv:read');

/**
 * API Key authentication alternative (for service-to-service)
 */
export async function apiKeyMiddleware(c: Context, next: Next) {
  const apiKey = c.req.header('X-API-Key');

  if (!apiKey) {
    return c.json({
      error: 'API key required',
      code: 'AUTHENTICATION_ERROR',
    }, 401);
  }

  const validApiKeys = process.env.API_KEYS?.split(',') || [];

  if (!validApiKeys.includes(apiKey)) {
    return c.json({
      error: 'Invalid API key',
      code: 'AUTHENTICATION_ERROR',
    }, 401);
  }

  // Set service account context
  c.set('auth', {
    isAuthenticated: true,
    userId: 'service-account',
    scopes: ['csv:read', 'csv:process'], // Service accounts get full access
  } as AuthContext);

  return next();
}

/**
 * Combined auth middleware - try JWT, fall back to API key
 */
export async function combinedAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  const apiKey = c.req.header('X-API-Key');

  // Try API key first for service accounts
  if (apiKey) {
    return apiKeyMiddleware(c, next);
  }

  // Fall back to JWT
  return authenticationMiddleware(c, next);
}

/**
 * Mutual TLS authentication (for production deployments)
 */
export async function mTLSAuthMiddleware(c: Context, next: Next) {
  const clientCert = c.req.header('X-Client-Cert');

  if (!clientCert) {
    return c.json({
      error: 'Client certificate required',
      code: 'AUTHENTICATION_ERROR',
    }, 401);
  }

  // In production, validate against CA
  // For now, just check presence
  c.set('auth', {
    isAuthenticated: true,
    userId: 'mtls-client',
    scopes: ['csv:read', 'csv:process'],
  } as AuthContext);

  return next();
}

/**
 * Token refresh endpoint handler
 */
export async function handleTokenRefresh(c: Context) {
  const authHeader = c.req.header('Authorization');
  const token = extractToken(authHeader);

  if (!token) {
    return c.json({
      error: 'Refresh token required',
      code: 'AUTHENTICATION_ERROR',
    }, 401);
  }

  try {
    const payload = await verifyToken(token);

    // Create new token with updated expiration
    const newToken = await createToken({
      sub: payload.sub,
      tenant_id: payload.tenant_id,
      name: payload.name,
      email: payload.email,
      scopes: payload.scopes,
    });

    return c.json({
      token: newToken,
      expiresIn: 3600,
    });
  } catch (error) {
    return c.json({
      error: 'Invalid refresh token',
      code: 'AUTHENTICATION_ERROR',
    }, 401);
  }
}

/**
 * Get auth context from Hono context
 */
export function getAuthContext(c: Context): AuthContext {
  return c.get('auth') as AuthContext || {
    isAuthenticated: false,
    userId: 'anonymous',
    scopes: [],
  };
}

/**
 * Get user ID from auth context
 */
export function getUserId(c: Context): string {
  const auth = getAuthContext(c);
  return auth.userId || 'anonymous';
}

/**
 * Get tenant ID from auth context
 */
export function getTenantId(c: Context): string | undefined {
  const auth = getAuthContext(c);
  return auth.tenantId;
}

export { AUTH_CONFIG };
