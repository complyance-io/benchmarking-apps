/**
 * Rate Limiting Middleware for Elysia
 * Supports in-memory and Redis-based rate limiting with sliding window
 */

import type { Elysia } from 'elysia';
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
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.scheduleCleanup();
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

    // Calculate reset time
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
   * Schedule periodic cleanup
   */
  private scheduleCleanup(): void {
    if (this.cleanupTimer) return;

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.windowMs);
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

  /**
   * Stop cleanup timer
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
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
   */
  async checkLimit(key: string): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    if (!this.enabled || !this.redis) {
      return inMemoryLimiter.checkLimit(key);
    }

    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const redisKey = `ratelimit:${key}`;

    try {
      await this.redis.zremrangebyscore(redisKey, 0, windowStart);
      const count = await this.redis.zcard(redisKey);

      const allowed = count < this.config.maxRequests;
      const remaining = Math.max(0, this.config.maxRequests - count);

      if (allowed) {
        await this.redis.zadd(redisKey, now, `${now}-${Math.random()}`);
        await this.redis.expire(redisKey, Math.ceil(this.config.windowMs / 1000) + 1);
      }

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
 * Rate limiting plugin for Elysia
 */
export const rateLimitPlugin = (options: Partial<RateLimitConfig> = {}) => {
  const config = { ...RATE_LIMIT_CONFIG, ...options };
  const limiter = getLimiter();

  return (app: Elysia) =>
    app.derive(async ({ request, set }) => {
      // Generate key from IP and/or user
      const forwardedFor = request.headers.get('X-Forwarded-For');
      const realIp = request.headers.get('X-Real-IP');
      const cfIp = request.headers.get('CF-Connecting-IP');

      const ip = forwardedFor?.split(',')[0].trim()
        || realIp
        || cfIp
        || 'unknown';

      // Check if authenticated via header (set by auth plugin)
      const authHeader = request.headers.get('x-auth-user-id');
      const userId = authHeader || 'anonymous';

      const key = `${ip}:${userId}`;

      const result = await limiter.checkLimit(key);

      // Set rate limit headers
      set.headers['X-RateLimit-Limit'] = config.maxRequests.toString();
      set.headers['X-RateLimit-Remaining'] = result.remaining.toString();
      set.headers['X-RateLimit-Reset'] = new Date(result.resetTime).toISOString();

      if (!result.allowed) {
        const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);
        set.headers['Retry-After'] = retryAfter.toString();
        set.status = 429;
        return {
          error: 'Rate limit exceeded',
          code: 'RATE_LIMIT_ERROR',
          message: `Too many requests. Try again in ${retryAfter} seconds.`,
          retryAfter,
        };
      }

      return {
        rateLimit: {
          limit: config.maxRequests,
          remaining: result.remaining,
          reset: result.resetTime,
        },
      };
    });
};

/**
 * Rate limiting by user ID (for authenticated requests)
 */
export const rateLimitByUser = (maxRequests: number = 100, windowMs: number = 60000) => {
  return (app: Elysia) =>
    app.derive(async ({ request, set }) => {
      const userId = request.headers.get('x-auth-user-id') || 'anonymous';
      const tenantId = request.headers.get('x-auth-tenant-id') || 'default';
      const key = `user:${tenantId}:${userId}`;

      const limiter = getLimiter();
      const result = await limiter.checkLimit(key);

      set.headers['X-RateLimit-Limit'] = maxRequests.toString();
      set.headers['X-RateLimit-Remaining'] = result.remaining.toString();
      set.headers['X-RateLimit-Reset'] = new Date(result.resetTime).toISOString();

      if (!result.allowed) {
        set.status = 429;
        return {
          error: 'Rate limit exceeded',
          code: 'RATE_LIMIT_ERROR',
        };
      }

      return {};
    });
};

/**
 * Rate limiting for file uploads (stricter limits)
 */
export const rateLimitFileUploads = (maxRequests: number = 10, windowMs: number = 60000) => {
  return (app: Elysia) =>
    app.derive(async ({ request, set }) => {
      const userId = request.headers.get('x-auth-user-id') || 'anonymous';
      const key = `upload:${userId}`;

      const customLimiter = new InMemoryRateLimiter({ maxRequests, windowMs });
      const result = await customLimiter.checkLimit(key);

      set.headers['X-RateLimit-Limit'] = maxRequests.toString();
      set.headers['X-RateLimit-Remaining'] = result.remaining.toString();

      if (!result.allowed) {
        set.status = 429;
        return {
          error: 'Upload rate limit exceeded',
          code: 'RATE_LIMIT_ERROR',
        };
      }

      return {};
    });
};

/**
 * Get rate limit statistics
 */
export function getRateLimitStats() {
  return inMemoryLimiter.getStats();
}

/**
 * Reset rate limit for a specific key
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
  inMemoryLimiter.destroy();
}

export { RATE_LIMIT_CONFIG };
