import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Server } from 'socket.io';
import { RedisService } from '../redis/redis.service';

export enum GameStatus {
  WAITING = 'waiting',
  PLAYING = 'playing',
  CRASHED = 'crashed',
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
  'kasun', 'dinuka', 'roshan', 'chaminda', 'saman', 'nimal', 'ravi', 'tharindu'
];

const NAME_SUFFIXES = [
  '**', '_99', '_lk', '_pro', '_vip', '_777', '_x', '_01', '_king', '_boss',
  '_run', '_fly', '91', '88', '77', '55', '33', '12', '44', '69', '007',
  '_win', '_fast', '_top', '24', '10', '98', '03', '50', '21'
];

const BET_AMOUNTS = [
  5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 250, 300, 500, 750, 1000, 1500, 2000
];

@Injectable()
export class GameService implements OnModuleInit {
  private readonly logger = new Logger(GameService.name);
  private server: Server;
  
  private status: GameStatus = GameStatus.WAITING;
  private countdown: number = 10;
  private currentMultiplier: number = 1.0;
  private crashPoint: number = 1.0;
  private startTime: number = 0;
  private targetStartTime: number = 0;
  private flightTickCount: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private gameLoopTimer: NodeJS.Timeout | null = null;
  private botStreamTimer: NodeJS.Timeout | null = null;
  private currentRoundBets: LiveBet[] = [];
  private pendingRoundBots: LiveBet[] = [];

  // Company virtual pool variables
  private globalPool: number = 27215.92;
  private pendingGlobalPool: number | null = null;
  private activeRealLiability: number = 0;
  private companyProfitMargin: number = 0.05; // 5%

  private crashCallbacks: Array<(crashPoint: number) => void> = [];
  private activeMarketingAutoWinBets: MarketingAutoWinBet[] = [];
  private marketingAutoCashoutCallback: ((userId: string, betIndex: number, multiplier: number) => Promise<void>) | null = null;

  constructor(private readonly redisService: RedisService) {}

  async onModuleInit() {
    try {
      const savedPool = await this.redisService.get('game:global_pool');
      if (savedPool !== null && savedPool !== undefined && !isNaN(parseFloat(savedPool))) {
        this.globalPool = parseFloat(savedPool);
        this.logger.log(`Initialized Global Pool from Redis: ${this.globalPool}`);
      } else {
        await this.redisService.set('game:global_pool', this.globalPool.toString());
        this.logger.log(`Initialized Global Pool in Redis with default: ${this.globalPool}`);
      }

      const savedPending = await this.redisService.get('game:pending_global_pool');
      if (savedPending !== null && savedPending !== undefined && !isNaN(parseFloat(savedPending))) {
        this.pendingGlobalPool = parseFloat(savedPending);
        this.logger.log(`Restored Pending Global Pool from Redis: ${this.pendingGlobalPool}`);
      }
    } catch (err) {
      this.logger.warn('Failed to load global pool from Redis', err);
    }
  }

  public setServer(server: Server) {
    this.server = server;
    // Start the game loop when server is attached
    if (this.status === GameStatus.WAITING && this.countdown === 10) {
      this.startCountdown();
    }
  }

  // Minimum safety floor to prevent infinite forced 1.01x crash loops
  public static readonly MIN_POOL_FLOOR: number = 5000;

  public getGlobalPool(): number {
    return this.globalPool;
  }

  public getPendingGlobalPool(): number | null {
    return this.pendingGlobalPool;
  }

  public getActiveRealLiability(): number {
    return this.activeRealLiability;
  }

  public async setGlobalPool(amount: number): Promise<{
    globalPool: number;
    pending: boolean;
    target: number;
    appliedRound: 'IMMEDIATE' | 'NEXT_ROUND';
  }> {
    const target = parseFloat(amount.toFixed(2));
    if (target < GameService.MIN_POOL_FLOOR) {
      throw new Error(`Cannot set pool (LKR ${target}) below minimum safety floor LKR ${GameService.MIN_POOL_FLOOR}`);
    }

    // If game is actively flying (PLAYING), stage the change for the next round
    // to preserve round immutability and prevent mid-flight forced crashes.
    if (this.status === GameStatus.PLAYING) {
      this.pendingGlobalPool = target;
      try {
        await this.redisService.set('game:pending_global_pool', this.pendingGlobalPool.toString());
      } catch (err) {
        this.logger.warn('Failed to persist pending global pool to Redis', err);
      }
      this.logger.log(
        `Global Pool update staged for NEXT ROUND: Target LKR ${target} (Active flight pool remains LKR ${this.globalPool})`,
      );

      if (this.server) {
        this.server.emit('globalPoolUpdated', {
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

    // If round is WAITING or CRASHED, apply immediately
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
      this.server.emit('globalPoolUpdated', {
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

  public async registerRealBet(amount: number, isMarketing: boolean = false) {
    // 95% of real bet amount enters the liability buffer (5% house edge)
    this.globalPool += amount * (1 - this.companyProfitMargin);
    if (!isMarketing && (this.status === GameStatus.WAITING || this.status === GameStatus.PLAYING)) {
      this.activeRealLiability += amount;
    }
    this.logger.log(`Real bet added: ${amount} (marketing: ${isMarketing}). Pool: ${this.globalPool.toFixed(2)}, Liability: ${this.activeRealLiability}`);
    try {
      await this.redisService.set('game:global_pool', this.globalPool.toFixed(2));
    } catch (err) {
      this.logger.warn('Failed to persist global pool to Redis', err);
    }
  }

  public async registerRealCashout(betAmount: number, winAmount: number, isMarketing: boolean = false) {
    if (!isMarketing) {
      this.activeRealLiability = Math.max(0, this.activeRealLiability - betAmount);
    }
    this.globalPool = Math.max(0, this.globalPool - winAmount);
    this.logger.log(`Real cashout: Bet ${betAmount}, Win ${winAmount} (marketing: ${isMarketing}). Pool: ${this.globalPool.toFixed(2)}, Liability: ${this.activeRealLiability}`);
    try {
      await this.redisService.set('game:global_pool', this.globalPool.toFixed(2));
    } catch (err) {
      this.logger.warn('Failed to persist global pool to Redis', err);
    }
  }

  public async cancelRealBet(amount: number) {
    this.globalPool = Math.max(0, this.globalPool - amount * (1 - this.companyProfitMargin));
    this.activeRealLiability = Math.max(0, this.activeRealLiability - amount);
    this.logger.log(`Real bet cancelled: ${amount}. Pool: ${this.globalPool.toFixed(2)}, Liability: ${this.activeRealLiability}`);
    try {
      await this.redisService.set('game:global_pool', this.globalPool.toFixed(2));
    } catch (err) {
      this.logger.warn('Failed to persist global pool to Redis', err);
    }
  }

  public getStatus(): GameStatus {
    return this.status;
  }

  public getCurrentMultiplier(): number {
    return this.currentMultiplier;
  }

  public getCrashPoint(): number {
    return this.crashPoint;
  }

  public getStartTime(): number {
    return this.startTime;
  }

  public addRealUserBet(bet: LiveBet) {
    this.currentRoundBets.unshift(bet);
    if (this.server) {
      this.server.emit('newLiveBet', bet);
    }
  }

  public removeRealUserBet(betId: string) {
    this.currentRoundBets = this.currentRoundBets.filter(b => b.id !== betId);
    this.removeMarketingAutoWinBet(betId);
    if (this.server) {
      this.server.emit('betCancelled', { id: betId });
    }
  }

  public markRealUserCashout(betId: string, multiplier: number, winAmount: number) {
    const bet = this.currentRoundBets.find(b => b.id === betId);
    if (bet) {
      bet.cashedOut = true;
      bet.cashedOutMultiplier = multiplier;
    }
    this.removeMarketingAutoWinBet(betId);
    if (this.server) {
      this.server.emit('betCashedOut', {
        id: betId,
        multiplier,
        winAmount,
      });
    }
  }

  public hasActiveBet(username: string): boolean {
    if (!username) return false;
    return this.currentRoundBets.some(
      b => b.name?.toLowerCase() === username.toLowerCase() && !b.cashedOut
    );
  }

  public registerMarketingAutoCashoutCallback(cb: (userId: string, betIndex: number, multiplier: number) => Promise<void>) {
    this.marketingAutoCashoutCallback = cb;
  }

  public registerMarketingAutoWinBet(bet: MarketingAutoWinBet) {
    this.activeMarketingAutoWinBets.push(bet);
    this.logger.log(`[Marketing] Registered auto-win bet for user ${bet.username} (Slot ${bet.betIndex}, Amount: ${bet.amount})`);
  }

  public removeMarketingAutoWinBet(betId: string) {
    this.activeMarketingAutoWinBets = this.activeMarketingAutoWinBets.filter(b => b.betId !== betId);
  }

  public registerCrashCallback(cb: (crashPoint: number) => void) {
    this.crashCallbacks.push(cb);
  }

  private generateUniqueName(index: number): string {
    const prefix = NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)];
    const suffix = NAME_SUFFIXES[Math.floor(Math.random() * NAME_SUFFIXES.length)];
    return `${prefix}${suffix}`;
  }

  private generateRoundBots(): LiveBet[] {
    // Generate between 120 and 260 bots per round (100 - 300 range)
    const count = Math.floor(Math.random() * 141) + 120;
    const bots: LiveBet[] = [];
    const usedNames = new Set<string>();

    for (let i = 0; i < count; i++) {
      let name = this.generateUniqueName(i);
      let attempts = 0;
      while (usedNames.has(name) && attempts < 10) {
        name = `${NAME_PREFIXES[Math.floor(Math.random() * NAME_PREFIXES.length)]}_${Math.floor(Math.random() * 900 + 100)}`;
        attempts++;
      }
      usedNames.add(name);

      // Bet amounts: 65% smaller ($5-$50), 25% medium ($60-$250), 10% high-rollers ($300-$2000)
      const rollAmount = Math.random();
      let bet: number;
      if (rollAmount < 0.65) {
        bet = [5, 10, 15, 20, 25, 30, 40, 50][Math.floor(Math.random() * 8)];
      } else if (rollAmount < 0.90) {
        bet = [60, 75, 100, 150, 200, 250][Math.floor(Math.random() * 6)];
      } else {
        bet = [300, 500, 750, 1000, 1500, 2000][Math.floor(Math.random() * 6)];
      }

      // Target multiplier distribution:
      // 40% safe (1.10x - 1.95x)
      // 35% medium (2.00x - 4.50x)
      // 15% bold (4.50x - 12.00x)
      // 10% risky (12.00x - 40.00x)
      const rollTarget = Math.random();
      let target: number;
      if (rollTarget < 0.40) {
        target = 1.10 + Math.random() * 0.85;
      } else if (rollTarget < 0.75) {
        target = 2.00 + Math.random() * 2.50;
      } else if (rollTarget < 0.90) {
        target = 4.50 + Math.random() * 7.50;
      } else {
        target = 12.00 + Math.random() * 28.00;
      }

      bots.push({
        id: `bot_${i}_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        name,
        bet,
        targetMultiplier: parseFloat(target.toFixed(2)),
        cashedOut: false,
      });
    }

    return bots;
  }

  private startCountdown() {
    // If a pool update was staged during the previous flight, commit it now before the new round begins!
    if (this.pendingGlobalPool !== null) {
      this.globalPool = this.pendingGlobalPool;
      this.logger.log(`🚀 Applied staged pool to Global Pool for new round: LKR ${this.globalPool}`);
      this.pendingGlobalPool = null;
      try {
        this.redisService.set('game:global_pool', this.globalPool.toString());
        this.redisService.del('game:pending_global_pool');
      } catch (err) {
        this.logger.warn('Failed to persist new global pool on round start', err);
      }
      if (this.server) {
        this.server.emit('globalPoolUpdated', {
          globalPool: this.globalPool,
          pendingGlobalPool: null,
          timestamp: Date.now(),
        });
      }
    }

    this.status = GameStatus.WAITING;
    this.countdown = 10;
    this.targetStartTime = Date.now() + 10000;
    this.currentMultiplier = 1.0;
    this.activeRealLiability = 0; // Reset for the new round
    
    // Generate pool of 120 - 260 bots
    const allBots = this.generateRoundBots();
    // Seed initial 15-20 early bets so list starts bustling
    const initialCount = Math.floor(Math.random() * 8) + 14;
    this.currentRoundBets = allBots.slice(0, initialCount);
    this.pendingRoundBots = allBots.slice(initialCount);

    this.logger.log(`Starting countdown. Initial bets: ${this.currentRoundBets.length}, Total targeted: ${allBots.length}`);
    this.broadcastState(true); // Broadcast initial state WITH initial bets

    if (this.timer) clearInterval(this.timer);
    if (this.botStreamTimer) clearInterval(this.botStreamTimer);

    // Stream incoming batches every 350ms to simulate a packed, lively casino room
    this.botStreamTimer = setInterval(() => {
      if (this.status === GameStatus.WAITING && this.pendingRoundBots.length > 0) {
        // Stream batches of 4 - 10 bets per burst
        const batchSize = Math.min(
          this.pendingRoundBots.length,
          Math.floor(Math.random() * 7) + 4
        );
        const batch = this.pendingRoundBots.splice(0, batchSize);
        if (batch.length > 0) {
          this.currentRoundBets.push(...batch);
          if (this.server) {
            this.server.emit('newLiveBetsBatch', batch);
          }
        }
      } else if (this.pendingRoundBots.length === 0 && this.botStreamTimer) {
        clearInterval(this.botStreamTimer);
      }
    }, 350);

    this.timer = setInterval(() => {
      this.countdown--;
      this.broadcastState(false); // Broadcast lightweight countdown tick (no heavy bets array)
      
      // Flush any remaining pending bots so everyone is in right before flight
      if (this.countdown <= 1) {
        if (this.pendingRoundBots.length > 0) {
          const remainingBatch = this.pendingRoundBots.splice(0);
          this.currentRoundBets.push(...remainingBatch);
          if (this.server) {
            this.server.emit('newLiveBetsBatch', remainingBatch);
          }
        }
      }

      if (this.countdown <= 0) {
        clearInterval(this.timer!);
        if (this.botStreamTimer) clearInterval(this.botStreamTimer);
        this.startGame();
      }
    }, 1000);
  }

  private startGame() {
    this.status = GameStatus.PLAYING;
    this.crashPoint = this.generateCrashPoint();
    this.currentMultiplier = 1.0;
    this.startTime = Date.now();
    this.flightTickCount = 0;
    
    // Schedule dramatic close-call auto cashout points for any active marketing bets
    for (const mBet of this.activeMarketingAutoWinBets) {
      const winFactor = 0.82 + Math.random() * 0.08; // 82% to 90% of crash multiplier
      mBet.targetAutoCashout = Math.max(1.20, parseFloat((this.crashPoint * winFactor).toFixed(2)));
      this.logger.log(`[Marketing] Auto-Win scheduled for ${mBet.username} at ${mBet.targetAutoCashout}x (Crash: ${this.crashPoint}x)`);
    }

    if (this.botStreamTimer) clearInterval(this.botStreamTimer);
    // Ensure all pending bets are in
    if (this.pendingRoundBots.length > 0) {
      this.currentRoundBets.push(...this.pendingRoundBots.splice(0));
    }

    this.logger.log(`Game started. Total bets: ${this.currentRoundBets.length}, Crash point: ${this.crashPoint}`);
    
    // Broadcast the START event so clients can begin animation syncing to startTime
    this.broadcastState(false);

    if (this.gameLoopTimer) clearInterval(this.gameLoopTimer);
    
    // Server checks for crash condition and bot cashouts 20 times a second
    this.gameLoopTimer = setInterval(() => {
      const elapsedSeconds = (Date.now() - this.startTime) / 1000;
      // Industry standard smooth exponential progression: e^(0.095 * t) (~7.3s to reach 2.00x)
      this.currentMultiplier = Math.max(1.0, Math.exp(0.095 * elapsedSeconds));

      this.flightTickCount++;
      // Every 250ms (5 ticks of 50ms), emit lightweight flight sync heartbeat
      if (this.flightTickCount % 5 === 0 && this.server) {
        this.server.emit('flightSync', {
          multiplier: parseFloat(this.currentMultiplier.toFixed(2)),
          elapsedSeconds: parseFloat(elapsedSeconds.toFixed(2)),
          startTime: this.startTime,
          serverTime: Date.now(),
        });
      }

      // Check for bot cashouts
      for (const bot of this.currentRoundBets) {
        if (!bot.cashedOut && this.currentMultiplier >= bot.targetMultiplier && bot.targetMultiplier < this.crashPoint) {
          bot.cashedOut = true;
          bot.cashedOutMultiplier = bot.targetMultiplier;
          const winAmount = parseFloat((bot.bet * bot.cashedOutMultiplier).toFixed(2));
          
          if (this.server) {
            this.server.emit('betCashedOut', {
              id: bot.id,
              multiplier: bot.cashedOutMultiplier,
              winAmount,
            });
          }
        }
      }

      // Check for marketing auto-win cashouts (guaranteed win before crash)
      if (this.activeMarketingAutoWinBets.length > 0) {
        for (let i = this.activeMarketingAutoWinBets.length - 1; i >= 0; i--) {
          const mBet = this.activeMarketingAutoWinBets[i];
          if (mBet.targetAutoCashout && this.currentMultiplier >= mBet.targetAutoCashout && this.currentMultiplier < this.crashPoint) {
            this.activeMarketingAutoWinBets.splice(i, 1);
            const cashoutMultiplier = parseFloat(this.currentMultiplier.toFixed(2));
            this.logger.log(`[Marketing] Triggering auto-cashout for ${mBet.username} at ${cashoutMultiplier}x`);
            if (this.marketingAutoCashoutCallback) {
              this.marketingAutoCashoutCallback(mBet.userId, mBet.betIndex, cashoutMultiplier).catch(err => {
                this.logger.error(`[Marketing] Error executing auto-cashout for ${mBet.username}`, err);
              });
            }
          }
        }
      }

      // Dynamic Liability Crash Logic (Pool-based constraint)
      if (this.activeRealLiability > 0) {
        const potentialPayout = this.activeRealLiability * this.currentMultiplier;
        if (potentialPayout >= this.globalPool) {
          this.logger.warn(`Forced Crash! Potential payout (${potentialPayout}) exceeds global pool (${this.globalPool})`);
          this.crashPoint = this.currentMultiplier;
          this.crash();
          return;
        }
      }

      if (this.currentMultiplier >= this.crashPoint) {
        this.crash();
      }
    }, 50); 
  }

  private crash() {
    if (this.gameLoopTimer) clearInterval(this.gameLoopTimer);
    
    this.status = GameStatus.CRASHED;
    this.currentMultiplier = this.crashPoint;
    
    this.logger.log(`Crashed at ${this.crashPoint}`);
    this.broadcastState(false);

    // Trigger crash callbacks for authoritative round settlement
    for (const cb of this.crashCallbacks) {
      try {
        cb(this.crashPoint);
      } catch (err) {
        this.logger.error('Error executing crash callback', err);
      }
    }

    // Wait 3 seconds before next round
    setTimeout(() => {
      this.startCountdown();
    }, 3000);
  }

  private generateCrashPoint(): number {
    // If an active marketing auto-win bet is present in this round, guarantee high-thrill multiplier (2.80x - 14.50x)
    if (this.activeMarketingAutoWinBets.length > 0) {
      const promoPoint = 2.80 + Math.random() * 11.70;
      this.logger.log(`[Marketing] Active marketing auto-win bet present: set promotional crash point to ${promoPoint.toFixed(2)}x`);
      return parseFloat(promoPoint.toFixed(2));
    }

    // 3-Tier Bait System (When no real bets are active)
    if (this.activeRealLiability === 0) {
      const rand = Math.random();
      if (rand < 0.15) {
        // 15% chance for Super FOMO (10x - 100x)
        const fomoPoint = 10 + Math.random() * 90;
        return parseFloat(fomoPoint.toFixed(2));
      } else if (rand < 0.60) {
        // 45% chance for Mid-Bait (2.0x - 10.0x)
        const midPoint = 2.0 + Math.random() * 8.0;
        return parseFloat(midPoint.toFixed(2));
      } else {
        // 40% chance for Normal Low (1.01x - 2.0x)
        const lowPoint = 1.01 + Math.random() * 0.99;
        return parseFloat(lowPoint.toFixed(2));
      }
    }

    // High-Margin 30% Player Win / 70% House Edge Distribution (When real bets are active)
    const rand = Math.random();
    if (rand < 0.70) {
      // 70% House Win Zone: Plane crashes early (1.00x - 1.45x)
      // Sub-tier: 8% Instant Crash (1.00x - 1.08x) to neutralize micro-scraping bots
      if (rand < 0.08) {
        const instantCrash = 1.00 + Math.random() * 0.08;
        return parseFloat(instantCrash.toFixed(2));
      }
      const lowPoint = 1.09 + Math.random() * 0.36; // 1.09x - 1.45x (breaks 1.50x+ targets)
      return parseFloat(lowPoint.toFixed(2));
    } else if (rand < 0.95) {
      // 25% Mid Win Zone: Multiplier 1.50x - 3.80x (sustains player engagement)
      const midPoint = 1.50 + Math.random() * 2.30;
      return parseFloat(midPoint.toFixed(2));
    } else {
      // 5% High Thrill / Jackpot Zone: Multiplier 4.00x - 25.00x
      const highPoint = 4.00 + Math.random() * 21.00;
      return parseFloat(highPoint.toFixed(2));
    }
  }

  private broadcastState(includeFullBets: boolean = true) {
    if (this.server) {
      this.server.emit('gameState', this.getGameState(includeFullBets));
    }
  }

  public getGameState(includeFullBets: boolean = true) {
    return {
      status: this.status,
      countdown: this.countdown,
      targetStartTime: this.targetStartTime,
      currentMultiplier: parseFloat(this.currentMultiplier.toFixed(2)),
      startTime: this.startTime,
      crashPoint: this.status === GameStatus.CRASHED ? this.crashPoint : null,
      serverTime: Date.now(),
      bets: includeFullBets ? this.currentRoundBets : null,
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
      const email = typeof target === 'object' ? target?.email : undefined;
      const userId = typeof target === 'object' ? target?.id : undefined;

      this.server.emit('userBalanceUpdated', {
        username,
        email,
        userId,
        balance,
        currency,
        message: message || 'Your wallet balance has been updated.',
        timestamp: Date.now(),
      });
    }
  }

  public notifyNewDeposit(deposit: any) {
    if (this.server) {
      this.server.emit('newDepositSubmitted', {
        deposit,
        timestamp: Date.now(),
      });
    }
  }

  public notifyNewWithdrawal(withdrawal: any) {
    if (this.server) {
      this.server.emit('newWithdrawalSubmitted', {
        withdrawal,
        timestamp: Date.now(),
      });
    }
  }
}
