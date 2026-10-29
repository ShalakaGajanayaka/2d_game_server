import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RedisService } from './redis/redis.service';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redisService: RedisService,
  ) {}

  getHello(): string {
    return 'SkyRush Game Server v2.0 - Operating Normally';
  }

  async getHealthDiagnostics() {
    const startedAt = Date.now();

    // 1. PostgreSQL Database Diagnostics & Latency
    let pgStatus = 'disconnected';
    let pgLatencyMs = -1;
    let poolStats: any = null;
    try {
      const pgStart = Date.now();
      await this.dataSource.query('SELECT 1');
      pgLatencyMs = Date.now() - pgStart;
      pgStatus = 'connected';

      const master = (this.dataSource.driver as any)?.master;
      if (master) {
        poolStats = {
          totalCount: master.totalCount ?? 0,
          idleCount: master.idleCount ?? 0,
          waitingCount: master.waitingCount ?? 0,
        };
      }
    } catch (err: any) {
      this.logger.error('PostgreSQL health check probe failed', err);
      pgStatus = 'error: connection_failed';
    }

    // 2. Redis Key-Value Store Diagnostics & Latency
    let redisStatus = 'disconnected';
    let redisLatencyMs = -1;
    try {
      const redisStart = Date.now();
      await this.redisService.ping();
      redisLatencyMs = Date.now() - redisStart;
      redisStatus = 'connected';
    } catch (err: any) {
      this.logger.error('Redis health check probe failed', err);
      redisStatus = 'error: connection_failed';
    }

    const isHealthy = pgStatus === 'connected' && redisStatus === 'connected';

    return {
      status: isHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      diagnostics: {
        totalDurationMs: Date.now() - startedAt,
        postgres: {
          status: pgStatus,
          latencyMs: pgLatencyMs,
          pool: poolStats,
        },
        redis: {
          status: redisStatus,
          latencyMs: redisLatencyMs,
        },
      },
    };
  }
}
