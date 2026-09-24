import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: parseInt(config.get<string>('DB_PORT', '5432'), 10),
        username: config.get<string>('DB_USER', 'postgres'),
        password: config.get<string>('DB_PASSWORD', '12345678'),
        database: config.get<string>('DB_NAME', 'skyrush_db'),
        entities: [User, Transaction, DepositRequest, WithdrawalRequest, BetHistory],
        synchronize: true, // Auto-create tables in PostgreSQL
      }),
    }),
    RedisModule,
    GameModule,
    AuthModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
