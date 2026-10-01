import { Controller, Get, Query, Param, BadRequestException } from '@nestjs/common';
import { GameService } from './game.service';
import * as crypto from 'crypto';

@Controller('game/provably-fair')
export class GameController {
  constructor(private readonly gameService: GameService) {}

  @Get('current')
  getCurrentRound() {
    return {
      success: true,
      data: this.gameService.getProvablyFairRound(),
    };
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
}
