import { Injectable, BadRequestException, UnauthorizedException, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { RedisService } from '../redis/redis.service';

export interface UserProfile {
  id: string;
  username: string;
  balance: number;
  gamesPlayed: number;
  totalWon: number;
  bestMultiplier: number;
  createdAt: number;
}

interface StoredUser extends UserProfile {
  passwordHash: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  // In-memory fallback in case Redis is restarting or in local mode
  private readonly memoryUsers = new Map<string, StoredUser>();
  private readonly memoryTokens = new Map<string, string>(); // token -> username

  constructor(private readonly redisService: RedisService) {}

  private hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password).digest('hex');
  }

  private generateToken(): string {
    return crypto.randomBytes(24).toString('hex');
  }

  private sanitizeUser(stored: StoredUser): UserProfile {
    const { passwordHash, ...profile } = stored;
    return profile;
  }

  async register(username: string, password: string): Promise<{ token: string; user: UserProfile }> {
    const cleanUsername = username?.trim().toLowerCase();
    if (!cleanUsername || cleanUsername.length < 3) {
      throw new BadRequestException('Username must be at least 3 characters long');
    }
    if (!password || password.length < 4) {
      throw new BadRequestException('Password must be at least 4 characters long');
    }

    // Check if user already exists
    let existingRaw: string | null = null;
    try {
      existingRaw = await this.redisService.get(`user:${cleanUsername}`);
    } catch {
      // fallback
    }

    if (existingRaw || this.memoryUsers.has(cleanUsername)) {
      throw new BadRequestException('Username already taken. Please choose another.');
    }

    const newUser: StoredUser = {
      id: `usr_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      username: cleanUsername,
      passwordHash: this.hashPassword(password),
      balance: 1000.0, // Welcome balance
      gamesPlayed: 0,
      totalWon: 0.0,
      bestMultiplier: 1.0,
      createdAt: Date.now(),
    };

    // Save to memory
    this.memoryUsers.set(cleanUsername, newUser);

    // Save to Redis
    try {
      await this.redisService.set(`user:${cleanUsername}`, JSON.stringify(newUser));
    } catch (err) {
      this.logger.warn('Could not save user to Redis, used memory fallback', err);
    }

    const token = this.generateToken();
    this.memoryTokens.set(token, cleanUsername);
    try {
      await this.redisService.set(`token:${token}`, cleanUsername, 86400 * 7); // 7 days TTL
    } catch {}

    return {
      token,
      user: this.sanitizeUser(newUser),
    };
  }

  async login(username: string, password: string): Promise<{ token: string; user: UserProfile }> {
    const cleanUsername = username?.trim().toLowerCase();
    if (!cleanUsername || !password) {
      throw new BadRequestException('Username and password are required');
    }

    let storedUser: StoredUser | null = null;
    try {
      const raw = await this.redisService.get(`user:${cleanUsername}`);
      if (raw) {
        storedUser = JSON.parse(raw) as StoredUser;
      }
    } catch {}

    if (!storedUser) {
      storedUser = this.memoryUsers.get(cleanUsername) || null;
    }

    if (!storedUser) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const inputHash = this.hashPassword(password);
    if (storedUser.passwordHash !== inputHash) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const token = this.generateToken();
    this.memoryTokens.set(token, cleanUsername);
    try {
      await this.redisService.set(`token:${token}`, cleanUsername, 86400 * 7);
    } catch {}

    return {
      token,
      user: this.sanitizeUser(storedUser),
    };
  }

  async getProfile(token: string): Promise<UserProfile> {
    if (!token) {
      throw new UnauthorizedException('Authentication token missing');
    }

    let username: string | null = null;
    try {
      username = await this.redisService.get(`token:${token}`);
    } catch {}

    if (!username) {
      username = this.memoryTokens.get(token) || null;
    }

    if (!username) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    let storedUser: StoredUser | null = null;
    try {
      const raw = await this.redisService.get(`user:${username}`);
      if (raw) storedUser = JSON.parse(raw);
    } catch {}

    if (!storedUser) {
      storedUser = this.memoryUsers.get(username) || null;
    }

    if (!storedUser) {
      throw new UnauthorizedException('User not found');
    }

    return this.sanitizeUser(storedUser);
  }

  async updateBalance(
    token: string,
    balance: number,
    winDelta: number = 0,
    mult: number = 0,
  ): Promise<{ balance: number }> {
    if (!token) throw new UnauthorizedException('Token required');

    let username: string | null = null;
    try {
      username = await this.redisService.get(`token:${token}`);
    } catch {}

    if (!username) username = this.memoryTokens.get(token) || null;
    if (!username) throw new UnauthorizedException('Invalid token');

    let storedUser: StoredUser | null = null;
    try {
      const raw = await this.redisService.get(`user:${username}`);
      if (raw) storedUser = JSON.parse(raw);
    } catch {}

    if (!storedUser) storedUser = this.memoryUsers.get(username) || null;
    if (!storedUser) throw new UnauthorizedException('User not found');

    storedUser.balance = parseFloat(balance.toFixed(2));
    if (winDelta > 0) {
      storedUser.totalWon = parseFloat((storedUser.totalWon + winDelta).toFixed(2));
      storedUser.gamesPlayed += 1;
      if (mult > storedUser.bestMultiplier) {
        storedUser.bestMultiplier = parseFloat(mult.toFixed(2));
      }
    }

    this.memoryUsers.set(username, storedUser);
    try {
      await this.redisService.set(`user:${username}`, JSON.stringify(storedUser));
    } catch {}

    return { balance: storedUser.balance };
  }
}
