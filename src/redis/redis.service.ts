import { Injectable, Inject, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: Redis) {
    this.redisClient.on('connect', () => {
      this.logger.log('Connected to Redis successfully');
    });
    this.redisClient.on('error', (err) => {
      this.logger.error('Redis connection error', err);
    });
  }

  onModuleDestroy() {
    this.redisClient.disconnect();
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redisClient.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.redisClient.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    return this.redisClient.get(key);
  }

  async del(key: string): Promise<number> {
    return this.redisClient.del(key);
  }

  async keys(pattern: string): Promise<string[]> {
    return this.redisClient.keys(pattern);
  }

  async sadd(key: string, member: string): Promise<number> {
    return this.redisClient.sadd(key, member);
  }

  async srem(key: string, member: string): Promise<number> {
    return this.redisClient.srem(key, member);
  }

  async smembers(key: string): Promise<string[]> {
    return this.redisClient.smembers(key);
  }

  async mget(keys: string[]): Promise<(string | null)[]> {
    if (!keys || keys.length === 0) return [];
    return this.redisClient.mget(...keys);
  }

  async delMultiple(keys: string[]): Promise<number> {
    if (!keys || keys.length === 0) return 0;
    return this.redisClient.del(...keys);
  }

  async acquireLock(key: string, ttlSeconds: number = 3): Promise<boolean> {
    const result = await this.redisClient.set(key, 'locked', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async acquireTokenLock(key: string, ttlSeconds: number = 3): Promise<string | null> {
    const token = `${Date.now()}_${Math.random().toString(36).substring(2, 12)}`;
    const result = await this.redisClient.set(key, token, 'EX', ttlSeconds, 'NX');
    return result === 'OK' ? token : null;
  }

  async releaseLock(key: string, token?: string): Promise<void> {
    try {
      if (token) {
        // Atomic compare-and-delete Lua script prevents deleting another worker's acquired lock
        const luaScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("del", KEYS[1])
          else
            return 0
          end
        `;
        await this.redisClient.eval(luaScript, 1, key, token);
      } else {
        await this.redisClient.del(key);
      }
    } catch (err) {
      this.logger.error(`Error releasing lock for key: ${key}`, err);
    }
  }
}
