import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GameGateway } from './game.gateway';
import { GameService } from './game.service';
import { GameController } from './game.controller';
import { RedisModule } from '../redis/redis.module';
import { User } from '../auth/entities/user.entity';

@Module({
  imports: [RedisModule, TypeOrmModule.forFeature([User])],
  controllers: [GameController],
  providers: [GameGateway, GameService],
  exports: [GameService],
})
export class GameModule {}

