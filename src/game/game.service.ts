import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

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
export class GameService {
  private readonly logger = new Logger(GameService.name);
  private server: Server;
  
  private status: GameStatus = GameStatus.WAITING;
  private countdown: number = 10;
  private currentMultiplier: number = 1.0;
  private crashPoint: number = 1.0;
  private startTime: number = 0;
  private timer: NodeJS.Timeout | null = null;
  private gameLoopTimer: NodeJS.Timeout | null = null;
  private botStreamTimer: NodeJS.Timeout | null = null;
  private currentRoundBets: LiveBet[] = [];
  private pendingRoundBots: LiveBet[] = [];

  // Company virtual pool variables
  private globalPool: number = 10000;
  private activeRealLiability: number = 0;
  private companyProfitMargin: number = 0.3; // 30%

  public setServer(server: Server) {
    this.server = server;
    // Start the game loop when server is attached
    if (this.status === GameStatus.WAITING && this.countdown === 10) {
      this.startCountdown();
    }
  }

  public registerRealBet(amount: number) {
    if (this.status === GameStatus.WAITING) {
      this.globalPool += amount * (1 - this.companyProfitMargin);
      this.activeRealLiability += amount;
      this.logger.log(`Real bet added: ${amount}. Pool: ${this.globalPool}, Liability: ${this.activeRealLiability}`);
    }
  }

  public registerRealCashout(betAmount: number, winAmount: number) {
    if (this.status === GameStatus.PLAYING) {
      this.activeRealLiability -= betAmount;
      this.globalPool -= winAmount;
      this.logger.log(`Real cashout: Bet ${betAmount}, Win ${winAmount}. Pool: ${this.globalPool}, Liability: ${this.activeRealLiability}`);
    }
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
    this.status = GameStatus.WAITING;
    this.countdown = 10;
    this.currentMultiplier = 1.0;
    this.activeRealLiability = 0; // Reset for the new round
    
    // Generate pool of 120 - 260 bots
    const allBots = this.generateRoundBots();
    // Seed initial 15-20 early bets so list starts bustling
    const initialCount = Math.floor(Math.random() * 8) + 14;
    this.currentRoundBets = allBots.slice(0, initialCount);
    this.pendingRoundBots = allBots.slice(initialCount);

    this.logger.log(`Starting countdown. Initial bets: ${this.currentRoundBets.length}, Total targeted: ${allBots.length}`);
    this.broadcastState();

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
      this.broadcastState(); // Broadcast every second during countdown
      
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
    
    if (this.botStreamTimer) clearInterval(this.botStreamTimer);
    // Ensure all pending bets are in
    if (this.pendingRoundBots.length > 0) {
      this.currentRoundBets.push(...this.pendingRoundBots.splice(0));
    }

    this.logger.log(`Game started. Total bets: ${this.currentRoundBets.length}, Crash point: ${this.crashPoint}`);
    
    // Broadcast the START event so clients can begin animation syncing to startTime
    this.broadcastState();

    if (this.gameLoopTimer) clearInterval(this.gameLoopTimer);
    
    // Server checks for crash condition and bot cashouts 20 times a second
    this.gameLoopTimer = setInterval(() => {
      const elapsedSeconds = (Date.now() - this.startTime) / 1000;
      // Formula matches flutter: 1.0 + (time^2.5) / 10
      this.currentMultiplier = 1.0 + Math.pow(elapsedSeconds, 2.5) / 10;

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
    this.broadcastState();

    // Wait 3 seconds before next round
    setTimeout(() => {
      this.startCountdown();
    }, 3000);
  }

  private generateCrashPoint(): number {
    const e = 100 / (Math.random() * 100 + 1);
    const point = Math.max(1.01, e);
    return parseFloat(point.toFixed(2));
  }

  private broadcastState() {
    if (this.server) {
      this.server.emit('gameState', this.getGameState());
    }
  }

  public getGameState() {
    return {
      status: this.status,
      countdown: this.countdown,
      currentMultiplier: this.currentMultiplier,
      startTime: this.startTime,
      bets: this.currentRoundBets,
    };
  }

  public notifyUserBalance(username: string, balance: number, message?: string) {
    if (this.server) {
      this.server.emit('userBalanceUpdated', {
        username,
        balance,
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
