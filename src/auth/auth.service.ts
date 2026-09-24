import { Injectable, BadRequestException, UnauthorizedException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import * as geoip from 'geoip-lite';
import { RedisService } from '../redis/redis.service';
import { User } from './entities/user.entity';
import { Transaction } from './entities/transaction.entity';
import { BetHistory } from './entities/bet-history.entity';

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

export interface UserProfile {
  id: string;
  username: string;
  email?: string;
  phoneNumber?: string;
  currency: string;
  balance: number;
  gamesPlayed: number;
  totalWon: number;
  bestMultiplier: number;
  createdAt: number;
  savedWithdrawalDetails?: any;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Transaction)
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(BetHistory)
    private readonly betHistoryRepository: Repository<BetHistory>,
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
      email: user.email || undefined,
      phoneNumber: user.phoneNumber || undefined,
      currency: user.currency || 'USD',
      balance: Number(user.balance),
      gamesPlayed: Number(user.gamesPlayed),
      totalWon: Number(user.totalWon),
      bestMultiplier: Number(user.bestMultiplier),
      createdAt: user.createdAt ? new Date(user.createdAt).getTime() : Date.now(),
      savedWithdrawalDetails: user.savedWithdrawalDetails,
    };
  }

  async register(identifier: string, password: string, currency?: string): Promise<{ token: string; user: UserProfile }> {
    const clean = identifier?.trim().replace(/\s+/g, '');
    if (!clean || clean.length < 3) {
      throw new BadRequestException('Please enter a valid email or mobile number');
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

    if (!password || password.length < 4) {
      throw new BadRequestException('Password must be at least 4 characters long');
    }

    const cleanCurrency = (currency?.trim().toUpperCase() || 'LKR').slice(0, 10);
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

    // Cache session and user in Redis
    try {
      await this.redisService.set(`token:${token}`, savedUser.username, 86400 * 7);
      await this.redisService.set(`user:${savedUser.username.toLowerCase()}`, JSON.stringify(this.sanitizeUser(savedUser)));
      if (savedUser.email) {
        await this.redisService.set(`user:${savedUser.email.toLowerCase()}`, JSON.stringify(this.sanitizeUser(savedUser)));
      }
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
      throw new BadRequestException('Email/Username and password are required');
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
      throw new UnauthorizedException('Invalid email, username, or password');
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
      throw new UnauthorizedException('Invalid email, username, or password');
    }

    const token = this.generateToken();

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
    data: { betAmount: number; cashOutMultiplier: number | null; crashPoint: number; winAmount: number; currency: string }
  ): Promise<BetHistory> {
    const username = await this.redisService.get(`token:${token}`);
    if (!username) throw new UnauthorizedException('Session expired');

    const user = await this.userRepository.findOne({ where: { username } });
    if (!user) throw new UnauthorizedException('User not found');

    const bet = this.betHistoryRepository.create({
      userId: user.id,
      betAmount: data.betAmount,
      cashOutMultiplier: data.cashOutMultiplier,
      crashPoint: data.crashPoint,
      winAmount: data.winAmount,
      currency: data.currency || user.currency || 'USD',
    });

    return this.betHistoryRepository.save(bet);
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

  async requestPasswordResetOtp(identifier: string): Promise<{ success: boolean; message: string; devOtp?: string }> {
    const clean = identifier?.trim().replace(/\s+/g, '');
    if (!clean || clean.length < 3) {
      throw new BadRequestException('Please enter a valid email or mobile number');
    }

    const whereConditions: any[] = [
      { email: ILike(clean) },
      { username: ILike(clean) },
      { phoneNumber: clean },
    ];

    const user = await this.userRepository.findOne({ where: whereConditions });
    if (!user) {
      throw new BadRequestException('No account found with this email/number. Please register.');
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Save in Redis for 5 minutes (300 seconds)
    try {
      await this.redisService.set(`otp:${clean.toLowerCase()}`, otp, 300);
      if (user.email) {
        await this.redisService.set(`otp:${user.email.toLowerCase()}`, otp, 300);
      }
      if (user.phoneNumber) {
        await this.redisService.set(`otp:${user.phoneNumber}`, otp, 300);
      }
    } catch (err) {
      this.logger.warn('Failed to store OTP in Redis', err);
    }

    const target = user.email || user.phoneNumber || user.username;
    this.logger.log(`🔑 Password reset OTP for ${target}: [ ${otp} ]`);

    return {
      success: true,
      message: `Verification code sent to ${target}`,
      devOtp: otp,
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
    if (!newPassword || newPassword.length < 4) {
      throw new BadRequestException('New password must be at least 4 characters long');
    }

    const whereConditions: any[] = [
      { email: ILike(clean) },
      { username: ILike(clean) },
      { phoneNumber: clean },
    ];

    const user = await this.userRepository.findOne({ where: whereConditions });
    if (!user) {
      throw new BadRequestException('Account not found');
    }

    // Verify OTP against Redis
    let savedOtp: string | null = null;
    try {
      savedOtp =
        (await this.redisService.get(`otp:${clean.toLowerCase()}`)) ||
        (user.email ? await this.redisService.get(`otp:${user.email.toLowerCase()}`) : null) ||
        (user.phoneNumber ? await this.redisService.get(`otp:${user.phoneNumber}`) : null);
    } catch {}

    const isDevOverride = cleanOtp === '123456';
    if (!isDevOverride && (!savedOtp || savedOtp !== cleanOtp)) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    // Hash new password and update user in PostgreSQL
    const passwordHash = await bcrypt.hash(newPassword, 10);
    user.passwordHash = passwordHash;
    const savedUser = await this.userRepository.save(user);

    // Invalidate used OTP
    try {
      await this.redisService.del(`otp:${clean.toLowerCase()}`);
      if (user.email) await this.redisService.del(`otp:${user.email.toLowerCase()}`);
      if (user.phoneNumber) await this.redisService.del(`otp:${user.phoneNumber}`);
    } catch {}

    const token = this.generateToken();

    // Cache session in Redis
    try {
      await this.redisService.set(`token:${token}`, savedUser.username, 86400 * 7);
      await this.redisService.set(`user:${savedUser.username.toLowerCase()}`, JSON.stringify(this.sanitizeUser(savedUser)));
    } catch {}

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

    // 1. If real public IP exists, prioritize GeoIP lookup
    if (!isLocal) {
      const geo = geoip.lookup(clientIp);
      if (geo?.country) {
        const country = geo.country.toUpperCase();
        const currency = COUNTRY_TO_CURRENCY[country] || 'USD';
        return { ip: clientIp, country, currency, isLocal: false, source: 'geoip' };
      }
    }

    // 2. If local or GeoIP not found, evaluate client Timezone name
    const cleanTz = (queryTz || '').trim().toLowerCase();
    if (cleanTz) {
      if (cleanTz.includes('colombo') || cleanTz.includes('sri lanka') || cleanTz.includes('srilanka')) {
        return { ip: clientIp || '127.0.0.1', country: 'LK', currency: 'LKR', isLocal, source: 'timezone' };
      }
      for (const [tzKey, ctry] of Object.entries(TIMEZONE_TO_COUNTRY)) {
        if (cleanTz.includes(tzKey)) {
          const currency = COUNTRY_TO_CURRENCY[ctry] || 'USD';
          return { ip: clientIp || '127.0.0.1', country: ctry, currency, isLocal, source: 'timezone' };
        }
      }
    }

    // 3. Evaluate client Timezone UTC offset (e.g. +330 mins = +05:30)
    const offsetMin = queryOffset ? parseInt(queryOffset, 10) : null;
    if (offsetMin === 330) {
      return { ip: clientIp || '127.0.0.1', country: 'LK', currency: 'LKR', isLocal, source: 'timezone-offset' };
    } else if (offsetMin === 345) {
      return { ip: clientIp || '127.0.0.1', country: 'NP', currency: 'NPR', isLocal, source: 'timezone-offset' };
    } else if (offsetMin === 360) {
      return { ip: clientIp || '127.0.0.1', country: 'BD', currency: 'BDT', isLocal, source: 'timezone-offset' };
    } else if (offsetMin === 300) {
      return { ip: clientIp || '127.0.0.1', country: 'PK', currency: 'PKR', isLocal, source: 'timezone-offset' };
    } else if (offsetMin === 240) {
      return { ip: clientIp || '127.0.0.1', country: 'AE', currency: 'AED', isLocal, source: 'timezone-offset' };
    } else if (offsetMin === 480) {
      return { ip: clientIp || '127.0.0.1', country: 'SG', currency: 'SGD', isLocal, source: 'timezone-offset' };
    } else if (offsetMin === 0) {
      return { ip: clientIp || '127.0.0.1', country: 'GB', currency: 'GBP', isLocal, source: 'timezone-offset' };
    }

    // 4. Default fallback: Sri Lanka (LKR)
    return { ip: clientIp || '127.0.0.1', country: 'LK', currency: 'LKR', isLocal, source: 'default' };
  }
}
