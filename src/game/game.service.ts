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

const BOT_NAMES = [
  'alex_99', 'sky_king', 'johnd**', 'aviator_pro', 'kasun_lk',
  'crypto_whale', 'lucky_girl', 'bet_master', 'sam_fly', 'speedy',
  'elena_r', 'highroller', 'noob_01', 'pro_pilot', 'user883',
  'alpha_dog', 'queen_7', 'ace_flyer', 'zenith', 'rocket_man',
  'vortex', 'falcon', 'shadow_99', 'neo_matrix', 'phoenix',
  'golden_boy', 'viper', 'matrix_7', 'hazard', 'star_rider'
];

const BET_AMOUNTS = [5, 10, 15, 20, 25, 50, 75, 100, 150, 200, 300, 500, 1000];

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
  private currentRoundBets: LiveBet[] = [];

  public setServer(server: Server) {
    this.server = server;
    // Start the game loop when server is attached
    if (this.status === GameStatus.WAITING && this.countdown === 10) {
      this.startCountdown();
    }
  }

  private generateRoundBots(): LiveBet[] {
    const shuffled = [...BOT_NAMES].sort(() => 0.5 - Math.random());
    const count = Math.floor(Math.random() * 7) + 14; // 14 to 20 bots per round
    const selected = shuffled.slice(0, count);

    return selected.map((name, index) => {
      const bet = BET_AMOUNTS[Math.floor(Math.random() * BET_AMOUNTS.length)];
      
      // Target multiplier distribution:
      // 40% safe (1.10x - 1.95x)
      // 35% medium (2.00x - 4.50x)
      // 15% bold (4.50x - 12.00x)
      // 10% risky (12.00x - 40.00x)
      const roll = Math.random();
      let target: number;
      if (roll < 0.40) {
        target = 1.10 + Math.random() * 0.85;
      } else if (roll < 0.75) {
        target = 2.00 + Math.random() * 2.50;
      } else if (roll < 0.90) {
        target = 4.50 + Math.random() * 7.50;
      } else {
        target = 12.00 + Math.random() * 28.00;
      }

      return {
        id: `bot_${index}_${Date.now()}`,
        name,
        bet,
        targetMultiplier: parseFloat(target.toFixed(2)),
        cashedOut: false,
      };
    });
  }

  private startCountdown() {
    this.status = GameStatus.WAITING;
    this.countdown = 10;
    this.currentMultiplier = 1.0;
    this.currentRoundBets = this.generateRoundBots();
    
    this.logger.log(`Starting countdown with ${this.currentRoundBets.length} live bets...`);
    this.broadcastState();

    if (this.timer) clearInterval(this.timer);
    
    this.timer = setInterval(() => {
      this.countdown--;
      this.broadcastState(); // Broadcast every second during countdown
      
      if (this.countdown <= 0) {
        clearInterval(this.timer!);
        this.startGame();
      }
    }, 1000);
  }

  private startGame() {
    this.status = GameStatus.PLAYING;
    this.crashPoint = this.generateCrashPoint();
    this.currentMultiplier = 1.0;
    this.startTime = Date.now();
    
    this.logger.log(`Game started. Crash point is ${this.crashPoint}`);
    
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
}
