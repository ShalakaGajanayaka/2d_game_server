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

  async acquireLock(key: string, ttlSeconds: number = 3): Promise<boolean> {
    const result = await this.redisClient.set(key, 'locked', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    try {
      await this.redisClient.del(key);
    } catch {}
  }
}
