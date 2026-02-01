/**
 * Consul Service Discovery Client
 * Handles service registration, health checks, and KV configuration
 */

import Consul from 'consul';
import type { ConsulServiceConfig, HealthCheckResponse, HealthStatus } from '../types.js';

// ============================================================================
// Configuration
// ============================================================================

const CONSUL_CONFIG = {
  enabled: process.env.CONSUL_ENABLED === 'true',
  host: process.env.CONSUL_HOST || 'localhost',
  port: parseInt(process.env.CONSUL_PORT || '8500', 10),
  token: process.env.CONSUL_TOKEN,
  scheme: process.env.CONSUL_SCHEME || 'http',
  dc: process.env.CONSUL_DATACENTER,
  defaults: {
    timeout: 5000,
  },
};

// ============================================================================
// Consul Client Class
// ============================================================================

export class ConsulClient {
  private consul: Consul.Consul | null = null;
  private serviceId: string;
  private serviceName: string;
  private config: typeof CONSUL_CONFIG;
  private registered = false;
  private checkInterval?: NodeJS.Timeout;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  constructor(serviceName: string, servicePort: number, config?: Partial<typeof CONSUL_CONFIG>) {
    this.serviceName = serviceName;
    this.config = { ...CONSUL_CONFIG, ...config };
    this.serviceId = `${serviceName}-${process.env.HOSTNAME || 'local'}-${servicePort}`;

    if (this.config.enabled) {
      this.initialize();
    }
  }

  /**
   * Initialize Consul connection
   */
  private initialize(): void {
    try {
      this.consul = new Consul({
        host: this.config.host,
        port: this.config.port,
        token: this.config.token,
        scheme: this.config.scheme,
        dc: this.config.dc,
        defaults: this.config.defaults,
      });

      console.log(`Consul client initialized: ${this.config.scheme}://${this.config.host}:${this.config.port}`);

      // Test connection
      this.consul.status.leader((err, leader) => {
        if (err) {
          console.error('Consul connection test failed:', err.message);
          this.handleConnectionError(err);
        } else {
          console.log('Consul connection OK, leader:', leader);
          this.reconnectAttempts = 0;
        }
      });
    } catch (error) {
      console.error('Failed to initialize Consul:', error);
      this.handleConnectionError(error as Error);
    }
  }

  /**
   * Handle connection errors with exponential backoff
   */
  private handleConnectionError(error: Error): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

      console.log(`Reconnecting to Consul in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

      setTimeout(() => {
        this.initialize();
      }, delay);
    } else {
      console.error('Max Consul reconnection attempts reached. Service discovery disabled.');
    }
  }

  /**
   * Register service with Consul
   */
  async registerService(config: ConsulServiceConfig): Promise<boolean> {
    if (!this.config.enabled || !this.consul) {
      console.log('Consul disabled, skipping service registration');
      return false;
    }

    try {
      const serviceConfig: Consul.Agent.Service.RegisterOptions = {
        id: this.serviceId,
        name: config.name,
        tags: config.tags,
        port: config.port,
        address: config.address,
        meta: config.meta,
        check: config.check,
      };

      await this.consul.agent.service.register(serviceConfig);
      this.registered = true;

      console.log(`Service registered with Consul: ${this.serviceId}`);

      // Start periodic KV refresh if configured
      this.startKvRefresh();

      return true;
    } catch (error) {
      console.error('Failed to register service with Consul:', error);
      return false;
    }
  }

  /**
   * Deregister service from Consul
   */
  async deregisterService(): Promise<boolean> {
    if (!this.registered || !this.consul) {
      return false;
    }

    try {
      await this.consul.agent.service.deregister(this.serviceId);
      this.registered = false;

      if (this.checkInterval) {
        clearInterval(this.checkInterval);
      }

      console.log(`Service deregistered from Consul: ${this.serviceId}`);
      return true;
    } catch (error) {
      console.error('Failed to deregister service:', error);
      return false;
    }
  }

  /**
   * Get service instance from Consul
   */
  async getService(serviceName: string): Promise<Consul.Agent.Service | null> {
    if (!this.config.enabled || !this.consul) {
      return null;
    }

    try {
      const services = await this.consul.health.service(serviceName);

      if (services.length === 0) {
        return null;
      }

      // Filter only passing services
      const passingServices = services.filter(s => s.Checks.every(c => c.Status === 'passing'));

      if (passingServices.length === 0) {
        return null;
      }

      // Return a random healthy instance for load balancing
      const index = Math.floor(Math.random() * passingServices.length);
      const service = passingServices[index];

      return service.Service;
    } catch (error) {
      console.error(`Failed to get service ${serviceName}:`, error);
      return null;
    }
  }

  /**
   * Get all service instances
   */
  async getAllServices(serviceName: string): Promise<Consul.Agent.Service[]> {
    if (!this.config.enabled || !this.consul) {
      return [];
    }

    try {
      const result = await this.consul.health.service(serviceName);
      return result
        .filter(r => r.Checks.every(c => c.Status === 'passing'))
        .map(r => r.Service);
    } catch (error) {
      console.error(`Failed to get services ${serviceName}:`, error);
      return [];
    }
  }

  /**
   * Get KV value from Consul
   */
  async getKV(key: string): Promise<string | null> {
    if (!this.config.enabled || !this.consul) {
      return null;
    }

    try {
      const result = await this.consul.kv.get<{ Value: string }>(key);

      if (!result) {
        return null;
      }

      // Value is base64 encoded
      return Buffer.from(result.Value, 'base64').toString('utf-8');
    } catch (error) {
      console.error(`Failed to get KV ${key}:`, error);
      return null;
    }
  }

  /**
   * Set KV value in Consul
   */
  async setKV(key: string, value: string): Promise<boolean> {
    if (!this.config.enabled || !this.consul) {
      return false;
    }

    try {
      await this.consul.kv.set(key, Buffer.from(value).toString('base64'));
      return true;
    } catch (error) {
      console.error(`Failed to set KV ${key}:`, error);
      return false;
    }
  }

  /**
   * Get all KV values for a service
   */
  async getServiceKvConfig(serviceName: string, env: string = 'development'): Promise<Record<string, string>> {
    const config: Record<string, string> = {};
    const basePath = `/config/${serviceName}/${env}`;

    if (!this.config.enabled || !this.consul) {
      return config;
    }

    try {
      const keys = await this.consul.kv.keys(`${basePath}/`);

      if (!keys) {
        return config;
      }

      for (const key of keys) {
        const value = await this.getKV(key);
        if (value !== null) {
          const shortKey = key.replace(basePath + '/', '');
          config[shortKey] = value;
        }
      }
    } catch (error) {
      console.error('Failed to get service KV config:', error);
    }

    return config;
  }

  /**
   * Watch for KV changes
   */
  async watchKV(key: string, callback: (value: string | null) => void): Promise<() => void> {
    if (!this.config.enabled || !this.consul) {
      return () => {};
    }

    const options = { method: 'watch' as const, wait: '30s' };

    let watching = true;

    const watch = async () => {
      while (watching) {
        try {
          const result = await this.consul!.kv.get<{ Value: string }>(key, options);

          if (result) {
            const value = Buffer.from(result.Value, 'base64').toString('utf-8');
            callback(value);
          } else {
            callback(null);
          }
        } catch (error) {
          console.error(`KV watch error for ${key}:`, error);
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    };

    watch().catch(console.error);

    return () => {
      watching = false;
    };
  }

  /**
   * Start periodic KV refresh
   */
  private startKvRefresh(): void {
    this.checkInterval = setInterval(async () => {
      // Update TTL check if configured
      if (!this.consul || !this.registered) return;

      try {
        await this.consul.agent.check.pass({
          id: `${this.serviceId}:ttl`,
        });
      } catch (error) {
        // Check might not be a TTL check, ignore error
      }
    }, 5000); // Update every 5 seconds
  }

  /**
   * Get service health status
   */
  async getHealthStatus(): Promise<HealthStatus> {
    if (!this.config.enabled) {
      return HealthStatus.Healthy;
    }

    try {
      const checks = await this.consul!.agent.checks();

      // Find our service's checks
      const serviceChecks = Object.values(checks).filter(
        c => c.ServiceID === this.serviceId
      );

      const hasPassing = serviceChecks.some(c => c.Status === 'passing');
      const hasCritical = serviceChecks.some(c => c.Status === 'critical');

      if (hasCritical) {
        return HealthStatus.Unhealthy;
      }

      if (hasPassing) {
        return HealthStatus.Healthy;
      }

      return HealthStatus.Degraded;
    } catch (error) {
      console.error('Failed to get health status:', error);
      return HealthStatus.Unhealthy;
    }
  }

  /**
   * Create session for distributed locking
   */
  async createSession(ttl: string = '30s'): Promise<string | null> {
    if (!this.config.enabled || !this.consul) {
      return null;
    }

    try {
      const session = await this.consul.session.create({
        ttl,
        behavior: 'delete',
      });

      return session;
    } catch (error) {
      console.error('Failed to create session:', error);
      return null;
    }
  }

  /**
   * Acquire lock
   */
  async acquireLock(key: string, sessionId: string): Promise<boolean> {
    if (!this.config.enabled || !this.consul) {
      return true; // Lock disabled, allow operation
    }

    try {
      const acquired = await this.consul.lock.acquire(key, sessionId);
      return acquired;
    } catch (error) {
      console.error('Failed to acquire lock:', error);
      return false;
    }
  }

  /**
   * Release lock
   */
  async releaseLock(key: string, sessionId: string): Promise<boolean> {
    if (!this.config.enabled || !this.consul) {
      return true;
    }

    try {
      await this.consul.lock.release(key, sessionId);
      return true;
    } catch (error) {
      console.error('Failed to release lock:', error);
      return false;
    }
  }

  /**
   * Close Consul connection
   */
  async close(): Promise<void> {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
    }

    if (this.registered) {
      await this.deregisterService();
    }
  }

  /**
   * Check if connected to Consul
   */
  isConnected(): boolean {
    return this.consul !== null;
  }

  /**
   * Check if service is registered
   */
  isServiceRegistered(): boolean {
    return this.registered;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Create Consul client for service
 */
export function createConsulClient(
  serviceName: string,
  servicePort: number,
  config?: Partial<typeof CONSUL_CONFIG>
): ConsulClient {
  return new ConsulClient(serviceName, servicePort, config);
}

/**
 * Build service configuration for registration
 */
export function buildServiceConfig(
  serviceName: string,
  port: number,
  framework: 'hono' | 'elysia',
  options?: {
    address?: string;
    healthCheckPath?: string;
    tags?: string[];
  }
): ConsulServiceConfig {
  const frameworkLower = framework;

  return {
    name: serviceName,
    port,
    address: options?.address,
    tags: [
      `version=${process.env.SERVICE_VERSION || '1.0.0'}`,
      `runtime=bun`,
      `framework=${frameworkLower}`,
      ...(options?.tags || []),
    ],
    check: {
      http: `http://${options?.address || 'localhost'}:${port}${options?.healthCheckPath || '/health'}`,
      interval: '10s',
      timeout: '5s',
      deregisterCriticalServiceAfter: '30s',
    },
    meta: {
      environment: process.env.NODE_ENV || 'development',
      version: process.env.SERVICE_VERSION || '1.0.0',
      framework: frameworkLower,
    },
  };
}

/**
 * Get configuration from Consul KV or fall back to environment variable
 */
export async function getConfigFromConsul(
  consul: ConsulClient,
  key: string,
  envVar?: string,
  defaultValue?: string
): Promise<string> {
  // Try Consul first
  const kvValue = await consul.getKV(key);
  if (kvValue !== null) {
    return kvValue;
  }

  // Fall back to environment variable
  if (envVar && process.env[envVar]) {
    return process.env[envVar]!;
  }

  // Fall back to default
  if (defaultValue !== undefined) {
    return defaultValue;
  }

  throw new Error(`Configuration not found: ${key} (env: ${envVar})`);
}

export { CONSUL_CONFIG };
