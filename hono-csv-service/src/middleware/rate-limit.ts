/**
 * Rate Limiting Middleware
 * Supports in-memory and Redis-based rate limiting with sliding window
 */

import type { Context, Next } from 'hono';
import type { RateLimitConfig } from '../types.js';

// Configuration
const RATE_LIMIT_CONFIG: RateLimitConfig = {
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  skipSuccessfulRequests: process.env.RATE_LIMIT_SKIP_SUCCESSFUL === 'true',
  skipFailedRequests: process.env.RATE_LIMIT_SKIP_FAILED === 'true',
};

/**
 * In-memory rate limiter using sliding window
 */
class InMemoryRateLimiter {
  private requests: Map<string, number[]> = new Map();
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
    // Clean up old entries periodically
    setInterval(() => this.cleanup(), this.config.windowMs);
  }

  /**
   * Check if request should be rate limited
   */
  async checkLimit(key: string): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let timestamps = this.requests.get(key) || [];

    // Filter out old timestamps outside the window
    timestamps = timestamps.filter(ts => ts > windowStart);

    // Check if limit exceeded
    const allowed = timestamps.length < this.config.maxRequests;
    const remaining = Math.max(0, this.config.maxRequests - timestamps.length);

    // Add current request timestamp if allowed
    if (allowed) {
      timestamps.push(now);
    }

    this.requests.set(key, timestamps);

    // Calculate reset time (oldest timestamp + window)
    const resetTime = timestamps.length > 0
      ? timestamps[0] + this.config.windowMs
      : now + this.config.windowMs;

    return { allowed, remaining, resetTime };
  }

  /**
   * Reset rate limit for a key
   */
  async reset(key: string): Promise<void> {
    this.requests.delete(key);
  }

  /**
   * Clean up old entries
   */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    for (const [key, timestamps] of this.requests.entries()) {
      const validTimestamps = timestamps.filter(ts => ts > windowStart);
      if (validTimestamps.length === 0) {
        this.requests.delete(key);
      } else {
        this.requests.set(key, validTimestamps);
      }
    }
  }

  /**
   * Get current usage statistics
   */
  getStats(): { totalKeys: number; totalRequests: number } {
    let totalRequests = 0;
    for (const timestamps of this.requests.values()) {
      totalRequests += timestamps.length;
    }
    return {
      totalKeys: this.requests.size,
      totalRequests,
    };
  }
}

/**
 * Redis-based rate limiter for distributed systems
 */
class RedisRateLimiter {
  private redis: any;
  private config: RateLimitConfig;
  private enabled: boolean;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.enabled = process.env.REDIS_ENABLED === 'true';

    if (this.enabled) {
      this.initializeRedis();
    }
  }

  private async initializeRedis() {
    try {
      const Redis = await import('ioredis');
      this.redis = new Redis.default({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0', 10),
        retryStrategy: (times: number) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
      });

      this.redis.on('error', (err: Error) => {
        console.error('Redis rate limiter error:', err);
      });
    } catch (error) {
      console.error('Failed to initialize Redis rate limiter:', error);
      this.enabled = false;
    }
  }

  /**
   * Check if request should be rate limited using Redis
   * Uses sorted set for sliding window
   */
  async checkLimit(key: string): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    if (!this.enabled || !this.redis) {
      // Fallback to in-memory if Redis unavailable
      return inMemoryLimiter.checkLimit(key);
    }

    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const redisKey = `ratelimit:${key}`;

    try {
      // Remove old entries outside the window
      await this.redis.zremrangebyscore(redisKey, 0, windowStart);

      // Count current requests
      const count = await this.redis.zcard(redisKey);

      const allowed = count < this.config.maxRequests;
      const remaining = Math.max(0, this.config.maxRequests - count);

      // Add current request if allowed
      if (allowed) {
        await this.redis.zadd(redisKey, now, `${now}-${Math.random()}`);
        // Set expiration
        await this.redis.expire(redisKey, Math.ceil(this.config.windowMs / 1000) + 1);
      }

      // Get reset time (oldest entry + window)
      const oldestEntry = await this.redis.zrange(redisKey, 0, 0, 'WITHSCORES');
      const resetTime = oldestEntry.length > 0
        ? parseInt(oldestEntry[1]) + this.config.windowMs
        : now + this.config.windowMs;

      return { allowed, remaining, resetTime };
    } catch (error) {
      console.error('Redis rate limit check failed, falling back to in-memory:', error);
      return inMemoryLimiter.checkLimit(key);
    }
  }

  /**
   * Reset rate limit for a key
   */
  async reset(key: string): Promise<void> {
    if (this.enabled && this.redis) {
      await this.redis.del(`ratelimit:${key}`).catch(() => {});
    }
    inMemoryLimiter.reset(key);
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }
}

// Global instances
export const inMemoryLimiter = new InMemoryRateLimiter(RATE_LIMIT_CONFIG);
export const redisLimiter = new RedisRateLimiter(RATE_LIMIT_CONFIG);

/**
 * Get the appropriate limiter based on configuration
 */
function getLimiter() {
  return process.env.REDIS_ENABLED === 'true' ? redisLimiter : inMemoryLimiter;
}

/**
 * Default key generator using IP address
 */
export function getDefaultKey(c: Context): string {
  // Try to get real IP from headers (reverse proxy scenario)
  const forwardedFor = c.req.header('X-Forwarded-For');
  const realIp = c.req.header('X-Real-IP');
  const cfConnectingIp = c.req.header('CF-Connecting-IP');

  const ip = forwardedFor?.split(',')[0].trim()
    || realIp
    || cfConnectingIp
    || c.req.header('fly-client-ip')
    || 'unknown';

  // Also include user ID if authenticated
  const auth = c.get('auth');
  const userId = auth?.userId || 'anonymous';

  return `${ip}:${userId}`;
}

/**
 * Rate limiting middleware for Hono
 */
export function rateLimitMiddleware(options: Partial<RateLimitConfig> = {}) {
  const config = { ...RATE_LIMIT_CONFIG, ...options };
  const limiter = getLimiter();

  return async (c: Context, next: Next) => {
    const key = typeof config.keyGenerator === 'function'
      ? config.keyGenerator(c)
      : getDefaultKey(c);

    const result = await limiter.checkLimit(key);

    // Set rate limit headers
    c.header('X-RateLimit-Limit', config.maxRequests.toString());
    c.header('X-RateLimit-Remaining', result.remaining.toString());
    c.header('X-RateLimit-Reset', new Date(result.resetTime).toISOString());

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);

      return c.json({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMIT_ERROR',
        message: `Too many requests. Try again in ${retryAfter} seconds.`,
        retryAfter,
      }, 429);
    }

    // Set rate limit context for later use
    c.set('rateLimit', {
      limit: config.maxRequests,
      remaining: result.remaining,
      reset: result.resetTime,
    });

    return next();
  };
}

/**
 * Create a custom rate limiter with specific configuration
 */
export function createRateLimiter(customConfig: Partial<RateLimitConfig>) {
  const limiter = new InMemoryRateLimiter({ ...RATE_LIMIT_CONFIG, ...customConfig });

  return async (c: Context, next: Next) => {
    const key = getDefaultKey(c);
    const result = await limiter.checkLimit(key);

    c.header('X-RateLimit-Limit', customConfig.maxRequests?.toString() || RATE_LIMIT_CONFIG.maxRequests.toString());
    c.header('X-RateLimit-Remaining', result.remaining.toString());
    c.header('X-RateLimit-Reset', new Date(result.resetTime).toISOString());

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);
      return c.json({
        error: 'Rate limit exceeded',
        code: 'RATE_LIMIT_ERROR',
        retryAfter,
      }, 429);
    }

    return next();
  };
}

/**
 * Rate limiting by user ID (for authenticated requests)
 */
export function rateLimitByUser(maxRequests: number = 100, windowMs: number = 60000) {
  return rateLimitMiddleware({
    maxRequests,
    windowMs,
    keyGenerator: (c: Context) => {
      const auth = c.get('auth');
      const userId = auth?.userId || 'anonymous';
      const tenantId = auth?.tenantId || 'default';
      return `user:${tenantId}:${userId}`;
    },
  });
}

/**
 * Rate limiting by API key (for service accounts)
 */
export function rateLimitByApiKey(maxRequests: number = 1000, windowMs: number = 60000) {
  return rateLimitMiddleware({
    maxRequests,
    windowMs,
    keyGenerator: (c: Context) => {
      const apiKey = c.req.header('X-API-Key') || 'unknown';
      return `apikey:${apiKey}`;
    },
  });
}

/**
 * Rate limiting by IP address (for anonymous requests)
 */
export function rateLimitByIp(maxRequests: number = 20, windowMs: number = 60000) {
  return rateLimitMiddleware({
    maxRequests,
    windowMs,
    keyGenerator: (c: Context) => {
      const forwardedFor = c.req.header('X-Forwarded-For');
      const ip = forwardedFor?.split(',')[0].trim() || c.req.header('X-Real-IP') || 'unknown';
      return `ip:${ip}`;
    },
  });
}

/**
 * Rate limiting for file uploads (stricter limits)
 */
export function rateLimitFileUploads(maxRequests: number = 10, windowMs: number = 60000) {
  return rateLimitMiddleware({
    maxRequests,
    windowMs,
    keyGenerator: (c: Context) => {
      const auth = c.get('auth');
      const userId = auth?.userId || 'anonymous';
      return `upload:${userId}`;
    },
  });
}

/**
 * Get rate limit statistics (for monitoring)
 */
export function getRateLimitStats() {
  return inMemoryLimiter.getStats();
}

/**
 * Reset rate limit for a specific key (admin function)
 */
export async function resetRateLimit(key: string): Promise<void> {
  await inMemoryLimiter.reset(key);
  await redisLimiter.reset(key);
}

/**
 * Cleanup on shutdown
 */
export async function cleanupRateLimiter(): Promise<void> {
  await redisLimiter.close();
}

export { RATE_LIMIT_CONFIG };
