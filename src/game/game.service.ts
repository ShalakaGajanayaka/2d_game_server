import { Injectable, Logger } from '@nestjs/common';
import { Server } from 'socket.io';

export enum GameStatus {
  WAITING = 'waiting',
  PLAYING = 'playing',
  CRASHED = 'crashed',
}

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

  public setServer(server: Server) {
    this.server = server;
    // Start the game loop when server is attached
    if (this.status === GameStatus.WAITING && this.countdown === 10) {
      this.startCountdown();
    }
  }

  private startCountdown() {
    this.status = GameStatus.WAITING;
    this.countdown = 10;
    this.currentMultiplier = 1.0;
    
    this.logger.log('Starting countdown...');
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
    
    // Server checks for crash condition 20 times a second
    this.gameLoopTimer = setInterval(() => {
      const elapsedSeconds = (Date.now() - this.startTime) / 1000;
      // Formula matches flutter: 1.0 + (time^2.5) / 10
      this.currentMultiplier = 1.0 + Math.pow(elapsedSeconds, 2.5) / 10;

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
    };
  }
}
