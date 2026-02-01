/**
 * Authentication & Authorization Middleware for Elysia
 * JWT validation with RBAC support
 */

import type { Elysia } from 'elysia';
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
  const { SignJWT } = await import('jose');

  const secretKey = new TextEncoder().encode(AUTH_CONFIG.secret);
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + (60 * 60), // 1 hour default
    iss: AUTH_CONFIG.issuer,
    aud: AUTH_CONFIG.audience,
  };

  const jwt = await new SignJWT(fullPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + 60 * 60)
    .sign(secretKey);

  return jwt;
}

/**
 * Type for authenticated request context
 */
export interface AuthenticatedRequest {
  auth: AuthContext;
  jwtPayload?: JwtPayload;
}

/**
 * Authentication plugin for Elysia
 */
export const authPlugin = (app: Elysia) =>
  app.derive(async ({ request, set }) => {
    const authHeader = request.headers.get('Authorization');
    const token = extractToken(authHeader);

    // Set anonymous context if no token
    if (!token) {
      return {
        auth: {
          isAuthenticated: false,
          userId: 'anonymous',
          scopes: [],
        } as AuthContext,
      };
    }

    try {
      const payload = await verifyToken(token);

      const authContext: AuthContext = {
        isAuthenticated: true,
        userId: payload.sub || 'unknown',
        tenantId: payload.tenant_id,
        scopes: payload.scopes || [],
      };

      return {
        auth: authContext,
        jwtPayload: payload,
      } as AuthenticatedRequest;
    } catch (error) {
      set.status = 401;
      return {
        error: {
          error: 'Authentication failed',
          message: error instanceof Error ? error.message : 'Invalid token',
          code: 'AUTHENTICATION_ERROR',
        },
      };
    }
  });

/**
 * Require specific scopes
 */
export function requireScopes(...requiredScopes: string[]) {
  return (app: Elysia) =>
    app.beforeHandle(({ auth, set }) => {
      if (!auth || !auth.isAuthenticated) {
        set.status = 401;
        return {
          error: 'Authentication required',
          code: 'AUTHENTICATION_ERROR',
        };
      }

      const userScopes = auth.scopes || [];
      const hasAllScopes = requiredScopes.every(scope => userScopes.includes(scope));

      if (!hasAllScopes) {
        set.status = 403;
        return {
          error: 'Insufficient permissions',
          code: 'AUTHORIZATION_ERROR',
          required: requiredScopes,
          message: `Missing required scopes: ${requiredScopes.join(', ')}`,
        };
      }
    });
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
 * Admin-only scope requirement
 */
export const requireAdmin = requireScopes('csv:admin');

/**
 * CSV processing scope requirement
 */
export const requireCsvProcess = requireScopes('csv:process');

/**
 * Read-only scope requirement
 */
export const requireCsvRead = requireScopes('csv:read');

/**
 * API Key authentication plugin (for service-to-service)
 */
export const apiKeyPlugin = (app: Elysia) =>
  app.derive(({ request, set }) => {
    const apiKey = request.headers.get('X-API-Key');

    if (!apiKey) {
      set.status = 401;
      return {
        error: 'API key required',
        code: 'AUTHENTICATION_ERROR',
      };
    }

    const validApiKeys = process.env.API_KEYS?.split(',') || [];

    if (!validApiKeys.includes(apiKey)) {
      set.status = 401;
      return {
        error: 'Invalid API key',
        code: 'AUTHENTICATION_ERROR',
      };
    }

    return {
      auth: {
        isAuthenticated: true,
        userId: 'service-account',
        scopes: ['csv:read', 'csv:process'],
      } as AuthContext,
    };
  });

/**
 * Combined auth plugin - try JWT, fall back to API key
 */
export const combinedAuthPlugin = (app: Elysia) =>
  app.derive(async ({ request, set }) => {
    const authHeader = request.headers.get('Authorization');
    const apiKey = request.headers.get('X-API-Key');

    // Try API key first for service accounts
    if (apiKey) {
      const validApiKeys = process.env.API_KEYS?.split(',') || [];

      if (validApiKeys.includes(apiKey)) {
        return {
          auth: {
            isAuthenticated: true,
            userId: 'service-account',
            scopes: ['csv:read', 'csv:process'],
          } as AuthContext,
        };
      }

      set.status = 401;
      return {
        error: 'Invalid API key',
        code: 'AUTHENTICATION_ERROR',
      };
    }

    // Fall back to JWT
    const token = extractToken(authHeader);

    if (!token) {
      return {
        auth: {
          isAuthenticated: false,
          userId: 'anonymous',
          scopes: [],
        } as AuthContext,
      };
    }

    try {
      const payload = await verifyToken(token);

      return {
        auth: {
          isAuthenticated: true,
          userId: payload.sub || 'unknown',
          tenantId: payload.tenant_id,
          scopes: payload.scopes || [],
        } as AuthContext,
        jwtPayload: payload,
      };
    } catch (error) {
      set.status = 401;
      return {
        error: 'Authentication failed',
        code: 'AUTHENTICATION_ERROR',
      };
    }
  });

export { AUTH_CONFIG };
