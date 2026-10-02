import { Injectable, BadRequestException, UnauthorizedException, ConflictException, HttpException, HttpStatus, Logger, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import * as geoip from 'geoip-lite';
import { RedisService } from '../redis/redis.service';
import { User } from './entities/user.entity';
import { Transaction } from './entities/transaction.entity';
import { BetHistory } from './entities/bet-history.entity';
import { GameService, GameStatus, GameRoomType } from '../game/game.service';

export const COUNTRY_TO_CURRENCY: Record<string, string> = {
  LK: 'LKR',
  US: 'USD',
  GB: 'GBP',
  IN: 'INR',
  AE: 'AED',
  AU: 'AUD',
  CA: 'CAD',
  SG: 'SGD',
  MY: 'MYR',
  QA: 'QAR',
  SA: 'SAR',
  JP: 'JPY',
  CN: 'CNY',
  NZ: 'NZD',
  CH: 'CHF',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', GR: 'EUR', IE: 'EUR', PT: 'EUR', FI: 'EUR',
  RU: 'RUB',
  BR: 'BRL',
  ZA: 'ZAR',
  KR: 'KRW',
  TH: 'THB',
  ID: 'IDR',
  PH: 'PHP',
  VN: 'VND',
  PK: 'PKR',
  BD: 'BDT',
  NP: 'NPR',
  KW: 'KWD',
  OM: 'OMR',
  BH: 'BHD',
  TR: 'TRY',
  EG: 'EGP',
  NG: 'NGN',
  KE: 'KES',
  GH: 'GHS',
  MX: 'MXN',
  CL: 'CLP',
  CO: 'COP',
  PE: 'PEN',
  AR: 'ARS',
};

export const TIMEZONE_TO_COUNTRY: Record<string, string> = {
  'asia/colombo': 'LK',
  'asia/kolkata': 'IN',
  'asia/calcutta': 'IN',
  'asia/dubai': 'AE',
  'asia/muscat': 'OM',
  'asia/qatar': 'QA',
  'asia/riyadh': 'SA',
  'asia/singapore': 'SG',
  'asia/kuala_lumpur': 'MY',
  'asia/bangkok': 'TH',
  'asia/jakarta': 'ID',
  'asia/manila': 'PH',
  'asia/tokyo': 'JP',
  'asia/seoul': 'KR',
  'asia/hong_kong': 'HK',
  'asia/dhaka': 'BD',
  'asia/karachi': 'PK',
  'asia/kathmandu': 'NP',
  'australia/sydney': 'AU',
  'australia/melbourne': 'AU',
  'europe/london': 'GB',
  'europe/paris': 'FR',
  'europe/berlin': 'DE',
  'europe/rome': 'IT',
  'europe/madrid': 'ES',
  'america/new_york': 'US',
  'america/los_angeles': 'US',
  'america/chicago': 'US',
  'america/toronto': 'CA',
  'america/vancouver': 'CA',
};

export const PLATFORM_EXCHANGE_RATES: Record<string, number> = {
  USD: 1.0,      // Reference base
  USDT: 1.0,     // 1:1 pegged with USD
  LKR: 300.0,    // 1 USD = 300 LKR
  INR: 85.0,     // 1 USD = 85 INR
  EUR: 0.92,     // 1 USD = 0.92 EUR
  GBP: 0.79,     // 1 USD = 0.79 GBP
  AED: 3.67,     // 1 USD = 3.67 AED
};

export interface UserProfile {
  id: string;
  username: string;
  email?: string;
  phoneNumber?: string;
  currency: string;
  balance: number; // Converted display balance for client presentation
  baseBalance: number; // Universal base USD balance in PostgreSQL
  exchangeRate: number; // Platform exchange rate applied against USD
  gamesPlayed: number;
  totalWon: number;
  bestMultiplier: number;
  createdAt: number;
  savedWithdrawalDetails?: any;
  isFrozen?: boolean;
  freezeReason?: string;
  isFlaggedForReview?: boolean;
  flaggedReason?: string;
  isMarketing?: boolean;
  isMarketingAutoWin?: boolean;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(BetHistory)
    private readonly betHistoryRepository: Repository<BetHistory>,
    private readonly redisService: RedisService,
    @Inject(forwardRef(() => GameService))
    private readonly gameService: GameService,
  ) {}

  onModuleInit() {
    this.gameService.registerCrashCallback((crashPoint: number, roomType: GameRoomType) => {
      this.handleRoundCrashed(crashPoint, roomType).catch(err => {
        this.logger.error(`Failed to handle round crash cleanup in AuthService for ${roomType}`, err);
      });
    });

    this.gameService.registerMarketingAutoCashoutCallback(async (userId: string, betIndex: number, multiplier: number) => {
      await this.executeMarketingAutoCashout(userId, betIndex, multiplier);
    });

    this.gameService.registerRoundStartCallback(async (roomType: GameRoomType) => {
      await this.activateQueuedBets(roomType);
    });
  }

  private generateToken(): string {
    return crypto.randomBytes(24).toString('hex');
  }

  private async createSession(token: string, user: User): Promise<void> {
    const TTL = 86400 * 7; // 7 days
    try {
      await this.redisService.set(`token:${token}`, user.username, TTL);
      await this.redisService.set(`token_user:${token}`, user.id, TTL);
      await this.redisService.sadd(`user_sessions:${user.id}`, token);
      await this.redisService.set(`user:${user.username.toLowerCase()}`, JSON.stringify(this.sanitizeUser(user)), TTL);
      if (user.email) {
        await this.redisService.set(`user:${user.email.toLowerCase()}`, JSON.stringify(this.sanitizeUser(user)), TTL);
      }
    } catch (err) {
      this.logger.warn(`Failed to cache session in Redis for ${user.username}`, err);
    }
  }

  async logout(token: string): Promise<{ success: boolean; message: string }> {
    if (!token) {
      return { success: true, message: 'Logged out successfully' };
    }
    try {
      const userId = await this.redisService.get(`token_user:${token}`);
      if (userId) {
        await this.redisService.srem(`user_sessions:${userId}`, token);
      }
      await this.redisService.del(`token:${token}`);
      await this.redisService.del(`token_user:${token}`);
    } catch (err) {
      this.logger.error('Error during session logout', err);
    }
    return { success: true, message: 'Logged out and session invalidated successfully' };
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    try {
      const tokens = await this.redisService.smembers(`user_sessions:${userId}`);
      if (tokens && tokens.length > 0) {
        for (const tok of tokens) {
          await this.redisService.del(`token:${tok}`);
          await this.redisService.del(`token_user:${tok}`);
        }
      }
      await this.redisService.del(`user_sessions:${userId}`);
      this.logger.log(`[Security] Revoked all ${tokens?.length || 0} active sessions for user ID: ${userId}`);
    } catch (err) {
      this.logger.error(`Error revoking user sessions for ${userId}`, err);
    }
  }

  private async generateUniqueUsername(): Promise<string> {
    const prefixes = [
      'Pilot',
      'SkyAce',
      'Aero',
      'JetRider',
      'SkyWalker',
      'SkyCaptain',
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

  public validatePasswordStrength(password: string, fieldName = 'Password'): void {
    if (!password || typeof password !== 'string') {
      throw new BadRequestException(`${fieldName} is required`);
    }
    if (password.length < 8) {
      throw new BadRequestException(`${fieldName} must be at least 8 characters long`);
    }
    if (password.length > 128) {
      throw new BadRequestException(`${fieldName} must not exceed 128 characters`);
    }
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasDigit = /[0-9]/.test(password);
    if (!hasUpper || !hasLower || !hasDigit) {
      throw new BadRequestException(
        `${fieldName} must contain at least one uppercase letter, one lowercase letter, and one number`,
      );
    }
  }

  private sanitizeUser(user: User): UserProfile {
    const userCur = (user.currency || 'USD').toUpperCase();
    const rate = PLATFORM_EXCHANGE_RATES[userCur] || 1.0;
    const baseBal = Number(user.balance || 0);
    // Exact cent rounding without floating-point precision loss
    const displayBal = Math.round((baseBal * rate) * 100) / 100;

    return {
      id: user.id,
      username: user.username,
      email: user.email || undefined,
      phoneNumber: user.phoneNumber || undefined,
      currency: userCur,
      balance: displayBal, // Seamlessly formats in user's selected currency
      baseBalance: parseFloat(baseBal.toFixed(6)), // Universal USD base in database
      exchangeRate: rate,
      gamesPlayed: Number(user.gamesPlayed),
      totalWon: Math.round((Number(user.totalWon || 0) * rate) * 100) / 100,
      bestMultiplier: Number(user.bestMultiplier),
      createdAt: user.createdAt ? new Date(user.createdAt).getTime() : Date.now(),
      savedWithdrawalDetails: user.savedWithdrawalDetails,
      isFrozen: !!user.isFrozen,
      freezeReason: user.freezeReason || undefined,
      isFlaggedForReview: !!user.isFlaggedForReview,
      flaggedReason: user.flaggedReason || undefined,
      isMarketing: !!user.isMarketing,
      isMarketingAutoWin: !!user.isMarketingAutoWin,
    };
  }

  async register(
    identifier: string,
    password: string,
    currency?: string,
    clientIp?: string,
  ): Promise<{ token: string; user: UserProfile }> {
    const clean = identifier?.trim().replace(/\s+/g, '');
    if (!clean || clean.length < 3) {
      throw new BadRequestException('Please enter a valid email or mobile number');
    }

    // IP Registration Quota Protection (Max 5 account registrations per IP per hour)
    if (clientIp) {
      const ipKey = `reg_rate_ip:${clientIp}`;
      const regCountRaw = await this.redisService.get(ipKey);
      const regCount = regCountRaw ? parseInt(regCountRaw, 10) : 0;
      if (regCount >= 5) {
        throw new HttpException(
          'Registration limit exceeded for this network. Please try again in an hour.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await this.redisService.set(ipKey, (regCount + 1).toString(), 3600);
    }

    const isEmail = clean.includes('@');
    if (isEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(clean)) {
        throw new BadRequestException('Please enter a valid email address (e.g. name@example.com)');
      }

      // Check if email already registered
      const existingEmail = await this.userRepository.findOne({
        where: { email: ILike(clean) },
      });
      if (existingEmail) {
        throw new BadRequestException('This email is already registered. Please sign in.');
      }
    } else {
      // Validate mobile number format strictly based on country
      if (clean.startsWith('+94')) {
        if (!/^\+947[0-9]{8}$/.test(clean)) {
          throw new BadRequestException('Sri Lankan mobile numbers must have 9 digits starting with 7 (e.g. 77 123 4567)');
        }
      } else if (clean.startsWith('+')) {
        if (!/^\+[1-9]\d{6,14}$/.test(clean)) {
          throw new BadRequestException('Please enter a valid mobile number for the selected country');
        }
      }

      // Check duplicate mobile in PostgreSQL
      const existingPhone = await this.userRepository.findOne({
        where: [{ phoneNumber: clean }, { username: clean.toLowerCase() }],
      });
      if (existingPhone) {
        throw new BadRequestException('This mobile number is already registered. Please sign in.');
      }
    }

    this.validatePasswordStrength(password, 'Password');

    const cleanCurrency = 'USD';
    const initialWelcomeBalance = 0.0;

    // Auto-generate guaranteed unique username (not existing in database)
    const uniqueUsername = await this.generateUniqueUsername();

    const newUser = this.userRepository.create({
      username: uniqueUsername,
      email: isEmail ? clean.toLowerCase() : undefined,
      phoneNumber: !isEmail ? clean : undefined,
      passwordHash: await bcrypt.hash(password, 10),
      currency: cleanCurrency,
      balance: initialWelcomeBalance,
      gamesPlayed: 0,
      totalWon: 0.0,
      bestMultiplier: 1.0,
    });

    const savedUser = await this.userRepository.save(newUser);

    const token = this.generateToken();
    await this.createSession(token, savedUser);

    return {
      token,
      user: this.sanitizeUser(savedUser),
    };
  }

  async login(identifier: string, password: string): Promise<{ token: string; user: UserProfile }> {
    const clean = identifier?.trim().replace(/\s+/g, '');
    if (!clean || !password) {
      throw new BadRequestException('Email/Username and password are required');
    }

    // Phase 3: Brute-Force Login Rate Limiting (5 failed attempts / 5 minutes cooldown)
    const attemptsKey = `failed_login:${clean.toLowerCase()}`;
    const rawAttempts = await this.redisService.get(attemptsKey);
    const attempts = rawAttempts ? parseInt(rawAttempts, 10) : 0;
    if (attempts >= 5) {
      throw new HttpException(
        'Account temporarily locked due to 5 consecutive failed login attempts. Please wait 5 minutes before trying again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const whereConditions: any[] = [
      { email: ILike(clean) },
      { username: ILike(clean) },
    ];

    if (!clean.includes('@')) {
      const candidates = [clean.toLowerCase(), clean];
      if (clean.startsWith('0') && clean.length === 10) {
        candidates.push(`+94${clean.slice(1)}`);
      } else if (!clean.startsWith('+') && clean.length === 9) {
        candidates.push(`+94${clean}`);
      }
      whereConditions.push(...candidates.map((c) => ({ phoneNumber: c })));
    }

    const user = await this.userRepository.findOne({
      where: whereConditions,
    });
    if (!user) {
      // Timing attack mitigation: Perform dummy bcrypt comparison so response time matches valid accounts
      const dummyHash = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
      try {
        await bcrypt.compare(password, dummyHash);
      } catch {}

      const newAttempts = attempts + 1;
      await this.redisService.set(attemptsKey, newAttempts.toString(), 300);
      const remaining = 5 - newAttempts;
      throw new UnauthorizedException(
        remaining > 0
          ? `Invalid credentials. (${remaining} attempts remaining before temporary lockout)`
          : 'Invalid credentials. Account temporarily locked for 5 minutes.',
      );
    }

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
        user.passwordHash = await bcrypt.hash(password, 10);
        await this.userRepository.save(user);
      }
    }

    if (!isMatch) {
      const newAttempts = attempts + 1;
      await this.redisService.set(attemptsKey, newAttempts.toString(), 300);
      const remaining = 5 - newAttempts;
      throw new UnauthorizedException(
        remaining > 0
          ? `Invalid credentials. (${remaining} attempts remaining before temporary lockout)`
          : 'Invalid credentials. Account temporarily locked for 5 minutes.',
      );
    }

    // Reset failed login attempts on successful authentication
    if (attempts > 0) {
      await this.redisService.del(attemptsKey);
    }

    if (user.isFrozen) {
      throw new UnauthorizedException(
        `Account is temporarily suspended: ${user.freezeReason || 'Under security audit'}. Please contact support.`,
      );
    }

    const token = this.generateToken();
    await this.createSession(token, user);

    return {
      token,
      user: this.sanitizeUser(user),
    };
  }

  async getProfile(token: string): Promise<UserProfile & { activeBets?: any }> {
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

    const sanitized = this.sanitizeUser(user);
    try {
      const rawBet1 = await this.redisService.get(`active_bet:${user.id}:1`);
      const rawBet2 = await this.redisService.get(`active_bet:${user.id}:2`);
      return {
        ...sanitized,
        activeBets: {
          slot1: rawBet1 ? JSON.parse(rawBet1) : null,
          slot2: rawBet2 ? JSON.parse(rawBet2) : null,
        },
      };
    } catch {
      return sanitized;
    }
  }

  async renameUser(token: string, newUsername: string): Promise<UserProfile> {
    const oldUsername = await this.redisService.get(`token:${token}`);
    if (!oldUsername) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const existingUser = await this.userRepository.findOne({ where: { username: ILike(newUsername) } });
    if (existingUser) {
      throw new BadRequestException('Username is already taken');
    }

    const user = await this.userRepository.findOne({ where: { username: oldUsername } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    user.username = newUsername;
    const savedUser = await this.userRepository.save(user);

    try {
      await this.redisService.set(`token:${token}`, newUsername);
      await this.redisService.set(`user:${newUsername.toLowerCase()}`, JSON.stringify(this.sanitizeUser(savedUser)));
      await this.redisService.del(`user:${oldUsername.toLowerCase()}`);
    } catch (err) {
      this.logger.warn('Failed to update redis on rename', err);
    }

    return this.sanitizeUser(savedUser);
  }

  async validateUserFromToken(token: string): Promise<User> {
    if (!token) {
      throw new UnauthorizedException('Authentication token required');
    }
    let username: string | null = null;
    try {
      username = await this.redisService.get(`token:${token}`);
    } catch (err) {
      this.logger.error('Failed to read session token from Redis', err);
    }
    if (!username) {
      throw new UnauthorizedException('Session expired or invalid. Please sign in again.');
    }
    const user = await this.userRepository.findOne({ where: { username } });
    if (!user) {
      throw new UnauthorizedException('User account not found');
    }
    if (user.isFrozen) {
      throw new UnauthorizedException(`Account is temporarily suspended: ${user.freezeReason || 'Under security audit'}. Please contact support.`);
    }
    return user;
  }

  async placeGameBet(token: string, betIndex: number, amount: number) {
    if (betIndex !== 1 && betIndex !== 2) {
      throw new BadRequestException('Invalid bet slot index (must be 1 or 2)');
    }

    const user = await this.validateUserFromToken(token);
    const isMarketingUser = !!user.isMarketing;
    const roomType = isMarketingUser ? GameRoomType.MARKETING : GameRoomType.STANDARD;
    const isWaiting = this.gameService.getStatus(roomType) === GameStatus.WAITING;

    const userCurrency = (user.currency || 'USD').toUpperCase();
    const rate = PLATFORM_EXCHANGE_RATES[userCurrency] || 1.0;

    let minBet = 50.0;
    let maxBet = 20000.0;
    if (['USD', 'USDT', 'EUR', 'GBP'].includes(userCurrency)) {
      minBet = 1.0;
      maxBet = 2000.0;
    } else if (userCurrency === 'AED') {
      minBet = 5.0;
      maxBet = 8000.0;
    } else if (userCurrency === 'INR') {
      minBet = 20.0;
      maxBet = 150000.0;
    }

    const cleanAmount = parseFloat(Number(amount).toFixed(2));
    if (isNaN(cleanAmount) || cleanAmount < minBet || cleanAmount > maxBet) {
      throw new BadRequestException(`Bet amount must be between ${minBet} and ${maxBet} ${userCurrency}`);
    }

    // Convert display bet amount to Universal Base USD with 6 decimal precision
    const betAmountUSD = parseFloat((cleanAmount / rate).toFixed(6));
    if (betAmountUSD <= 0) {
      throw new BadRequestException('Bet amount is too low');
    }

    // Phase 2: Distributed Atomic Mutex Lock
    const lockKey = `lock:bet:${user.id}:${betIndex}`;
    const acquired = await this.redisService.acquireLock(lockKey, 3);
    if (!acquired) {
      throw new ConflictException('A bet operation is already being processed for this slot');
    }

    try {
      const activeBetKey = `active_bet:${user.id}:${betIndex}`;
      const queuedBetKey = `queued_bet:${user.id}:${betIndex}`;

      if (isWaiting) {
        const existingBet = await this.redisService.get(activeBetKey);
        if (existingBet) {
          throw new BadRequestException(`Bet slot ${betIndex} already has an active bet for this round`);
        }
      } else {
        const existingQueued = await this.redisService.get(queuedBetKey);
        if (existingQueued) {
          throw new BadRequestException(`Bet slot ${betIndex} already has a queued bet for the next round`);
        }
      }

      // Phase 2: PostgreSQL ACID Transaction with Pessimistic Row Locking (Universal Base USD)
      let savedUser: User;
      await this.userRepository.manager.transaction(async (manager) => {
        const lockedUser = await manager.findOne(User, {
          where: { id: user.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedUser) {
          throw new UnauthorizedException('User account not found');
        }

        const currentBalanceUSD = Number(lockedUser.balance);
        const epsilon = 0.00001;
        if (currentBalanceUSD + epsilon < betAmountUSD) {
          const availableDisplay = Math.round((currentBalanceUSD * rate) * 100) / 100;
          throw new BadRequestException(`Insufficient wallet balance. Available: ${userCurrency} ${availableDisplay}`);
        }

        let newBalanceUSD = parseFloat((currentBalanceUSD - betAmountUSD).toFixed(6));
        if (Math.abs(newBalanceUSD) < epsilon || newBalanceUSD < 0) {
          newBalanceUSD = 0.0;
        }
        lockedUser.balance = newBalanceUSD;
        savedUser = await manager.save(lockedUser);

        await manager.save(Transaction, {
          userId: savedUser.id,
          type: isWaiting ? 'BET' : 'BET_QUEUED',
          amount: betAmountUSD,
          currency: 'USD',
          multiplier: null,
          balanceAfter: newBalanceUSD,
        });
      });

      const betId = `real_${savedUser!.id}_${betIndex}_${Date.now()}`;
      const betRecord = {
        id: betId,
        userId: savedUser!.id,
        username: savedUser!.username,
        betIndex,
        amount: cleanAmount, // client display currency
        amountUSD: betAmountUSD, // universal base USD (6 decimal precision)
        currency: userCurrency,
        rate,
        roomType,
        roundStartTime: isWaiting ? this.gameService.getStartTime(roomType) : null,
        queued: !isWaiting,
        placedAt: Date.now(),
      };

      if (isWaiting) {
        // Save active bet in Redis (180s TTL)
        await this.redisService.set(activeBetKey, JSON.stringify(betRecord), 180);

        // Register with GameService liability pool and live bets table
        const isMarketingAutoWin = isMarketingUser && !!savedUser!.isMarketingAutoWin;

        await this.gameService.registerRealBet(betAmountUSD, isMarketingUser, roomType);
        this.gameService.addRealUserBet({
          id: betId,
          name: savedUser!.username,
          bet: cleanAmount,
          targetMultiplier: 0,
          cashedOut: false,
        }, roomType);

        if (isMarketingAutoWin) {
          this.gameService.registerMarketingAutoWinBet({
            betId,
            userId: savedUser!.id,
            username: savedUser!.username,
            betIndex,
            amount: cleanAmount,
          });
        }
      } else {
        // Save queued bet in Redis (300s TTL) for auto-activation on next round start
        await this.redisService.set(queuedBetKey, JSON.stringify(betRecord), 300);
        this.logger.log(`[Next-Round Queue][${roomType}] Staged bet for user ${savedUser!.username} (Slot ${betIndex}, ${cleanAmount} ${userCurrency})`);
      }

      const sanitized = this.sanitizeUser(savedUser!);
      try {
        await this.redisService.set(`user:${savedUser!.username}`, JSON.stringify(sanitized));
      } catch {}

      return {
        success: true,
        queued: !isWaiting,
        message: isWaiting ? 'Bet placed successfully' : 'Bet accepted and queued for next round ✈️',
        balance: sanitized.balance,
        baseBalance: sanitized.baseBalance,
        bet: betRecord,
        user: sanitized,
      };
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }

  async cancelGameBet(token: string, betIndex: number) {
    if (betIndex !== 1 && betIndex !== 2) {
      throw new BadRequestException('Invalid bet slot index (must be 1 or 2)');
    }

    const user = await this.validateUserFromToken(token);
    const isMarketingUser = !!user.isMarketing;
    const roomType = isMarketingUser ? GameRoomType.MARKETING : GameRoomType.STANDARD;

    // Phase 2: Distributed Atomic Mutex Lock
    const lockKey = `lock:bet:${user.id}:${betIndex}`;
    const acquired = await this.redisService.acquireLock(lockKey, 3);
    if (!acquired) {
      throw new ConflictException('A bet operation is already being processed for this slot');
    }

    try {
      const activeBetKey = `active_bet:${user.id}:${betIndex}`;
      const queuedBetKey = `queued_bet:${user.id}:${betIndex}`;

      const rawActive = await this.redisService.get(activeBetKey);
      const rawQueued = await this.redisService.get(queuedBetKey);

      if (!rawActive && !rawQueued) {
        throw new BadRequestException('No active or queued bet found in this slot to cancel');
      }

      const isQueued = !rawActive && !!rawQueued;
      const raw = isQueued ? rawQueued : rawActive;

      // Active bets can only be cancelled during the countdown phase
      if (!isQueued && this.gameService.getStatus(roomType) !== GameStatus.WAITING) {
        throw new BadRequestException('Active bets can only be cancelled during the countdown phase');
      }

      await this.redisService.del(isQueued ? queuedBetKey : activeBetKey);

      const betRecord = JSON.parse(raw!);
      const betCurrency = betRecord.currency || user.currency || 'USD';
      const rate = betRecord.rate || PLATFORM_EXCHANGE_RATES[betCurrency] || 1.0;
      const refundAmountUSD = betRecord.amountUSD
        ? Number(betRecord.amountUSD)
        : parseFloat((Number(betRecord.amount) / rate).toFixed(6));

      // Phase 2: PostgreSQL ACID Transaction with Pessimistic Row Locking
      let savedUser: User;
      await this.userRepository.manager.transaction(async (manager) => {
        const lockedUser = await manager.findOne(User, {
          where: { id: user.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedUser) {
          throw new UnauthorizedException('User account not found');
        }

        const newBalanceUSD = parseFloat((Number(lockedUser.balance) + refundAmountUSD).toFixed(6));
        lockedUser.balance = newBalanceUSD;
        savedUser = await manager.save(lockedUser);

        await manager.save(Transaction, {
          userId: savedUser.id,
          type: isQueued ? 'CANCEL_QUEUED_BET' : 'CANCEL_BET',
          amount: refundAmountUSD,
          currency: 'USD',
          multiplier: null,
          balanceAfter: newBalanceUSD,
        });
      });

      // If active bet was cancelled, notify GameService
      if (!isQueued) {
        await this.gameService.cancelRealBet(refundAmountUSD, isMarketingUser, roomType);
        this.gameService.removeRealUserBet(betRecord.id, roomType);
      }

      const sanitized = this.sanitizeUser(savedUser!);
      try {
        await this.redisService.set(`user:${savedUser!.username}`, JSON.stringify(sanitized));
      } catch {}

      return {
        success: true,
        balance: sanitized.balance,
        baseBalance: sanitized.baseBalance,
        cancelledBetIndex: betIndex,
        isQueued,
        user: sanitized,
      };
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }

  async cashoutGameBet(token: string, betIndex: number) {
    if (betIndex !== 1 && betIndex !== 2) {
      throw new BadRequestException('Invalid bet slot index (must be 1 or 2)');
    }

    const user = await this.validateUserFromToken(token);
    const isMarketingUser = !!user.isMarketing;
    const roomType = isMarketingUser ? GameRoomType.MARKETING : GameRoomType.STANDARD;

    if (this.gameService.getStatus(roomType) !== GameStatus.PLAYING) {
      throw new BadRequestException('Cash out is only allowed while flight is active');
    }

    // Phase 2: Distributed Atomic Mutex Lock - Prevents parallel double-cashout
    const lockKey = `lock:cashout:${user.id}:${betIndex}`;
    const acquired = await this.redisService.acquireLock(lockKey, 3);
    if (!acquired) {
      throw new ConflictException('A cashout request is already being processed');
    }

    try {
      // Atomic fetch and delete to guarantee single-use cashout
      const betKey = `active_bet:${user.id}:${betIndex}`;
      const raw = await this.redisService.get(betKey);
      if (!raw) {
        throw new BadRequestException('No active bet found to cash out or already cashed out');
      }
      await this.redisService.del(betKey);

      const betRecord = JSON.parse(raw);
      const betAmountDisplay = Number(betRecord.amount);
      const betCurrency = betRecord.currency || user.currency || 'USD';
      const rate = betRecord.rate || PLATFORM_EXCHANGE_RATES[betCurrency] || 1.0;
      const betAmountUSD = betRecord.amountUSD ? Number(betRecord.amountUSD) : parseFloat((betAmountDisplay / rate).toFixed(6));

      // Authoritative multiplier check
      const currentMultiplier = parseFloat(this.gameService.getCurrentMultiplier(roomType).toFixed(2));
      const crashPoint = this.gameService.getCrashPoint(roomType);

      if (currentMultiplier >= crashPoint) {
        // Plane crashed before or during the cashout attempt
        try {
          await this.betHistoryRepository.save({
            userId: user.id,
            betAmount: betAmountUSD,
            cashOutMultiplier: null,
            crashPoint,
            winAmount: 0,
            currency: 'USD',
          });
          await this.userRepository.increment({ id: user.id }, 'gamesPlayed', 1);
        } catch (err) {
          this.logger.error('Failed to log lost bet during crash race', err);
        }
        throw new BadRequestException('Plane has already crashed!');
      }

      // Exact 6-decimal USD winning calculation with Max Payout Cap ($10,000 USD Spribe Standard)
      const MAX_PAYOUT_USD = 10000.0;
      const rawWinUSD = parseFloat((betAmountUSD * currentMultiplier).toFixed(6));
      const winAmountUSD = Math.min(rawWinUSD, MAX_PAYOUT_USD);
      const profitUSD = parseFloat((winAmountUSD - betAmountUSD).toFixed(6));

      // Display win amount with exact cent rounding
      const effectiveMult = betAmountUSD > 0 ? (winAmountUSD / betAmountUSD) : currentMultiplier;
      const displayWinAmount = Math.round((betAmountDisplay * effectiveMult) * 100) / 100;

      // Phase 2: PostgreSQL ACID Transaction with Pessimistic Row Locking
      let savedUser: User;
      await this.userRepository.manager.transaction(async (manager) => {
        const lockedUser = await manager.findOne(User, {
          where: { id: user.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedUser) {
          throw new UnauthorizedException('User account not found');
        }

        const newBalanceUSD = parseFloat((Number(lockedUser.balance) + winAmountUSD).toFixed(6));
        lockedUser.balance = newBalanceUSD;
        lockedUser.gamesPlayed = Number(lockedUser.gamesPlayed) + 1;
        if (profitUSD > 0) {
          lockedUser.totalWon = parseFloat((Number(lockedUser.totalWon) + profitUSD).toFixed(6));
        }
        if (currentMultiplier > Number(lockedUser.bestMultiplier)) {
          lockedUser.bestMultiplier = currentMultiplier;
        }

        savedUser = await manager.save(lockedUser);

        await manager.save(Transaction, {
          userId: savedUser.id,
          type: 'CASHOUT',
          amount: winAmountUSD,
          currency: 'USD',
          multiplier: currentMultiplier,
          balanceAfter: newBalanceUSD,
        });

        await manager.save(BetHistory, {
          userId: savedUser.id,
          betAmount: betAmountUSD,
          cashOutMultiplier: currentMultiplier,
          crashPoint,
          winAmount: winAmountUSD,
          currency: 'USD',
        });
      });

      // Notify GameService liability pool & real cashout broadcast
      await this.gameService.registerRealCashout(betAmountUSD, winAmountUSD, isMarketingUser, roomType);
      this.gameService.markRealUserCashout(betRecord.id, currentMultiplier, displayWinAmount, roomType);

      const sanitized = this.sanitizeUser(savedUser!);
      try {
        await this.redisService.set(`user:${savedUser!.username}`, JSON.stringify(sanitized));
      } catch {}

      return {
        success: true,
        balance: sanitized.balance,
        baseBalance: sanitized.baseBalance,
        winAmount: displayWinAmount,
        winAmountUSD,
        multiplier: currentMultiplier,
        betIndex,
        user: sanitized,
      };
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }

  async executeMarketingAutoCashout(userId: string, betIndex: number, currentMultiplier: number) {
    const lockKey = `lock:cashout:${userId}:${betIndex}`;
    const acquired = await this.redisService.acquireLock(lockKey, 3);
    if (!acquired) {
      return;
    }

    try {
      const betKey = `active_bet:${userId}:${betIndex}`;
      const raw = await this.redisService.get(betKey);
      if (!raw) {
        return;
      }
      await this.redisService.del(betKey);

      const betRecord = JSON.parse(raw);
      const betAmountDisplay = Number(betRecord.amount);
      const betCurrency = betRecord.currency || 'USD';
      const rate = betRecord.rate || PLATFORM_EXCHANGE_RATES[betCurrency] || 1.0;
      const betAmountUSD = betRecord.amountUSD ? Number(betRecord.amountUSD) : parseFloat((betAmountDisplay / rate).toFixed(6));
      const crashPoint = this.gameService.getCrashPoint(GameRoomType.MARKETING);
      const winAmountUSD = parseFloat((betAmountUSD * currentMultiplier).toFixed(6));
      const profitUSD = parseFloat((winAmountUSD - betAmountUSD).toFixed(6));
      const displayWinAmount = Math.round((betAmountDisplay * currentMultiplier) * 100) / 100;

      let savedUser: User | null = null;
      await this.userRepository.manager.transaction(async (manager) => {
        const lockedUser = await manager.findOne(User, {
          where: { id: userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedUser) return;

        const newBalanceUSD = parseFloat((Number(lockedUser.balance) + winAmountUSD).toFixed(6));
        lockedUser.balance = newBalanceUSD;
        lockedUser.gamesPlayed = Number(lockedUser.gamesPlayed) + 1;
        if (profitUSD > 0) {
          lockedUser.totalWon = parseFloat((Number(lockedUser.totalWon) + profitUSD).toFixed(6));
        }
        if (currentMultiplier > Number(lockedUser.bestMultiplier)) {
          lockedUser.bestMultiplier = currentMultiplier;
        }

        savedUser = await manager.save(lockedUser);

        await manager.save(Transaction, {
          userId: savedUser.id,
          type: 'CASHOUT',
          amount: winAmountUSD,
          currency: 'USD',
          multiplier: currentMultiplier,
          balanceAfter: newBalanceUSD,
        });

        await manager.save(BetHistory, {
          userId: savedUser.id,
          betAmount: betAmountUSD,
          cashOutMultiplier: currentMultiplier,
          crashPoint,
          winAmount: winAmountUSD,
          currency: 'USD',
        });
      });

      if (!savedUser) return;

      const userObj: User = savedUser;
      await this.gameService.registerRealCashout(betAmountUSD, winAmountUSD, true, GameRoomType.MARKETING);
      this.gameService.markRealUserCashout(betRecord.id, currentMultiplier, displayWinAmount, GameRoomType.MARKETING);
      const userRate = PLATFORM_EXCHANGE_RATES[(userObj.currency || 'USD').toUpperCase()] || 1.0;
      const displayBal = Math.round((Number(userObj.balance) * userRate) * 100) / 100;
      this.gameService.notifyUserBalance(userObj.username, displayBal, `🎉 Promotional Auto-Win: +${userObj.currency} ${displayWinAmount}`, userObj.currency);

      const sanitized = this.sanitizeUser(userObj);
      try {
        await this.redisService.set(`user:${userObj.username.toLowerCase()}`, JSON.stringify(sanitized));
      } catch {}

      this.logger.log(`[Marketing Auto-Win] Successfully cashed out for ${userObj.username}: +${userObj.currency} ${displayWinAmount} ($${winAmountUSD} USD) at ${currentMultiplier}x`);
    } catch (err) {
      this.logger.error(`[Marketing Auto-Win] Error executing auto cashout for user ${userId}`, err);
    } finally {
      await this.redisService.releaseLock(lockKey);
    }
  }

  async handleRoundCrashed(crashPoint: number, roomType: GameRoomType = GameRoomType.STANDARD) {
    try {
      const activeKeys = await this.redisService.keys('active_bet:*');
      if (!activeKeys || activeKeys.length === 0) return;

      this.logger.log(`Settling uncashed bets for [${roomType}] after crash at ${crashPoint}`);

      for (const key of activeKeys) {
        try {
          const raw = await this.redisService.get(key);
          if (!raw) continue;
          const betRecord = JSON.parse(raw);
          const betRoom = betRecord.roomType || GameRoomType.STANDARD;

          // Only settle bets that belong to this crashed room
          if (betRoom !== roomType) {
            continue;
          }

          await this.redisService.del(key);
          const betCurrency = betRecord.currency || 'USD';
          const rate = betRecord.rate || PLATFORM_EXCHANGE_RATES[betCurrency] || 1.0;
          const betAmountUSD = betRecord.amountUSD ? Number(betRecord.amountUSD) : parseFloat((Number(betRecord.amount) / rate).toFixed(6));
          await this.betHistoryRepository.save({
            userId: betRecord.userId,
            betAmount: betAmountUSD,
            cashOutMultiplier: null,
            crashPoint,
            winAmount: 0,
            currency: 'USD',
          });
          await this.userRepository.increment({ id: betRecord.userId }, 'gamesPlayed', 1);
        } catch (err) {
          this.logger.error(`Error settling active bet key ${key}`, err);
        }
      }
    } catch (err) {
      this.logger.error(`Error scanning active bets during crash cleanup for ${roomType}`, err);
    }
  }

  async activateQueuedBets(roomType: GameRoomType = GameRoomType.STANDARD): Promise<void> {
    try {
      const keys = await this.redisService.keys('queued_bet:*');
      if (!keys || keys.length === 0) return;

      this.logger.log(`Activating queued bet(s) for [${roomType}] new round...`);

      for (const key of keys) {
        try {
          const raw = await this.redisService.get(key);
          if (!raw) continue;

          const betRecord = JSON.parse(raw);
          const betRoom = betRecord.roomType || GameRoomType.STANDARD;

          // Only activate queued bets that belong to the room starting its new round
          if (betRoom !== roomType) {
            continue;
          }

          await this.redisService.del(key);

          const activeKey = `active_bet:${betRecord.userId}:${betRecord.betIndex}`;

          const user = await this.userRepository.findOne({ where: { id: betRecord.userId } });
          const isMarketing = !!user?.isMarketing;
          const isMarketingAutoWin = isMarketing && !!user?.isMarketingAutoWin;

          betRecord.queued = false;
          betRecord.roundStartTime = this.gameService.getStartTime(roomType);
          betRecord.activatedAt = Date.now();

          await this.redisService.set(activeKey, JSON.stringify(betRecord), 180);

          await this.gameService.registerRealBet(betRecord.amountUSD, isMarketing, roomType);
          this.gameService.addRealUserBet({
            id: betRecord.id,
            name: betRecord.username,
            bet: betRecord.amount,
            targetMultiplier: 0,
            cashedOut: false,
          }, roomType);

          if (isMarketingAutoWin) {
            this.gameService.registerMarketingAutoWinBet({
              betId: betRecord.id,
              userId: betRecord.userId,
              username: betRecord.username,
              betIndex: betRecord.betIndex,
              amount: betRecord.amount,
            });
          }

          this.gameService.notifyBetActivated(betRecord.userId, betRecord.username, betRecord);
          this.logger.log(`[Next-Round Queue][${roomType}] Activated queued bet for ${betRecord.username} (Slot ${betRecord.betIndex}, ${betRecord.amount} ${betRecord.currency})`);
        } catch (itemErr) {
          this.logger.error(`Error activating queued bet key ${key}`, itemErr);
        }
      }
    } catch (err) {
      this.logger.error(`Error scanning queued bets during round start for ${roomType}`, err);
    }
  }

  async updateBalance(
    token: string,
    newBalance: number,
    winDelta?: number,
    mult?: number,
  ): Promise<{ success: boolean; balance: number; user: UserProfile }> {
    throw new BadRequestException(
      'Direct client-side balance manipulation is permanently disabled for security. All betting operations are server-authoritative.',
    );
  }


  async getBetHistory(token: string): Promise<BetHistory[]> {
    const username = await this.redisService.get(`token:${token}`);
    if (!username) throw new UnauthorizedException('Session expired');

    const user = await this.userRepository.findOne({ where: { username } });
    if (!user) throw new UnauthorizedException('User not found');

    return this.betHistoryRepository.find({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  async saveBetHistory(
    token: string,
    data: any,
  ): Promise<BetHistory> {
    throw new BadRequestException(
      'Direct client-side bet history injection is permanently disabled. All game records are server-authoritative.',
    );
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

  private async sendPasswordResetEmail(toEmail: string, otp: string): Promise<boolean> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM || 'SkyRush Security <noreply@skyrush.cc>';

    if (!apiKey) {
      this.logger.warn('RESEND_API_KEY is not configured in .env. Email dispatch skipped.');
      return false;
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SkyRush Verification Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #07090E; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #F1F5F9;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #07090E; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 500px; background: linear-gradient(180deg, #0F172A 0%, #0B0F19 100%); border: 1px solid #1E293B; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);">
          <tr>
            <td align="center" style="padding: 32px 30px 20px 30px; border-bottom: 1px solid #1E293B; background: radial-gradient(circle at top, rgba(56, 189, 248, 0.12) 0%, transparent 70%);">
              <h1 style="margin: 0; font-size: 26px; font-weight: 800; letter-spacing: 2px; color: #38BDF8; text-transform: uppercase;">
                SKYRUSH
              </h1>
              <p style="margin: 6px 0 0 0; font-size: 13px; color: #94A3B8; letter-spacing: 0.5px;">SECURITY &amp; VERIFICATION</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 30px 24px 30px;">
              <h2 style="margin: 0 0 12px 0; font-size: 18px; font-weight: 600; color: #F8FAFC;">Password Reset Request</h2>
              <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #94A3B8;">
                We received a request to reset the password for your <strong style="color: #F8FAFC;">SkyRush</strong> account. Use the 6-digit verification code below to proceed:
              </p>
              <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin: 20px 0;">
                <tr>
                  <td align="center" style="background: #090D16; border: 2px dashed #0284C7; border-radius: 12px; padding: 20px 10px;">
                    <div style="font-size: 38px; font-weight: 800; letter-spacing: 10px; color: #38BDF8; font-family: 'Courier New', Courier, monospace; text-shadow: 0 0 12px rgba(56, 189, 248, 0.4);">
                      ${otp}
                    </div>
                    <div style="margin-top: 8px; font-size: 12px; color: #64748B; font-weight: 500;">
                      VALID FOR 5 MINUTES
                    </div>
                  </td>
                </tr>
              </table>
              <p style="margin: 24px 0 0 0; font-size: 13px; line-height: 1.6; color: #64748B;">
                🔒 If you did not make this request, you can safely ignore this email. Your account remains completely secure. Never share this code with anyone.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 20px 30px; background-color: #080C14; border-top: 1px solid #1E293B;">
              <p style="margin: 0; font-size: 12px; color: #475569;">
                &copy; 2026 <a href="https://skyrush.cc" style="color: #38BDF8; text-decoration: none; font-weight: 600;">SkyRush</a>. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [toEmail],
          subject: `SkyRush Verification Code: ${otp}`,
          html,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        this.logger.error(`Resend API error sending email to ${toEmail}: ${errText}`);
        return false;
      }

      const resData: any = await response.json();
      this.logger.log(`📧 Password reset email delivered to ${toEmail} via Resend (ID: ${resData?.id})`);
      return true;
    } catch (err) {
      this.logger.error(`Exception while dispatching email via Resend to ${toEmail}:`, err);
      return false;
    }
  }

  async requestPasswordResetOtp(identifier: string): Promise<{ success: boolean; message: string; devOtp?: string }> {
    const clean = identifier?.trim().replace(/\s+/g, '');
    if (!clean || clean.length < 3) {
      throw new BadRequestException('Please enter a valid email or mobile number');
    }

    // Phase 3: Strict OTP Quota Protection & Anti-Spam (Max 3 OTPs / 10 mins, 60s cooldown)
    const cooldownKey = `otp_cooldown:${clean.toLowerCase()}`;
    const inCooldown = await this.redisService.get(cooldownKey);
    if (inCooldown) {
      throw new HttpException(
        'Please wait 60 seconds before requesting another verification code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const countKey = `otp_rate:${clean.toLowerCase()}`;
    const rawCount = await this.redisService.get(countKey);
    const count = rawCount ? parseInt(rawCount, 10) : 0;
    if (count >= 3) {
      throw new HttpException(
        'Maximum verification code requests exceeded. Please try again after 10 minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const whereConditions: any[] = [
      { email: ILike(clean) },
      { username: ILike(clean) },
      { phoneNumber: clean },
    ];

    const user = await this.userRepository.findOne({ where: whereConditions });
    if (!user) {
      // Security: Uniform response to prevent account enumeration
      return {
        success: true,
        message: 'If an account matches this email or mobile number, a verification code has been dispatched.',
      };
    }

    // Generate 6-digit cryptographically secure OTP (CSPRNG)
    const otp = crypto.randomInt(100000, 1000000).toString();

    // Save in Redis for 5 minutes (300 seconds)
    try {
      await this.redisService.set(`otp:${clean.toLowerCase()}`, otp, 300);
      if (user.email) {
        await this.redisService.set(`otp:${user.email.toLowerCase()}`, otp, 300);
      }
      if (user.phoneNumber) {
        await this.redisService.set(`otp:${user.phoneNumber}`, otp, 300);
      }

      // Record rate limit and set 60s cooldown to protect Resend quota
      await this.redisService.set(countKey, (count + 1).toString(), 600);
      await this.redisService.set(cooldownKey, '1', 60);
    } catch (err) {
      this.logger.warn('Failed to store OTP in Redis', err);
    }

    const targetEmail = (user.email && user.email.includes('@')) ? user.email : (clean.includes('@') ? clean : null);

    let emailSent = false;
    if (targetEmail) {
      emailSent = await this.sendPasswordResetEmail(targetEmail, otp);
    }

    const target = targetEmail || user.phoneNumber || user.username;
    this.logger.log(`🔑 Password reset OTP generated for ${target} (Email sent: ${emailSent})`);

    const isProduction = process.env.NODE_ENV === 'production';

    return {
      success: true,
      message: 'If an account matches this email or mobile number, a verification code has been dispatched.',
      ...(!isProduction && !emailSent ? { devOtp: otp } : {}),
    };
  }

  async resetPassword(
    identifier: string,
    otp: string,
    newPassword: string,
  ): Promise<{ success: boolean; message: string; token: string; user: UserProfile }> {
    const clean = identifier?.trim().replace(/\s+/g, '');
    const cleanOtp = otp?.trim();
    if (!clean || clean.length < 3) {
      throw new BadRequestException('Please enter a valid email or mobile number');
    }
    if (!cleanOtp || cleanOtp.length < 4) {
      throw new BadRequestException('Please enter the 6-digit verification code');
    }
    this.validatePasswordStrength(newPassword, 'New password');

    const whereConditions: any[] = [
      { email: ILike(clean) },
      { username: ILike(clean) },
      { phoneNumber: clean },
    ];

    const user = await this.userRepository.findOne({ where: whereConditions });
    if (!user) {
      throw new BadRequestException('Account not found');
    }

    // Phase 3: Brute-Force Verification Lockout (Max 3 failed verification attempts)
    const attemptsKey = `failed_otp_attempts:${clean.toLowerCase()}`;
    const rawAttempts = await this.redisService.get(attemptsKey);
    const failedAttempts = rawAttempts ? parseInt(rawAttempts, 10) : 0;
    if (failedAttempts >= 3) {
      // Invalidate the OTP immediately to prevent continuous guessing attacks
      await this.redisService.del(`otp:${clean.toLowerCase()}`);
      if (user.email) await this.redisService.del(`otp:${user.email.toLowerCase()}`);
      if (user.phoneNumber) await this.redisService.del(`otp:${user.phoneNumber}`);
      throw new BadRequestException(
        'Too many failed verification attempts. This verification code has been permanently invalidated. Please request a new code.',
      );
    }

    // Verify OTP against Redis
    let savedOtp: string | null = null;
    try {
      savedOtp =
        (await this.redisService.get(`otp:${clean.toLowerCase()}`)) ||
        (user.email ? await this.redisService.get(`otp:${user.email.toLowerCase()}`) : null) ||
        (user.phoneNumber ? await this.redisService.get(`otp:${user.phoneNumber}`) : null);
    } catch {}

    // Constant-time secure check against saved OTP (no backdoor, no dev override)
    let isMatch = false;
    if (savedOtp && cleanOtp && savedOtp.length === cleanOtp.length) {
      try {
        const bufA = Buffer.from(savedOtp);
        const bufB = Buffer.from(cleanOtp);
        isMatch = crypto.timingSafeEqual(bufA, bufB);
      } catch {
        isMatch = false;
      }
    }

    if (!isMatch) {
      const newAttempts = failedAttempts + 1;
      await this.redisService.set(attemptsKey, newAttempts.toString(), 300);
      const remaining = 3 - newAttempts;
      if (remaining <= 0) {
        // Purge OTP upon 3rd failed attempt
        await this.redisService.del(`otp:${clean.toLowerCase()}`);
        if (user.email) await this.redisService.del(`otp:${user.email.toLowerCase()}`);
        if (user.phoneNumber) await this.redisService.del(`otp:${user.phoneNumber}`);
        throw new BadRequestException(
          'Maximum verification attempts exceeded. Code has been invalidated. Please request a new code.',
        );
      }
      throw new BadRequestException(
        `Invalid or expired verification code. (${remaining} attempt${remaining > 1 ? 's' : ''} remaining)`,
      );
    }

    // Clear failed attempts counter on successful verification
    await this.redisService.del(attemptsKey);

    // Hash new password and update user in PostgreSQL
    const passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordHash = passwordHash;
    const savedUser = await this.userRepository.save(user);

    // Invalidate used OTP immediately
    try {
      await this.redisService.del(`otp:${clean.toLowerCase()}`);
      if (user.email) await this.redisService.del(`otp:${user.email.toLowerCase()}`);
      if (user.phoneNumber) await this.redisService.del(`otp:${user.phoneNumber}`);
    } catch {}

    // Security: Invalidate all existing sessions on other devices
    await this.revokeAllUserSessions(user.id);

    const token = this.generateToken();
    await this.createSession(token, savedUser);

    return {
      success: true,
      message: 'Password reset successful! Logging you in...',
      token,
      user: this.sanitizeUser(savedUser),
    };
  }

  detectCurrency(
    req: any,
    queryIp?: string,
    queryTz?: string,
    queryOffset?: string,
  ): { ip: string; country: string; currency: string; isLocal: boolean; source: string } {
    let clientIp = (queryIp || '').trim();

    if (!clientIp && req) {
      const forwarded = req.headers
        ? (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip'])
        : null;
      if (typeof forwarded === 'string') {
        clientIp = forwarded.split(',')[0].trim();
      } else if (Array.isArray(forwarded) && forwarded.length > 0) {
        clientIp = forwarded[0].trim();
      }
    }

    if (!clientIp && req) {
      clientIp = req.socket?.remoteAddress || req.ip || '';
    }

    if (clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.replace('::ffff:', '');
    }

    const isLocal =
      !clientIp ||
      clientIp === '127.0.0.1' ||
      clientIp === '::1' ||
      clientIp === 'localhost' ||
      clientIp.startsWith('192.168.') ||
      clientIp.startsWith('10.') ||
      clientIp.startsWith('172.16.');

    // Platform strictly operates in USD/USDT
    return { ip: clientIp || '127.0.0.1', country: 'US', currency: 'USD', isLocal, source: 'platform_fixed' };
  }

  getExchangeRates(): { base: string; rates: Record<string, number> } {
    return {
      base: 'USD',
      rates: PLATFORM_EXCHANGE_RATES,
    };
  }

  convertCurrency(amount: number, fromCurrency: string, toCurrency: string): { newAmount: number; rate: number } {
    const from = (fromCurrency || 'USD').toUpperCase();
    const to = (toCurrency || 'USD').toUpperCase();

    if (from === to) {
      return { newAmount: amount, rate: 1.0 };
    }

    const fromRate = PLATFORM_EXCHANGE_RATES[from] || 1.0;
    const toRate = PLATFORM_EXCHANGE_RATES[to] || 1.0;

    // Convert from -> USD base -> to
    const effectiveRate = toRate / fromRate;
    const rawConverted = (amount / fromRate) * toRate;

    // Floor to 2 decimals to strictly prevent penny arbitrage
    const newAmount = Math.floor(rawConverted * 100) / 100;
    return { newAmount, rate: parseFloat(effectiveRate.toFixed(4)) };
  }

  async changeCurrency(token: string, targetCurrency: string): Promise<any> {
    throw new BadRequestException('Currency switching is disabled. The platform strictly operates in USD/USDT.');
  }
}
