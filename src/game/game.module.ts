import { Module, forwardRef } from '@nestjs/common';
import { GameGateway } from './game.gateway';
import { GameService } from './game.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [GameGateway, GameService],
  exports: [GameService],
})
export class GameModule {}

