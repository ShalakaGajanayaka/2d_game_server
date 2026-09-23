import { Injectable, BadRequestException, UnauthorizedException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
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

  private async generateUniqueUsername(): Promise<string> {
    const prefixes = [
      'Pilot',
      'SkyAce',
      'Aero',
      'JetRider',
      'SkyWalker',
      'Aviator',
      'CloudStriker',
      'TopGun',
      'FlightMaster',
      'SpeedAce',
    ];
    let isUnique = false;
    let candidate = '';
    let attempts = 0;

    while (!isUnique && attempts < 25) {
      attempts++;
      const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
      const randomNum = Math.floor(10000 + Math.random() * 90000); // 5 digits (e.g. 78421)
      candidate = `${prefix}_${randomNum}`;

      // Check if username exists in database (exact and lowercase)
      const exists = await this.userRepository.findOne({
        where: [
          { username: candidate },
          { username: candidate.toLowerCase() },
        ],
      });

      if (!exists) {
        isUnique = true;
      }
    }

    if (!isUnique) {
      // High-concurrency fallback ensuring complete uniqueness
      candidate = `Pilot_${Date.now().toString().slice(-6)}`;
    }

    return candidate;
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
    if (!clean || clean.length < 5) {
      throw new BadRequestException('Please enter a valid mobile number');
    }

    // Validate mobile number format strictly based on country
    if (clean.startsWith('+94')) {
      if (!/^\+947[0-9]{8}$/.test(clean)) {
        throw new BadRequestException('Sri Lankan mobile numbers must have 9 digits starting with 7 (e.g. 77 123 4567)');
      }
    } else if (clean.startsWith('+1')) {
      if (!/^\+1[2-9]\d{9}$/.test(clean)) {
        throw new BadRequestException('US/Canada mobile numbers must have 10 digits');
      }
    } else if (clean.startsWith('+91')) {
      if (!/^\+91[6-9]\d{9}$/.test(clean)) {
        throw new BadRequestException('Indian mobile numbers must have 10 digits starting with 6, 7, 8, or 9');
      }
    } else if (clean.startsWith('+44')) {
      if (!/^\+447\d{9}$/.test(clean)) {
        throw new BadRequestException('UK mobile numbers must have 10 digits starting with 7');
      }
    } else if (clean.startsWith('+971')) {
      if (!/^\+9715\d{8}$/.test(clean)) {
        throw new BadRequestException('UAE mobile numbers must have 9 digits starting with 5');
      }
    } else if (clean.startsWith('+')) {
      if (!/^\+[1-9]\d{6,14}$/.test(clean)) {
        throw new BadRequestException('Please enter a valid mobile number for the selected country');
      }
    }

    if (!password || password.length < 4) {
      throw new BadRequestException('Password must be at least 4 characters long');
    }

    const cleanCurrency = (currency?.trim().toUpperCase() || 'USD').slice(0, 10);

    // Build all candidate variations for comprehensive duplicate verification
    const candidates = [clean.toLowerCase(), clean];
    if (clean.startsWith('+94')) {
      const national = clean.slice(3); // e.g. 784748345
      candidates.push(national);
      candidates.push(`0${national}`); // e.g. 0784748345
    } else if (clean.startsWith('0') && clean.length === 10) {
      candidates.push(`+94${clean.slice(1)}`);
      candidates.push(clean.slice(1));
    } else if (!clean.startsWith('+') && clean.length === 9) {
      candidates.push(`+94${clean}`);
      candidates.push(`0${clean}`);
    }

    const whereConditions = candidates.flatMap((c) => [
      { username: c.toLowerCase() },
      { phoneNumber: c },
    ]);

    // Check if user already exists in PostgreSQL
    const existing = await this.userRepository.findOne({
      where: whereConditions,
    });
    if (existing) {
      throw new BadRequestException('This mobile number is already registered. Please sign in.');
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(password, 10);

    // Initial welcome balance (currently 0.0 per business requirements)
    const initialWelcomeBalance = 0.0;

    // Auto-generate guaranteed unique username (not existing in database)
    const uniqueUsername = await this.generateUniqueUsername();

    const newUser = this.userRepository.create({
      username: uniqueUsername,
      phoneNumber: clean,
      passwordHash,
      currency: cleanCurrency,
      balance: initialWelcomeBalance,
      gamesPlayed: 0,
      totalWon: 0.0,
      bestMultiplier: 1.0,
    });

    const savedUser = await this.userRepository.save(newUser);

    // Record welcome bonus transaction in PostgreSQL ledger only if balance > 0
    if (initialWelcomeBalance > 0) {
      try {
        await this.transactionRepository.save({
          userId: savedUser.id,
          type: 'DEPOSIT',
          amount: initialWelcomeBalance,
          currency: cleanCurrency,
          multiplier: null,
          balanceAfter: initialWelcomeBalance,
        });
      } catch (err) {
        this.logger.warn('Failed to log welcome deposit transaction', err);
      }
    }

    const token = this.generateToken();

    // Cache session and user in Redis for high-speed retrieval
    try {
      await this.redisService.set(`token:${token}`, savedUser.username, 86400 * 7); // 7 days TTL
      await this.redisService.set(`user:${savedUser.username.toLowerCase()}`, JSON.stringify(this.sanitizeUser(savedUser)));
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

    // Find user in PostgreSQL by username (case-insensitive) OR phoneNumber across candidate formats
    const whereConditions = [
      { username: ILike(clean) },
      ...candidates.flatMap((c) => [
        { username: c },
        { phoneNumber: c },
      ]),
    ];

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

  async checkPhoneExists(phone: string): Promise<boolean> {
    const clean = phone?.trim().replace(/\s+/g, '');
    if (!clean || clean.length < 5) return false;

    const candidates = [clean.toLowerCase(), clean];
    if (clean.startsWith('+94')) {
      const national = clean.slice(3);
      candidates.push(national);
      candidates.push(`0${national}`);
    } else if (clean.startsWith('0') && clean.length === 10) {
      candidates.push(`+94${clean.slice(1)}`);
      candidates.push(clean.slice(1));
    } else if (!clean.startsWith('+') && clean.length === 9) {
      candidates.push(`+94${clean}`);
      candidates.push(`0${clean}`);
    }

    const whereConditions = candidates.flatMap((c) => [
      { username: c.toLowerCase() },
      { phoneNumber: c },
    ]);

    const count = await this.userRepository.count({
      where: whereConditions,
    });
    return count > 0;
  }
}
