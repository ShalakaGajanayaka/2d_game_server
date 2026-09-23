import { Injectable, BadRequestException, UnauthorizedException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { RedisService } from '../redis/redis.service';
import { User } from './entities/user.entity';
import { Transaction } from './entities/transaction.entity';

export interface UserProfile {
  id: string;
  username: string;
  phoneNumber?: string;
  currency: string;
  balance: number;
  gamesPlayed: number;
  totalWon: number;
  bestMultiplier: number;
  createdAt: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    private readonly redisService: RedisService,
  ) {}

  private generateToken(): string {
    return crypto.randomBytes(24).toString('hex');
  }

  private sanitizeUser(user: User): UserProfile {
    return {
      id: user.id,
      username: user.username,
      phoneNumber: user.phoneNumber || user.username,
      currency: user.currency || 'USD',
      balance: Number(user.balance),
      gamesPlayed: Number(user.gamesPlayed),
      totalWon: Number(user.totalWon),
      bestMultiplier: Number(user.bestMultiplier),
      createdAt: user.createdAt ? new Date(user.createdAt).getTime() : Date.now(),
    };
  }

  async register(identifier: string, password: string, currency?: string): Promise<{ token: string; user: UserProfile }> {
    const clean = identifier?.trim().replace(/\s+/g, '');
    if (!clean || clean.length < 3) {
      throw new BadRequestException('Please enter a valid mobile number');
    }
    if (!password || password.length < 4) {
      throw new BadRequestException('Password must be at least 4 characters long');
    }

    const cleanCurrency = (currency?.trim().toUpperCase() || 'USD').slice(0, 10);

    // Check if user already exists in PostgreSQL
    const existing = await this.userRepository.findOne({
      where: [{ username: clean.toLowerCase() }, { phoneNumber: clean }],
    });
    if (existing) {
      throw new BadRequestException('Mobile number is already registered. Please sign in.');
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(password, 10);

    const newUser = this.userRepository.create({
      username: clean.toLowerCase(),
      phoneNumber: clean,
      passwordHash,
      currency: cleanCurrency,
      balance: 1000.0, // Welcome balance
      gamesPlayed: 0,
      totalWon: 0.0,
      bestMultiplier: 1.0,
    });

    const savedUser = await this.userRepository.save(newUser);

    // Record welcome bonus transaction in PostgreSQL ledger
    try {
      await this.transactionRepository.save({
        userId: savedUser.id,
        type: 'DEPOSIT',
        amount: 1000.0,
        currency: cleanCurrency,
        multiplier: null,
        balanceAfter: 1000.0,
      });
    } catch (err) {
      this.logger.warn('Failed to log welcome deposit transaction', err);
    }

    const token = this.generateToken();

    // Cache session and user in Redis for high-speed retrieval
    try {
      await this.redisService.set(`token:${token}`, clean.toLowerCase(), 86400 * 7); // 7 days TTL
      await this.redisService.set(`user:${clean.toLowerCase()}`, JSON.stringify(this.sanitizeUser(savedUser)));
    } catch (err) {
      this.logger.warn('Failed to cache user in Redis', err);
    }

    return {
      token,
      user: this.sanitizeUser(savedUser),
    };
  }

  async login(identifier: string, password: string): Promise<{ token: string; user: UserProfile }> {
    const clean = identifier?.trim().replace(/\s+/g, '');
    if (!clean || !password) {
      throw new BadRequestException('Mobile number and password are required');
    }

    // Build candidate identifiers for flexible mobile number and username lookup
    const candidates = [clean.toLowerCase(), clean];
    if (clean.startsWith('0') && clean.length === 10) {
      // Local 10-digit Sri Lankan format (e.g. 0771234567 -> +94771234567)
      candidates.push(`+94${clean.slice(1)}`);
    } else if (!clean.startsWith('+') && clean.length === 9) {
      // 9 digits without leading 0 (e.g. 771234567 -> +94771234567)
      candidates.push(`+94${clean}`);
    } else if (clean.startsWith('+940')) {
      // In case typed +94077...
      candidates.push(`+94${clean.slice(4)}`);
    }

    // Find user in PostgreSQL by username OR phoneNumber across candidate formats
    const whereConditions = candidates.flatMap((c) => [
      { username: c.toLowerCase() },
      { phoneNumber: c },
    ]);

    const user = await this.userRepository.findOne({
      where: whereConditions,
    });
    if (!user) {
      throw new UnauthorizedException('Invalid mobile number or password');
    }

    // Verify password with bcrypt (with sha256 fallback if previously hashed)
    let isMatch = false;
    try {
      isMatch = await bcrypt.compare(password, user.passwordHash);
    } catch {
      isMatch = false;
    }

    if (!isMatch) {
      const sha256Hash = crypto.createHash('sha256').update(password).digest('hex');
      if (sha256Hash === user.passwordHash) {
        isMatch = true;
        // Upgrade password hash to bcrypt in background
        user.passwordHash = await bcrypt.hash(password, 10);
        await this.userRepository.save(user);
      }
    }

    if (!isMatch) {
      throw new UnauthorizedException('Invalid username or password');
    }

    const token = this.generateToken();

    // Cache session in Redis
    try {
      await this.redisService.set(`token:${token}`, user.username, 86400 * 7);
      await this.redisService.set(`user:${user.username}`, JSON.stringify(this.sanitizeUser(user)));
    } catch {}

    return {
      token,
      user: this.sanitizeUser(user),
    };
  }

  async getProfile(token: string): Promise<UserProfile> {
    let username: string | null = null;
    try {
      username = await this.redisService.get(`token:${token}`);
    } catch {}

    if (!username) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const user = await this.userRepository.findOne({ where: { username } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.sanitizeUser(user);
  }

  async updateBalance(
    token: string,
    newBalance: number,
    winDelta?: number,
    mult?: number,
  ): Promise<{ success: boolean; balance: number; user: UserProfile }> {
    let username: string | null = null;
    try {
      username = await this.redisService.get(`token:${token}`);
    } catch {}

    if (!username) {
      throw new UnauthorizedException('Session expired');
    }

    const user = await this.userRepository.findOne({ where: { username } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const oldBalance = Number(user.balance);
    const balanceNum = Math.max(0, Number(newBalance));
    user.balance = balanceNum;

    let txType = 'UPDATE';
    if (winDelta !== undefined) {
      user.gamesPlayed = Number(user.gamesPlayed) + 1;
      if (winDelta > 0) {
        user.totalWon = Number(user.totalWon) + winDelta;
        txType = 'CASHOUT';
      } else {
        txType = 'BET';
      }
    } else if (balanceNum > oldBalance) {
      txType = 'DEPOSIT';
    } else if (balanceNum < oldBalance) {
      txType = 'BET';
    }

    if (mult && mult > Number(user.bestMultiplier)) {
      user.bestMultiplier = mult;
    }

    const savedUser = await this.userRepository.save(user);

    // Record transaction in PostgreSQL ledger
    const diff = Math.abs(balanceNum - oldBalance);
    if (diff > 0.001) {
      try {
        await this.transactionRepository.save({
          userId: savedUser.id,
          type: txType,
          amount: diff,
          currency: savedUser.currency || 'USD',
          multiplier: mult ?? null,
          balanceAfter: balanceNum,
        });
      } catch (err) {
        this.logger.error('Failed to save transaction ledger', err);
      }
    }

    // Refresh Redis cache
    const sanitized = this.sanitizeUser(savedUser);
    try {
      await this.redisService.set(`user:${username}`, JSON.stringify(sanitized));
    } catch {}

    return {
      success: true,
      balance: sanitized.balance,
      user: sanitized,
    };
  }
}
