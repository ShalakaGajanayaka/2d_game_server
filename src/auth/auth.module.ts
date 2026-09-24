import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { RedisModule } from '../redis/redis.module';
import { User } from './entities/user.entity';
import { Transaction } from './entities/transaction.entity';
import { DepositRequest } from './entities/deposit-request.entity';
import { BetHistory } from './entities/bet-history.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, Transaction, DepositRequest, BetHistory]), RedisModule],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
