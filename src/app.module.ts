import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { SanitizeInterceptor } from './common/sanitize.interceptor';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { RedisModule } from './redis/redis.module';
import { GameModule } from './game/game.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { User } from './auth/entities/user.entity';
import { Transaction } from './auth/entities/transaction.entity';
import { DepositRequest } from './auth/entities/deposit-request.entity';
import { WithdrawalRequest } from './auth/entities/withdrawal-request.entity';
import { BetHistory } from './auth/entities/bet-history.entity';
import { PoolAuditLog } from './auth/entities/pool-audit-log.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProd = config.get<string>('NODE_ENV') === 'production';
        const dbPassword = config.get<string>('DB_PASSWORD');

        if (isProd && (!dbPassword || dbPassword === '12345678' || dbPassword === 'postgres')) {
          throw new Error('SECURITY FATAL: Insecure or default DB_PASSWORD configured for production environment!');
        }

        return {
          type: 'postgres',
          host: config.get<string>('DB_HOST', 'localhost'),
          port: parseInt(config.get<string>('DB_PORT', '5432'), 10),
          username: config.get<string>('DB_USER', 'postgres'),
          password: dbPassword || (isProd ? '' : '12345678'),
          database: config.get<string>('DB_NAME', 'skyrush_db'),
          entities: [User, Transaction, DepositRequest, WithdrawalRequest, BetHistory, PoolAuditLog],
          synchronize: !isProd, // Auto-create tables in non-production, disable schema alteration in prod
        };
      },
    }),
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 15, // max 15 requests per second
      },
      {
        name: 'medium',
        ttl: 10000,
        limit: 60, // max 60 requests per 10 seconds
      },
      {
        name: 'long',
        ttl: 60000,
        limit: 150, // max 150 requests per minute
      },
    ]),
    RedisModule,
    GameModule,
    AuthModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: SanitizeInterceptor,
    },
  ],
})
export class AppModule {}
