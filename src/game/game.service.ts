import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import * as crypto from 'crypto';
import { RedisService } from '../redis/redis.service';

export enum GameStatus {
  WAITING = 'waiting',
  PLAYING = 'playing',
  CRASHED = 'crashed',
}

export enum GameRoomType {
  STANDARD = 'standard',
  MARKETING = 'marketing',
}

export interface LiveBet {
  id: string;
  name: string;
  bet: number;
  targetMultiplier: number;
  cashedOut: boolean;
  cashedOutMultiplier?: number;
}

export interface MarketingAutoWinBet {
  betId: string;
  userId: string;
  username: string;
  betIndex: number;
  amount: number;
  targetAutoCashout?: number;
}

const NAME_PREFIXES = [
  'alex', 'sam', 'johnd', 'crypto', 'sky', 'lucky', 'bet', 'speedy', 'elena',
  'king', 'queen', 'ace', 'falcon', 'neo', 'shadow', 'zenith', 'rocket', 'viper',
  'matrix', 'hazard', 'star', 'pilot', 'pro', 'tiger', 'wolf', 'ghost', 'blade',
  'flash', 'titan', 'dragon', 'dark', 'iron', 'apex', 'zero', 'storm', 'nova',
  'cyber', 'vortex', 'silver', 'gold', 'alpha', 'omega', 'phantom', 'sonic',
  'kasun', 'dinuka', 'roshan', 'chaminda', 'saman', 'nimal', 'ravi', 'tharindu',
  'nuwan', 'ishan', 'damith', 'janaka', 'lahiru', 'malith', 'sachin', 'ashan',
];

const NAME_SUFFIXES = [
  '**', '_99', '_lk', '_pro', '_vip', '_777', '_x', '_01', '_king', '_boss',
  '_run', '_fly', '91', '88', '77', '55', '33', '12', '44', '69', '007',
  '_win', '_fast', '_top', '24', '10', '98', '03', '50', '21', '_usdt', '_sky',
];

// Industry-standard realistic bet distribution pools (USD Universal Base)
// Standard Room: Natural retail player distribution (~75% micro, ~19% mid, ~6% high, max $500)
const STANDARD_BETS_SMALL = [1, 2, 3, 5, 7, 10, 12, 15, 20, 25];
const STANDARD_BETS_MEDIUM = [30, 40, 50, 60, 75, 80, 100];
const STANDARD_BETS_HIGH = [120, 150, 180, 200, 250, 300, 500];

// Marketing Room: Streamer-oriented lively bets without suspicious $1000+ walls (~60% small, ~28% mid, ~12% high, max $500)
const MARKETING_BETS_SMALL = [2, 5, 8, 10, 15, 20, 25, 30];
const MARKETING_BETS_MEDIUM = [35, 50, 60, 75, 100, 125, 150];
const MARKETING_BETS_HIGH = [175, 200, 250, 300, 350, 400, 500];


export class GameRoomState {
  readonly roomType: GameRoomType;
  status: GameStatus = GameStatus.WAITING;
  countdown: number = 10;
  currentMultiplier: number = 1.0;
  crashPoint: number = 1.0;
  startTime: number = 0;
  targetStartTime: number = 0;
  flightTickCount: number = 0;
  timer: NodeJS.Timeout | null = null;
  gameLoopTimer: NodeJS.Timeout | null = null;
  botStreamTimer: NodeJS.Timeout | null = null;
  currentRoundBets: LiveBet[] = [];
  pendingRoundBots: LiveBet[] = [];

  // Provably Fair variables
  roundNumber: number = 0;
  currentServerSeed: string = '';
  currentServerSeedHash: string = '';
  currentClientSeed: string = '0000000000000000000413e4592f3d37fa6104b0e32e31575e03b0c8b95da420';
  previousRound: {
    roundNumber: number;
    serverSeed: string;
    serverSeedHash: string;
    clientSeed: string;
    crashPoint: number;
  } | null = null;

  activeRealLiability: number = 0;
  activeMarketingAutoWinBets: MarketingAutoWinBet[] = [];

  constructor(roomType: GameRoomType) {
    this.roomType = roomType;
  }
}

@Injectable()
export class GameService implements OnModuleInit {
  private readonly logger = new Logger(GameService.name);
  private server: Server;

  // Multi-Room Engine state
  private rooms: Map<GameRoomType, GameRoomState> = new Map();

  // Company virtual pool variables (Universal Base Currency: USD $ - Standard Room strictly protected)
  private globalPool: number = 100.0;
  private pendingGlobalPool: number | null = null;
  private companyProfitMargin: number = 0.05; // 5%

  private crashCallbacks: Array<(crashPoint: number, roomType: GameRoomType) => void> = [];
  private roundStartCallbacks: Array<(roomType: GameRoomType) => Promise<void> | void> = [];
  private marketingAutoCashoutCallback: ((userId: string, betIndex: number, multiplier: number) => Promise<void>) | null = null;

  constructor(private readonly redisService: RedisService) {
    this.rooms.set(GameRoomType.STANDARD, new GameRoomState(GameRoomType.STANDARD));
    this.rooms.set(GameRoomType.MARKETING, new GameRoomState(GameRoomType.MARKETING));
  }

  async onModuleInit() {
    try {
      const savedPool = await this.redisService.get('game:global_pool');
      if (savedPool !== null && savedPool !== undefined && !isNaN(parseFloat(savedPool))) {
        this.globalPool = parseFloat(savedPool);
        this.logger.log(`Initialized Global Pool from Redis: $${this.globalPool} USD`);
      } else {
        await this.redisService.set('game:global_pool', this.globalPool.toString());
        this.logger.log(`Initialized Global Pool in Redis with default: $${this.globalPool} USD`);
      }

      const savedPending = await this.redisService.get('game:pending_global_pool');
      if (savedPending !== null && savedPending !== undefined && !isNaN(parseFloat(savedPending))) {
        this.pendingGlobalPool = parseFloat(savedPending);
        this.logger.log(`Restored Pending Global Pool from Redis: $${this.pendingGlobalPool} USD`);
      }

      // Initialize rounds for both rooms
      for (const roomType of [GameRoomType.STANDARD, GameRoomType.MARKETING]) {
        const room = this.rooms.get(roomType)!;
        const savedRound = await this.redisService.get(`game:${roomType}:round_number`);
        if (savedRound !== null && savedRound !== undefined && !isNaN(parseInt(savedRound, 10))) {
          room.roundNumber = parseInt(savedRound, 10);
        } else {
          room.roundNumber = 1;
          await this.redisService.set(`game:${roomType}:round_number`, '1');
        }

        room.currentServerSeed = crypto.randomBytes(32).toString('hex');
        room.currentServerSeedHash = crypto.createHash('sha256').update(room.currentServerSeed).digest('hex');
        this.logger.log(
          `[Room: ${roomType.toUpperCase()}] Initialized Engine. Round #${room.roundNumber}, Seed Hash: ${room.currentServerSeedHash.slice(0, 16)}...`,
        );
      }
    } catch (err) {
      this.logger.warn('Failed to load global pool or provably fair state from Redis', err);
    }
  }

  public setServer(server: Server) {
    this.server = server;
    // Launch countdown timers for both rooms independently
    for (const roomType of [GameRoomType.STANDARD, GameRoomType.MARKETING]) {
      const room = this.rooms.get(roomType)!;
      if (room.status === GameStatus.WAITING && room.countdown === 10) {
        this.startCountdown(roomType);
      }
    }
  }

  // Minimum safety floor to prevent infinite forced 1.01x crash loops ($20.00 USD)
  public static readonly MIN_POOL_FLOOR: number = 20.0;

  public getGlobalPool(): number {
    return this.globalPool;
  }

  public getPendingGlobalPool(): number | null {
    return this.pendingGlobalPool;
  }

  public getActiveRealLiability(roomType: GameRoomType = GameRoomType.STANDARD): number {
    return this.rooms.get(roomType)?.activeRealLiability || 0;
  }

  public getRoom(roomType: GameRoomType = GameRoomType.STANDARD): GameRoomState {
    return this.rooms.get(roomType) || this.rooms.get(GameRoomType.STANDARD)!;
  }

  public async setGlobalPool(amount: number): Promise<{
    globalPool: number;
    pending: boolean;
    target: number;
    appliedRound: 'IMMEDIATE' | 'NEXT_ROUND';
  }> {
    const target = parseFloat(amount.toFixed(2));
    if (target < GameService.MIN_POOL_FLOOR) {
      throw new Error(`Cannot set pool ($${target} USD) below minimum safety floor $${GameService.MIN_POOL_FLOOR} USD`);
    }

    const standardRoom = this.rooms.get(GameRoomType.STANDARD)!;
    if (standardRoom.status === GameStatus.PLAYING) {
      this.pendingGlobalPool = target;
      try {
        await this.redisService.set('game:pending_global_pool', this.pendingGlobalPool.toString());
      } catch (err) {
        this.logger.warn('Failed to persist pending global pool to Redis', err);
      }
      this.logger.log(
        `Global Pool update staged for NEXT ROUND: Target $${target} USD (Active flight pool remains $${this.globalPool} USD)`,
      );

      if (this.server) {
        this.server.to('room:standard').emit('globalPoolUpdated', {
          globalPool: this.globalPool,
          pendingGlobalPool: this.pendingGlobalPool,
          timestamp: Date.now(),
        });
      }

      return {
        globalPool: this.globalPool,
        pending: true,
        target,
        appliedRound: 'NEXT_ROUND',
      };
    }

    this.globalPool = target;
    this.pendingGlobalPool = null;
    try {
      await this.redisService.set('game:global_pool', this.globalPool.toString());
      await this.redisService.del('game:pending_global_pool');
    } catch (err) {
      this.logger.warn('Failed to persist global pool to Redis', err);
    }
    this.logger.log(`Global Pool updated immediately to: ${this.globalPool}`);

    if (this.server) {
      this.server.to('room:standard').emit('globalPoolUpdated', {
        globalPool: this.globalPool,
        pendingGlobalPool: null,
        timestamp: Date.now(),
      });
    }

    return {
      globalPool: this.globalPool,
      pending: false,
      target,
      appliedRound: 'IMMEDIATE',
    };
  }

  public async registerRealBet(amount: number, isMarketing: boolean = false, roomType: GameRoomType = GameRoomType.STANDARD) {
    const room = this.rooms.get(roomType)!;
    if (!isMarketing && roomType === GameRoomType.STANDARD) {
      this.globalPool += amount * (1 - this.companyProfitMargin);
      if (room.status === GameStatus.WAITING || room.status === GameStatus.PLAYING) {
        room.activeRealLiability += amount;
      }
      try {
        await this.redisService.set('game:global_pool', this.globalPool.toFixed(2));
      } catch (err) {
        this.logger.warn('Failed to persist global pool to Redis', err);
      }
    }
    this.logger.log(`[Room: ${roomType}] Real bet added: ${amount} (marketing: ${isMarketing}). Pool: ${this.globalPool.toFixed(2)}, Liability: ${room.activeRealLiability}`);
  }

  public async registerRealCashout(betAmount: number, winAmount: number, isMarketing: boolean = false, roomType: GameRoomType = GameRoomType.STANDARD) {
    const room = this.rooms.get(roomType)!;
    if (!isMarketing && roomType === GameRoomType.STANDARD) {
      room.activeRealLiability = Math.max(0, room.activeRealLiability - betAmount);
      this.globalPool = Math.max(0, this.globalPool - winAmount);
      try {
        await this.redisService.set('game:global_pool', this.globalPool.toFixed(2));
      } catch (err) {
        this.logger.warn('Failed to persist global pool to Redis', err);
      }
    }
    this.logger.log(`[Room: ${roomType}] Real cashout: Bet ${betAmount}, Win ${winAmount} (marketing: ${isMarketing}). Pool: ${this.globalPool.toFixed(2)}, Liability: ${room.activeRealLiability}`);
  }

  public async cancelRealBet(amount: number, isMarketing: boolean = false, roomType: GameRoomType = GameRoomType.STANDARD) {
    const room = this.rooms.get(roomType)!;
    if (!isMarketing && roomType === GameRoomType.STANDARD) {
      this.globalPool = Math.max(0, this.globalPool - amount * (1 - this.companyProfitMargin));
      room.activeRealLiability = Math.max(0, room.activeRealLiability - amount);
      try {
        await this.redisService.set('game:global_pool', this.globalPool.toFixed(2));
      } catch (err) {
        this.logger.warn('Failed to persist global pool to Redis', err);
      }
    }
    this.logger.log(`[Room: ${roomType}] Real bet cancelled: ${amount} (marketing: ${isMarketing}). Pool: ${this.globalPool.toFixed(2)}, Liability: ${room.activeRealLiability}`);
  }

  public getStatus(roomType: GameRoomType = GameRoomType.STANDARD): GameStatus {
    return this.getRoom(roomType).status;
  }

  public getCurrentMultiplier(roomType: GameRoomType = GameRoomType.STANDARD): number {
    return this.getRoom(roomType).currentMultiplier;
  }

  public getCrashPoint(roomType: GameRoomType = GameRoomType.STANDARD): number {
    return this.getRoom(roomType).crashPoint;
  }

  public getStartTime(roomType: GameRoomType = GameRoomType.STANDARD): number {
    return this.getRoom(roomType).startTime;
  }

  public addRealUserBet(bet: LiveBet, roomType: GameRoomType = GameRoomType.STANDARD) {
    const room = this.getRoom(roomType);
    room.currentRoundBets.unshift(bet);
    if (this.server) {
      this.server.to(`room:${roomType}`).emit('newLiveBet', bet);
    }
  }

  public removeRealUserBet(betId: string, roomType: GameRoomType = GameRoomType.STANDARD) {
    const room = this.getRoom(roomType);
    room.currentRoundBets = room.currentRoundBets.filter(b => b.id !== betId);
    this.removeMarketingAutoWinBet(betId);
    if (this.server) {
      this.server.to(`room:${roomType}`).emit('betCancelled', { id: betId });
    }
  }

  public markRealUserCashout(betId: string, multiplier: number, winAmount: number, roomType: GameRoomType = GameRoomType.STANDARD) {
    const room = this.getRoom(roomType);
    const bet = room.currentRoundBets.find(b => b.id === betId);
    if (bet) {
      bet.cashedOut = true;
      bet.cashedOutMultiplier = multiplier;
    }
    this.removeMarketingAutoWinBet(betId);
    if (this.server) {
      this.server.to(`room:${roomType}`).emit('betCashedOut', {
        id: betId,
        multiplier,
        winAmount,
      });
    }
  }

  public hasActiveBet(username: string): boolean {
    if (!username) return false;
    const cleanUser = username.toLowerCase();
    for (const room of this.rooms.values()) {
      if (room.currentRoundBets.some(b => b.name?.toLowerCase() === cleanUser && !b.cashedOut)) {
        return true;
      }
    }
    return false;
  }

  public registerMarketingAutoCashoutCallback(cb: (userId: string, betIndex: number, multiplier: number) => Promise<void>) {
    this.marketingAutoCashoutCallback = cb;
  }

  public registerMarketingAutoWinBet(bet: MarketingAutoWinBet) {
    const room = this.rooms.get(GameRoomType.MARKETING)!;
    room.activeMarketingAutoWinBets.push(bet);
    this.logger.log(`[Marketing Room] Registered auto-win bet for user ${bet.username} (Slot ${bet.betIndex}, Amount: ${bet.amount})`);
  }

  public removeMarketingAutoWinBet(betId: string) {
    for (const room of this.rooms.values()) {
      room.activeMarketingAutoWinBets = room.activeMarketingAutoWinBets.filter(b => b.betId !== betId);
    }
  }

  public registerCrashCallback(cb: (crashPoint: number, roomType: GameRoomType) => void) {
    this.crashCallbacks.push(cb);
  }

  public registerRoundStartCallback(cb: (roomType: GameRoomType) => Promise<void> | void) {
    this.roundStartCallbacks.push(cb);
  }

  private generateUniqueName(roomType: GameRoomType, index: number): string {
    const prefix = NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)];
    const suffix = NAME_SUFFIXES[Math.floor(Math.random() * NAME_SUFFIXES.length)];
    return `${prefix}${suffix}`;
  }

  private getRandomBotBetAmount(roomType: GameRoomType): number {
    const roll = Math.random();
    if (roomType === GameRoomType.MARKETING) {
      if (roll < 0.60) {
        return MARKETING_BETS_SMALL[Math.floor(Math.random() * MARKETING_BETS_SMALL.length)];
      } else if (roll < 0.88) {
        return MARKETING_BETS_MEDIUM[Math.floor(Math.random() * MARKETING_BETS_MEDIUM.length)];
      } else {
        return MARKETING_BETS_HIGH[Math.floor(Math.random() * MARKETING_BETS_HIGH.length)];
      }
    } else {
      if (roll < 0.75) {
        return STANDARD_BETS_SMALL[Math.floor(Math.random() * STANDARD_BETS_SMALL.length)];
      } else if (roll < 0.94) {
        return STANDARD_BETS_MEDIUM[Math.floor(Math.random() * STANDARD_BETS_MEDIUM.length)];
      } else {
        return STANDARD_BETS_HIGH[Math.floor(Math.random() * STANDARD_BETS_HIGH.length)];
      }
    }
  }

  private generateRoundBots(roomType: GameRoomType): LiveBet[] {
    // Generate between 120 and 260 bots per round (100 - 300 range)
    const count = Math.floor(Math.random() * 141) + 120;
    const bots: LiveBet[] = [];
    const usedNames = new Set<string>();

    for (let i = 0; i < count; i++) {
      let name = this.generateUniqueName(roomType, i);
      let attempts = 0;
      while (usedNames.has(name) && attempts < 10) {
        attempts++;
        name = this.generateUniqueName(roomType, i + attempts * 50);
      }
      usedNames.add(name);

      const betAmount = this.getRandomBotBetAmount(roomType);

      let targetMultiplier: number;
      const roll = Math.random();
      if (roomType === GameRoomType.MARKETING) {
        // Streamer room has more aggressive, exciting bot targets
        if (roll < 0.35) {
          targetMultiplier = parseFloat((1.15 + Math.random() * 0.85).toFixed(2));
        } else if (roll < 0.70) {
          targetMultiplier = parseFloat((2.00 + Math.random() * 3.00).toFixed(2));
        } else if (roll < 0.90) {
          targetMultiplier = parseFloat((5.00 + Math.random() * 7.00).toFixed(2));
        } else {
          targetMultiplier = parseFloat((12.00 + Math.random() * 25.00).toFixed(2));
        }
      } else {
        // Standard room realistic bot targets
        if (roll < 0.45) {
          targetMultiplier = parseFloat((1.10 + Math.random() * 0.70).toFixed(2));
        } else if (roll < 0.80) {
          targetMultiplier = parseFloat((1.80 + Math.random() * 1.70).toFixed(2));
        } else if (roll < 0.95) {
          targetMultiplier = parseFloat((3.50 + Math.random() * 4.50).toFixed(2));
        } else {
          targetMultiplier = parseFloat((8.00 + Math.random() * 12.00).toFixed(2));
        }
      }

      bots.push({
        id: `bot_${roomType}_${i}_${Date.now()}`,
        name,
        bet: betAmount,
        targetMultiplier,
        cashedOut: false,
      });
    }

    return bots;
  }

  public startCountdown(roomType: GameRoomType) {
    const room = this.rooms.get(roomType)!;

    if (roomType === GameRoomType.STANDARD && this.pendingGlobalPool !== null) {
      this.globalPool = this.pendingGlobalPool;
      this.logger.log(`🚀 Applied staged pool to Global Pool for new round: $${this.globalPool} USD`);
      this.pendingGlobalPool = null;
      try {
        this.redisService.set('game:global_pool', this.globalPool.toString());
        this.redisService.del('game:pending_global_pool');
      } catch (err) {
        this.logger.warn('Failed to persist new global pool on round start', err);
      }
      if (this.server) {
        this.server.to('room:standard').emit('globalPoolUpdated', {
          globalPool: this.globalPool,
          pendingGlobalPool: null,
          timestamp: Date.now(),
        });
      }
    }

    room.status = GameStatus.WAITING;
    room.countdown = 10;
    room.targetStartTime = Date.now() + 10000;
    room.currentMultiplier = 1.0;
    room.activeRealLiability = 0;

    // Advance Provably Fair round commitment
    room.roundNumber++;
    room.currentServerSeed = crypto.randomBytes(32).toString('hex');
    room.currentServerSeedHash = crypto.createHash('sha256').update(room.currentServerSeed).digest('hex');

    if (roomType === GameRoomType.MARKETING) {
      room.crashPoint = this.generateMarketingCrashPoint();
    } else {
      room.crashPoint = this.calculateProvablyFairCrashPoint(
        room.currentServerSeed,
        room.currentClientSeed,
        room.roundNumber,
      );
    }

    try {
      this.redisService.set(`game:${roomType}:round_number`, room.roundNumber.toString());
      this.redisService.set(
        `provably_fair:${roomType}:round:${room.roundNumber}:commitment`,
        JSON.stringify({
          roundNumber: room.roundNumber,
          serverSeedHash: room.currentServerSeedHash,
          clientSeed: room.currentClientSeed,
          createdAt: Date.now(),
        }),
        86400 * 3,
      );
    } catch (err) {
      this.logger.warn(`Failed to persist Provably Fair commitment for ${roomType} to Redis`, err);
    }

    this.logger.log(
      `[Room: ${roomType.toUpperCase()}] Round #${room.roundNumber} committed. ServerSeedHash: ${room.currentServerSeedHash.slice(0, 16)}... | CrashPoint: ${room.crashPoint}x`,
    );

    // Generate independent bot pool (120 - 260 bots)
    const allBots = this.generateRoundBots(roomType);
    const initialCount = Math.floor(Math.random() * 8) + 14;
    room.currentRoundBets = allBots.slice(0, initialCount);
    room.pendingRoundBots = allBots.slice(initialCount);

    this.logger.log(`[Room: ${roomType.toUpperCase()}] Starting countdown. Initial bots: ${room.currentRoundBets.length}, Total targeted: ${allBots.length}`);
    this.broadcastState(roomType, true);
    if (roomType === GameRoomType.MARKETING) {
      this.broadcastMarketingPreview();
    }

    // Authoritative activation of queued bets for this room
    for (const cb of this.roundStartCallbacks) {
      try {
        const res = cb(roomType);
        if (res instanceof Promise) res.catch(err => this.logger.error(`Error executing round start async callback for ${roomType}`, err));
      } catch (err) {
        this.logger.error(`Error executing round start callback for ${roomType}`, err);
      }
    }

    if (room.timer) clearInterval(room.timer);
    if (room.botStreamTimer) clearInterval(room.botStreamTimer);

    // Stream incoming bot batches every 350ms to simulate a packed casino room
    room.botStreamTimer = setInterval(() => {
      if (room.status === GameStatus.WAITING && room.pendingRoundBots.length > 0) {
        const batchSize = Math.min(
          room.pendingRoundBots.length,
          Math.floor(Math.random() * 7) + 4,
        );
        const batch = room.pendingRoundBots.splice(0, batchSize);
        if (batch.length > 0) {
          room.currentRoundBets.push(...batch);
          if (this.server) {
            this.server.to(`room:${roomType}`).emit('newLiveBetsBatch', batch);
          }
        }
      } else if (room.pendingRoundBots.length === 0 && room.botStreamTimer) {
        clearInterval(room.botStreamTimer);
      }
    }, 350);

    room.timer = setInterval(() => {
      room.countdown--;
      this.broadcastState(roomType, false);
      if (roomType === GameRoomType.MARKETING) {
        this.broadcastMarketingPreview();
      }

      if (room.countdown <= 1) {
        if (room.pendingRoundBots.length > 0) {
          const remainingBatch = room.pendingRoundBots.splice(0);
          room.currentRoundBets.push(...remainingBatch);
          if (this.server) {
            this.server.to(`room:${roomType}`).emit('newLiveBetsBatch', remainingBatch);
          }
        }
      }

      if (room.countdown <= 0) {
        clearInterval(room.timer!);
        if (room.botStreamTimer) clearInterval(room.botStreamTimer);
        this.startGame(roomType);
      }
    }, 1000);
  }

  private startGame(roomType: GameRoomType) {
    const room = this.rooms.get(roomType)!;
    room.status = GameStatus.PLAYING;
    if (!room.crashPoint || room.crashPoint < 1.0) {
      room.crashPoint = roomType === GameRoomType.MARKETING ? this.generateMarketingCrashPoint() : this.generateCrashPoint();
    }
    room.currentMultiplier = 1.0;
    room.startTime = Date.now();
    room.flightTickCount = 0;

    // Schedule dramatic close-call auto cashout points for any active marketing bets in this room
    for (const mBet of room.activeMarketingAutoWinBets) {
      const winFactor = 0.82 + Math.random() * 0.08;
      mBet.targetAutoCashout = Math.max(1.20, parseFloat((room.crashPoint * winFactor).toFixed(2)));
      this.logger.log(`[Marketing Auto-Win] Scheduled for ${mBet.username} at ${mBet.targetAutoCashout}x (Crash: ${room.crashPoint}x)`);
    }

    if (room.botStreamTimer) clearInterval(room.botStreamTimer);
    if (room.pendingRoundBots.length > 0) {
      room.currentRoundBets.push(...room.pendingRoundBots.splice(0));
    }

    this.logger.log(`[Room: ${roomType.toUpperCase()}] Flight started. Total bets: ${room.currentRoundBets.length}, Crash point: ${room.crashPoint}`);
    this.broadcastState(roomType, false);
    if (roomType === GameRoomType.MARKETING) {
      this.broadcastMarketingPreview();
    }

    if (room.gameLoopTimer) clearInterval(room.gameLoopTimer);

    room.gameLoopTimer = setInterval(() => {
      const elapsedSeconds = (Date.now() - room.startTime) / 1000;
      room.currentMultiplier = Math.max(1.0, Math.exp(0.095 * elapsedSeconds));
      room.flightTickCount++;

      // Every 250ms (5 ticks), emit lightweight heartbeat
      if (room.flightTickCount % 5 === 0 && this.server) {
        this.server.to(`room:${roomType}`).emit('flightSync', {
          room: roomType,
          multiplier: parseFloat(room.currentMultiplier.toFixed(2)),
          elapsedSeconds: parseFloat(elapsedSeconds.toFixed(2)),
          startTime: room.startTime,
          targetCrashPoint: roomType === GameRoomType.MARKETING ? room.crashPoint : null,
          serverTime: Date.now(),
        });
        if (roomType === GameRoomType.MARKETING) {
          this.broadcastMarketingPreview();
        }
      }

      // Check for bot cashouts
      for (const bot of room.currentRoundBets) {
        if (!bot.cashedOut && room.currentMultiplier >= bot.targetMultiplier && bot.targetMultiplier < room.crashPoint) {
          bot.cashedOut = true;
          bot.cashedOutMultiplier = bot.targetMultiplier;
          const winAmount = parseFloat((bot.bet * bot.cashedOutMultiplier).toFixed(2));

          if (this.server) {
            this.server.to(`room:${roomType}`).emit('betCashedOut', {
              id: bot.id,
              multiplier: bot.cashedOutMultiplier,
              winAmount,
            });
          }
        }
      }

      // Check for marketing auto-win cashouts (if enabled)
      if (room.activeMarketingAutoWinBets.length > 0) {
        for (let i = room.activeMarketingAutoWinBets.length - 1; i >= 0; i--) {
          const mBet = room.activeMarketingAutoWinBets[i];
          if (mBet.targetAutoCashout && room.currentMultiplier >= mBet.targetAutoCashout && room.currentMultiplier < room.crashPoint) {
            room.activeMarketingAutoWinBets.splice(i, 1);
            const cashoutMultiplier = parseFloat(room.currentMultiplier.toFixed(2));
            this.logger.log(`[Marketing Room] Triggering auto-cashout for ${mBet.username} at ${cashoutMultiplier}x`);
            if (this.marketingAutoCashoutCallback) {
              this.marketingAutoCashoutCallback(mBet.userId, mBet.betIndex, cashoutMultiplier).catch(err => {
                this.logger.error(`[Marketing Room] Error executing auto-cashout for ${mBet.username}`, err);
              });
            }
          }
        }
      }

      if (room.currentMultiplier >= room.crashPoint) {
        this.crash(roomType);
      }
    }, 50);
  }

  private crash(roomType: GameRoomType) {
    const room = this.rooms.get(roomType)!;
    if (room.gameLoopTimer) clearInterval(room.gameLoopTimer);

    room.status = GameStatus.CRASHED;
    room.currentMultiplier = room.crashPoint;

    room.previousRound = {
      roundNumber: room.roundNumber,
      serverSeed: room.currentServerSeed,
      serverSeedHash: room.currentServerSeedHash,
      clientSeed: room.currentClientSeed,
      crashPoint: room.crashPoint,
    };

    try {
      this.redisService.set(
        `provably_fair:${roomType}:round:${room.roundNumber}:revealed`,
        JSON.stringify(room.previousRound),
        86400 * 7,
      );
    } catch (err) {
      this.logger.warn(`Failed to store revealed provably fair round for ${roomType} to Redis`, err);
    }

    this.logger.log(
      `[Room: ${roomType.toUpperCase()}] Round #${room.roundNumber} crashed at ${room.crashPoint}x. ServerSeed revealed: ${room.currentServerSeed.slice(0, 16)}...`,
    );
    this.broadcastState(roomType, false);
    if (roomType === GameRoomType.MARKETING) {
      this.broadcastMarketingPreview();
    }

    // Trigger crash callbacks for authoritative round settlement
    for (const cb of this.crashCallbacks) {
      try {
        cb(room.crashPoint, roomType);
      } catch (err) {
        this.logger.error(`Error executing crash callback for ${roomType}`, err);
      }
    }

    // Wait 3 seconds before next round
    setTimeout(() => {
      this.startCountdown(roomType);
    }, 3000);
  }

  public generateCrashPoint(): number {
    const standardRoom = this.rooms.get(GameRoomType.STANDARD)!;
    return this.calculateProvablyFairCrashPoint(
      standardRoom.currentServerSeed,
      standardRoom.currentClientSeed,
      standardRoom.roundNumber,
    );
  }

  /**
   * Generates high-entertainment crash points for Marketing Studio Room.
   * Realistic Distribution:
   * - 15% natural early losses: 1.15x - 1.85x
   * - 55% high solid runs: 3.50x - 8.00x
   * - 22% huge exciting runs: 8.00x - 20.00x
   * - 8% epic moonshots: 20.00x - 65.00x
   */
  public generateMarketingCrashPoint(): number {
    const roll = Math.random();
    let point: number;
    if (roll < 0.15) {
      point = 1.15 + Math.random() * 0.70;
    } else if (roll < 0.70) {
      point = 3.50 + Math.random() * 4.50;
    } else if (roll < 0.92) {
      point = 8.00 + Math.random() * 12.00;
    } else {
      point = 20.00 + Math.random() * 45.00;
    }
    return parseFloat(point.toFixed(2));
  }

  public calculateProvablyFairCrashPoint(serverSeed: string, clientSeed: string, nonce: number): number {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}:${nonce}`);
    const hash = hmac.digest('hex');

    const h = parseInt(hash.slice(0, 13), 16);
    const e = Math.pow(2, 52);

    // 1 in 33 chance of instant crash at 1.00x (~3.03% house edge)
    if (h % 33 === 0) {
      return 1.00;
    }

    const rawMultiplier = (100 * e - h) / (e - h) / 100;
    const crashPoint = Math.floor(rawMultiplier * 100) / 100;
    return Math.max(1.01, crashPoint);
  }

  public getProvablyFairRound(roomType: GameRoomType = GameRoomType.STANDARD) {
    const room = this.getRoom(roomType);
    return {
      currentRound: {
        roundNumber: room.roundNumber,
        serverSeedHash: room.currentServerSeedHash,
        clientSeed: room.currentClientSeed,
        serverSeed: room.status === GameStatus.CRASHED ? room.currentServerSeed : 'HIDDEN_UNTIL_ROUND_ENDS',
      },
      previousRound: room.previousRound,
    };
  }

  public async getHistoricalRoundAudit(roundNumber: number, roomType: GameRoomType = GameRoomType.STANDARD) {
    const room = this.getRoom(roomType);
    if (room.previousRound && room.previousRound.roundNumber === roundNumber) {
      return room.previousRound;
    }
    try {
      const data = await this.redisService.get(`provably_fair:${roomType}:round:${roundNumber}:revealed`);
      if (data) return JSON.parse(data);
    } catch {}
    return null;
  }

  private broadcastState(roomType: GameRoomType, includeFullBets: boolean = true) {
    if (this.server) {
      this.server.to(`room:${roomType}`).emit('gameState', this.getGameState(roomType, includeFullBets));
    }
  }

  public getGameState(roomType: GameRoomType = GameRoomType.STANDARD, includeFullBets: boolean = true) {
    const room = this.getRoom(roomType);
    return {
      room: roomType,
      status: room.status,
      countdown: room.countdown,
      targetStartTime: room.targetStartTime,
      currentMultiplier: parseFloat(room.currentMultiplier.toFixed(2)),
      startTime: room.startTime,
      crashPoint: room.status === GameStatus.CRASHED ? room.crashPoint : null,
      targetCrashPoint: roomType === GameRoomType.MARKETING ? room.crashPoint : null,
      serverTime: Date.now(),
      bets: includeFullBets ? room.currentRoundBets : null,
      provablyFair: {
        roundNumber: room.roundNumber,
        serverSeedHash: room.currentServerSeedHash,
        clientSeed: room.currentClientSeed,
        serverSeed: room.status === GameStatus.CRASHED ? room.currentServerSeed : null,
      },
    };
  }

  public notifyUserBalance(
    target: string | { id?: string; username?: string; email?: string },
    balance: number,
    message?: string,
    currency?: string,
  ) {
    if (this.server) {
      const username = typeof target === 'string' ? target : (target?.username || '');
      const userId = typeof target === 'object' ? target?.id : undefined;

      const payload = {
        username,
        balance,
        currency,
        message: message || 'Your wallet balance has been updated.',
        timestamp: Date.now(),
      };

      const targetRooms = new Set<string>();
      if (userId) targetRooms.add(`user:${userId}`);
      if (username) targetRooms.add(`user:${username.toLowerCase()}`);

      for (const room of targetRooms) {
        this.server.to(room).emit('userBalanceUpdated', payload);
      }
    }
  }

  public notifyNewDeposit(deposit: any) {
    if (this.server) {
      this.server.to('admin_room').emit('newDepositSubmitted', {
        deposit,
        timestamp: Date.now(),
      });
    }
  }

  public notifyNewWithdrawal(withdrawal: any) {
    if (this.server) {
      this.server.to('admin_room').emit('newWithdrawalSubmitted', {
        withdrawal,
        timestamp: Date.now(),
      });
    }
  }

  public notifyBetActivated(userId: string, username: string, betRecord: any) {
    if (this.server) {
      const payload = {
        success: true,
        bet: betRecord,
        betIndex: betRecord.betIndex,
        amount: betRecord.amount,
        currency: betRecord.currency,
        timestamp: Date.now(),
      };
      if (userId) this.server.to(`user:${userId}`).emit('betActivated', payload);
      if (username) this.server.to(`user:${username.toLowerCase()}`).emit('betActivated', payload);
    }
  }

  public getMarketingPreview() {
    const room = this.rooms.get(GameRoomType.MARKETING)!;
    const estFlightDuration =
      room.crashPoint > 1.0
        ? Math.max(0.5, parseFloat((Math.log(room.crashPoint) / 0.095).toFixed(1)))
        : 0;
    const elapsedSeconds =
      room.status === GameStatus.PLAYING
        ? Math.max(0, parseFloat(((Date.now() - room.startTime) / 1000).toFixed(1)))
        : 0;
    const remainingSeconds =
      room.status === GameStatus.PLAYING
        ? Math.max(0, parseFloat((estFlightDuration - elapsedSeconds).toFixed(1)))
        : estFlightDuration;
    const safeCashoutTarget = Math.max(1.15, parseFloat((room.crashPoint * 0.85).toFixed(2)));

    return {
      room: GameRoomType.MARKETING,
      roundNumber: room.roundNumber,
      status: room.status,
      countdown: room.countdown,
      targetStartTime: room.targetStartTime,
      startTime: room.startTime,
      currentMultiplier: parseFloat(room.currentMultiplier.toFixed(2)),
      crashPoint: room.crashPoint,
      safeCashoutTarget,
      estFlightDuration,
      elapsedSeconds,
      remainingSeconds,
      activeAutoWinBetsCount: room.activeMarketingAutoWinBets.length,
      activeBetsCount: room.currentRoundBets.length,
      serverTime: Date.now(),
    };
  }

  public broadcastMarketingPreview() {
    if (this.server) {
      this.server.to('admin_room').emit('marketingPreviewUpdate', this.getMarketingPreview());
    }
  }
}
