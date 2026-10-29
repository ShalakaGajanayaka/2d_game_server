import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Headers,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GameService } from './game.service';
import { RedisService } from '../redis/redis.service';
import { User } from '../auth/entities/user.entity';
import * as crypto from 'crypto';

@Controller('game/provably-fair')
export class GameController {
  constructor(
    private readonly gameService: GameService,
    private readonly redisService: RedisService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  @Get('current')
  getCurrentRound() {
    return {
      success: true,
      data: this.gameService.getProvablyFairRound(),
    };
  }

  @Post('client-seed')
  async setClientSeed(
    @Headers('authorization') authHeader: string,
    @Body() body: { clientSeed?: string },
  ) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication token required to set client seed');
    }
    const token = authHeader.replace('Bearer ', '').trim();
    const username = await this.redisService.get(`token:${token}`);
    if (!username) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const user = await this.userRepo.findOne({ where: { username } });
    if (!user) {
      throw new UnauthorizedException('User account not found');
    }
    if (user.isFrozen) {
      throw new UnauthorizedException(
        `Account is suspended: ${user.freezeReason || 'Under security review'}. Provably fair modifications are disabled.`,
      );
    }

    if (!body?.clientSeed || typeof body.clientSeed !== 'string') {
      throw new BadRequestException('Property "clientSeed" must be a non-empty string in request body.');
    }

    // Rate-limit seed rotation: 1 rotation per 10 seconds per authenticated user
    const rateKey = `rate:client_seed:${username.toLowerCase()}`;
    const isThrottled = await this.redisService.get(rateKey);
    if (isThrottled) {
      throw new BadRequestException('Client seed can only be rotated once every 10 seconds.');
    }
    await this.redisService.set(rateKey, '1', 10);

    return this.gameService.setNextClientSeed(body.clientSeed);
  }

  @Get('verify')
  verifyRound(
    @Query('serverSeed') serverSeed: string,
    @Query('clientSeed') clientSeed: string,
    @Query('nonce') nonceStr: string,
  ) {
    if (!serverSeed || !clientSeed || !nonceStr) {
      throw new BadRequestException('Query parameters "serverSeed", "clientSeed", and "nonce" are required.');
    }

    const nonce = parseInt(nonceStr, 10);
    if (isNaN(nonce) || nonce <= 0) {
      throw new BadRequestException('nonce must be a positive integer.');
    }

    const cleanServerSeed = serverSeed.trim();
    const cleanClientSeed = clientSeed.trim();

    const serverSeedHash = crypto.createHash('sha256').update(cleanServerSeed).digest('hex');
    const crashPoint = this.gameService.calculateProvablyFairCrashPoint(cleanServerSeed, cleanClientSeed, nonce);

    return {
      success: true,
      verified: true,
      serverSeed: cleanServerSeed,
      serverSeedHash,
      clientSeed: cleanClientSeed,
      nonce,
      crashPoint,
      isInstantCrash: crashPoint === 1.00,
      rtpRate: '97.00%',
      houseEdge: '3.00%',
      algorithm: 'HMAC_SHA256(serverSeed, clientSeed + ":" + nonce) -> 52-bit float -> multiplier',
      verifiedAt: new Date().toISOString(),
    };
  }

  @Get('round/:roundNumber')
  async getRoundAudit(@Param('roundNumber') roundNumberStr: string) {
    const roundNumber = parseInt(roundNumberStr, 10);
    if (isNaN(roundNumber) || roundNumber <= 0) {
      throw new BadRequestException('Invalid round number.');
    }

    const audit = await this.gameService.getHistoricalRoundAudit(roundNumber);
    if (!audit) {
      return {
        success: false,
        message: 'Round audit data not found or round has not yet concluded.',
        roundNumber,
      };
    }

    return {
      success: true,
      roundNumber,
      data: audit,
    };
  }

  @Get('recent')
  async getRecentRounds(
    @Query('room') roomType: any = 'standard',
    @Query('limit') limitStr?: string,
  ) {
    const limit = limitStr ? parseInt(limitStr, 10) : 20;
    const rounds = await this.gameService.getRecentRounds(roomType, isNaN(limit) ? 20 : limit);
    return {
      success: true,
      data: rounds,
    };
  }
}
