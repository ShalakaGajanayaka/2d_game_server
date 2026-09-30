import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { Transaction } from '../auth/entities/transaction.entity';
import { DepositRequest, DepositStatus } from '../auth/entities/deposit-request.entity';
import { WithdrawalRequest, WithdrawalStatus } from '../auth/entities/withdrawal-request.entity';
import { PoolAuditLog } from '../auth/entities/pool-audit-log.entity';
import { RedisService } from '../redis/redis.service';
import { GameService } from '../game/game.service';
import { PLATFORM_EXCHANGE_RATES } from '../auth/auth.service';

export interface PaymentChannel {
  id: string;
  name: string;
  type: string;
  badge: string;
  accountNumber: string;
  accountName: string;
  instructions: string;
  iconName: string;
  isEnabled?: boolean;
}

@Injectable()
export class AdminService implements OnModuleInit {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(Transaction)
    private readonly transactionRepo: Repository<Transaction>,
    @InjectRepository(DepositRequest)
    private readonly depositRepo: Repository<DepositRequest>,
    @InjectRepository(WithdrawalRequest)
    private readonly withdrawalRepo: Repository<WithdrawalRequest>,
    @InjectRepository(PoolAuditLog)
    private readonly poolAuditRepo: Repository<PoolAuditLog>,
    private readonly redisService: RedisService,
    private readonly gameService: GameService,
  ) {}

  onModuleInit() {
    // Phase 4: Initial reconciliation check after server startup
    setTimeout(() => {
      this.runFullSystemReconciliation().catch((err) => {
        this.logger.error('Error during initial system ledger reconciliation', err);
      });
    }, 15000);

    // Schedule automated periodic reconciliation every 60 minutes
    setInterval(() => {
      this.runFullSystemReconciliation().catch((err) => {
        this.logger.error('Error during scheduled system ledger reconciliation', err);
      });
    }, 60 * 60 * 1000);
  }

  getPaymentChannels(): PaymentChannel[] {
    return [
      {
        id: 'ipay',
        name: 'iPay (Sri Lanka)',
        type: 'ipay',
        badge: 'Instant QR / App',
        accountNumber: '0729642306',
        accountName: 'SkyRush Official',
        instructions: 'Open your iPay app, choose Pay Merchant / Send Money, enter Mobile / Account 0729642306, include your Gamer Tag as remark, and submit the iPay Reference Number below.',
        iconName: 'qr_code_scanner',
        isEnabled: true,
      },
      {
        id: 'upay',
        name: 'UPay (Sri Lanka)',
        type: 'upay',
        badge: 'Mobile Transfer',
        accountNumber: '0729642306',
        accountName: 'SkyRush Official',
        instructions: 'Open your UPay app, send money to mobile number 0729642306 with your Gamer Tag in description, and copy the transaction reference number below.',
        iconName: 'phone_android',
        isEnabled: true,
      },
      {
        id: 'bank_transfer',
        name: 'Commercial Bank',
        type: 'bank_transfer',
        badge: 'Disabled',
        accountNumber: 'Disabled',
        accountName: 'Commercial Bank',
        instructions: 'Commercial Bank deposits are temporarily disabled. Please use iPay or UPay.',
        iconName: 'account_balance',
        isEnabled: false,
      },
    ];
  }

  async clientSubmitDeposit(
    userId: string,
    username: string,
    email: string | undefined,
    amount: number,
    currency: string,
    paymentMethod: string,
    referenceNumber: string,
  ): Promise<DepositRequest> {
    if (paymentMethod === 'bank_transfer') {
      throw new BadRequestException('Commercial Bank deposits are temporarily disabled. Please use iPay or UPay.');
    }

    const cleanAmount = Number(amount);
    if (!cleanAmount || cleanAmount <= 0) {
      throw new BadRequestException('Deposit amount must be greater than zero');
    }

    const cleanRef = (referenceNumber || '').trim();
    if (!cleanRef || cleanRef.length < 3) {
      throw new BadRequestException('Please enter a valid Transaction Reference or Slip Number');
    }

    // Check duplicate reference
    const existing = await this.depositRepo.findOne({
      where: [
        { referenceNumber: cleanRef, status: DepositStatus.APPROVED },
        { referenceNumber: cleanRef, status: DepositStatus.PENDING },
      ],
    });
    if (existing) {
      if (existing.status === DepositStatus.APPROVED) {
        throw new BadRequestException('This transaction reference has already been approved and credited');
      } else {
        throw new BadRequestException('A deposit request with this reference is already pending admin verification');
      }
    }

    const newDeposit = this.depositRepo.create({
      userId,
      username,
      email: email || undefined,
      amount: cleanAmount,
      currency: (currency || 'USD').toUpperCase(),
      paymentMethod,
      referenceNumber: cleanRef,
      status: DepositStatus.PENDING,
    });

    const saved = await this.depositRepo.save(newDeposit);
    this.logger.log(`New deposit request submitted: ${username} - ${saved.currency} ${saved.amount} (${paymentMethod} - ${cleanRef})`);
    
    // Broadcast real-time notification to Next.js Admin Dashboard
    this.gameService.notifyNewDeposit(saved);

    return saved;
  }

  async getDashboardStats() {
    const totalUsers = await this.userRepo.count();
    const allUsers = await this.userRepo.find();

    // Identify marketing promotional user IDs to isolate promotional balances and demo credits
    const marketingUserIds = new Set(allUsers.filter((u) => u.isMarketing).map((u) => u.id));
    const realUsers = allUsers.filter((u) => !u.isMarketing);

    const pendingDeposits = await this.depositRepo.count({ where: { status: DepositStatus.PENDING } });

    // Only real non-marketing customer deposits contribute to Real Deposited Volume (Normalized to USD)
    const approvedList = await this.depositRepo.find({ where: { status: DepositStatus.APPROVED } });
    const realApprovedList = approvedList.filter((d) => !marketingUserIds.has(d.userId));
    const approvedDeposits = realApprovedList.length;
    const totalDepositedAmount = parseFloat(
      realApprovedList.reduce((sum, d) => {
        const rate = PLATFORM_EXCHANGE_RATES[(d.currency || 'USD').toUpperCase()] || 1.0;
        return sum + (Number(d.amount) / rate);
      }, 0).toFixed(2),
    );

    const pendingWithdrawals = await this.withdrawalRepo.count({ where: { status: WithdrawalStatus.PENDING } });
    const paidWithdrawalList = await this.withdrawalRepo.find({ where: { status: WithdrawalStatus.PAID } });
    const realPaidWithdrawals = paidWithdrawalList.filter((w) => !marketingUserIds.has(w.userId));
    const paidWithdrawals = realPaidWithdrawals.length;
    const totalWithdrawnAmount = parseFloat(
      realPaidWithdrawals.reduce((sum, w) => {
        const rate = PLATFORM_EXCHANGE_RATES[(w.currency || 'USD').toUpperCase()] || 1.0;
        return sum + (Number(w.amount) / rate);
      }, 0).toFixed(2),
    );

    // Only real customer wallets count toward real active system liability (already in USD)
    const totalSystemBalance = parseFloat(
      realUsers.reduce((sum, u) => sum + Number(u.balance), 0).toFixed(2),
    );
    const marketingSystemBalance = parseFloat(
      allUsers.filter((u) => u.isMarketing).reduce((sum, u) => sum + Number(u.balance), 0).toFixed(2),
    );
    
    const globalPool = this.gameService.getGlobalPool();
    const pendingGlobalPool = this.gameService.getPendingGlobalPool();

    // Company Real Net Profit in USD ($): Real Customer Deposits - Real Paid Withdrawals - Real Active Player Balances
    const companyNetProfit = parseFloat(
      (totalDepositedAmount - totalWithdrawnAmount - totalSystemBalance).toFixed(2),
    );

    return {
      totalUsers,
      pendingDeposits,
      approvedDeposits,
      totalDepositedAmount,
      pendingWithdrawals,
      paidWithdrawals,
      totalWithdrawnAmount,
      totalSystemBalance,
      marketingSystemBalance,
      globalPool,
      pendingGlobalPool,
      companyNetProfit,
    };
  }

  async setGlobalPool(amount: number): Promise<{
    globalPool: number;
    pending: boolean;
    target: number;
    appliedRound: string;
  }> {
    return this.gameService.setGlobalPool(amount);
  }

  async adjustPool(dto: {
    action: 'TOP_UP' | 'PROFIT_SKIM' | 'SET_TARGET';
    amount: number;
    note?: string;
    adminUser?: string;
  }): Promise<{
    success: boolean;
    globalPool: number;
    pending: boolean;
    target: number;
    appliedRound: string;
    auditLog: PoolAuditLog;
  }> {
    const currentPool = this.gameService.getGlobalPool();
    let target = currentPool;

    if (dto.action === 'TOP_UP') {
      target = currentPool + dto.amount;
    } else if (dto.action === 'PROFIT_SKIM') {
      target = currentPool - dto.amount;
    } else if (dto.action === 'SET_TARGET') {
      target = dto.amount;
    } else {
      throw new BadRequestException('Invalid pool action');
    }

    if (target < GameService.MIN_POOL_FLOOR) {
      throw new BadRequestException(
        `Target pool ($${target.toLocaleString()} USD) cannot be less than safety minimum $${GameService.MIN_POOL_FLOOR.toLocaleString()} USD`,
      );
    }

    const poolResult = await this.gameService.setGlobalPool(target);

    const log = await this.poolAuditRepo.save({
      adminUser: dto.adminUser || 'Admin',
      action: dto.action,
      previousAmount: currentPool,
      newAmount: target,
      delta: parseFloat((target - currentPool).toFixed(2)),
      note: `${dto.note ? dto.note + ' ' : ''}${poolResult.pending ? '[Staged for Next Round]' : '[Applied Immediately]'}`,
    });

    return {
      success: true,
      globalPool: poolResult.globalPool,
      pending: poolResult.pending,
      target: poolResult.target,
      appliedRound: poolResult.appliedRound,
      auditLog: log,
    };
  }

  async getPoolAuditLogs(limit: number = 20): Promise<PoolAuditLog[]> {
    return this.poolAuditRepo.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getDeposits(status?: string, limit: number = 50): Promise<DepositRequest[]> {
    const where: any = {};
    if (status && status !== 'ALL') {
      where.status = status;
    }

    return this.depositRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async approveDeposit(depositId: string, adminUser: string = 'Admin'): Promise<{ success: boolean; message: string; user: User; deposit: DepositRequest }> {
    const deposit = await this.depositRepo.findOne({ where: { id: depositId } });
    if (!deposit) {
      throw new NotFoundException('Deposit request not found');
    }

    if (deposit.status !== DepositStatus.PENDING) {
      throw new BadRequestException(`Deposit is already ${deposit.status}`);
    }

    const user = await this.userRepo.findOne({ where: [{ id: deposit.userId }, { username: deposit.username }] });
    if (!user) {
      throw new NotFoundException('User for this deposit was not found');
    }

    const depositAmount = Number(deposit.amount);
    const prevBalanceUSD = Number(user.balance);

    // Multi-Currency Normalization: Convert deposit currency to Universal Base USD
    const depositCurrency = (deposit.currency || 'USDT').toUpperCase();
    const userCurrency = (user.currency || 'USD').toUpperCase();
    const depositRate = PLATFORM_EXCHANGE_RATES[depositCurrency] || 1.0;
    const userRate = PLATFORM_EXCHANGE_RATES[userCurrency] || 1.0;

    // Direct USD value to credit into user.balance in database
    const depositUSD = parseFloat((depositAmount / depositRate).toFixed(2));
    const newBalanceUSD = parseFloat((prevBalanceUSD + depositUSD).toFixed(2));

    // Player display values
    const creditedDisplayAmount = parseFloat((depositUSD * userRate).toFixed(2));
    const displayBalance = parseFloat((newBalanceUSD * userRate).toFixed(2));

    // Atomically update user balance in PostgreSQL (in pure USD)
    user.balance = newBalanceUSD;
    const savedUser = await this.userRepo.save(user);

    // Update Redis Cache
    try {
      const sanitized = {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        currency: userCurrency,
        balance: displayBalance,
        baseBalance: newBalanceUSD,
        exchangeRate: userRate,
        gamesPlayed: Number(savedUser.gamesPlayed),
        totalWon: Number(savedUser.totalWon),
        bestMultiplier: Number(savedUser.bestMultiplier),
        createdAt: savedUser.createdAt ? new Date(savedUser.createdAt).getTime() : Date.now(),
      };
      await this.redisService.set(`user:${savedUser.username.toLowerCase()}`, JSON.stringify(sanitized));
      if (savedUser.email) {
        await this.redisService.set(`user:${savedUser.email.toLowerCase()}`, JSON.stringify(sanitized));
      }
    } catch (err) {
      this.logger.warn('Failed to update user Redis cache on deposit approval', err);
    }

    // Save transaction ledger entry in Universal Base USD
    try {
      await this.transactionRepo.save({
        userId: savedUser.id,
        type: 'DEPOSIT',
        amount: depositUSD,
        multiplier: depositRate !== 1.0 ? depositRate : null,
        balanceAfter: newBalanceUSD,
        currency: 'USD',
      });
    } catch (err) {
      this.logger.error('Failed to save deposit transaction ledger', err);
    }

    // Mark deposit as APPROVED
    deposit.status = DepositStatus.APPROVED;
    deposit.approvedBy = adminUser;
    deposit.approvedAt = new Date();
    const savedDeposit = await this.depositRepo.save(deposit);

    // Notify player's active game screen in real-time via WebSocket
    const creditMsg = userCurrency === 'USD' || userCurrency === 'USDT'
      ? `Deposit of ${depositAmount.toFixed(2)} ${depositCurrency} approved! Credited $${depositUSD.toFixed(2)} USD to your balance. 💰`
      : `Deposit of ${depositAmount.toFixed(2)} ${depositCurrency} approved! Credited ${userCurrency} ${creditedDisplayAmount.toFixed(2)} ($${depositUSD.toFixed(2)} USD) to your balance. 💰`;

    this.gameService.notifyUserBalance(
      {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
      },
      displayBalance,
      creditMsg,
      userCurrency,
    );

    this.logger.log(`Deposit APPROVED: ${savedDeposit.id} for ${savedUser.username} (+${savedDeposit.currency} ${depositAmount} -> +$${depositUSD} USD). New Balance: $${newBalanceUSD} USD`);

    return {
      success: true,
      message: `Deposit of ${savedDeposit.currency} ${depositAmount.toFixed(2)} approved successfully! Credited $${depositUSD.toFixed(2)} USD to ${savedUser.username}.`,
      user: savedUser,
      deposit: savedDeposit,
    };
  }

  async rejectDeposit(depositId: string, reason?: string, adminUser: string = 'Admin'): Promise<DepositRequest> {
    const deposit = await this.depositRepo.findOne({ where: { id: depositId } });
    if (!deposit) {
      throw new NotFoundException('Deposit request not found');
    }

    if (deposit.status !== DepositStatus.PENDING) {
      throw new BadRequestException(`Deposit is already ${deposit.status}`);
    }

    deposit.status = DepositStatus.REJECTED;
    deposit.adminNote = reason || 'Payment could not be verified';
    deposit.approvedBy = adminUser;
    deposit.approvedAt = new Date();

    const saved = await this.depositRepo.save(deposit);
    this.logger.log(`Deposit REJECTED: ${deposit.id} for ${deposit.username} (Reason: ${deposit.adminNote})`);
    return saved;
  }

  async manualCredit(identifier: string, amount: number, note?: string, adminUser: string = 'Admin'): Promise<{ success: boolean; message: string; user: User }> {
    const clean = (identifier || '').trim();
    const cleanAmountUSD = Number(amount);

    if (!clean) {
      throw new BadRequestException('Please provide a username or email to credit');
    }
    if (!cleanAmountUSD || cleanAmountUSD <= 0) {
      throw new BadRequestException('Credit amount must be greater than zero');
    }

    const user = await this.userRepo.findOne({
      where: [{ username: ILike(clean) }, { email: ILike(clean) }],
    });

    if (!user) {
      throw new NotFoundException(`User '${clean}' not found in database`);
    }

    const prevBalanceUSD = Number(user.balance);
    const newBalanceUSD = parseFloat((prevBalanceUSD + cleanAmountUSD).toFixed(2));
    user.balance = newBalanceUSD;
    const savedUser = await this.userRepo.save(user);

    const userCurrency = (savedUser.currency || 'USD').toUpperCase();
    const userRate = PLATFORM_EXCHANGE_RATES[userCurrency] || 1.0;
    const displayBalance = parseFloat((newBalanceUSD * userRate).toFixed(2));
    const creditedDisplayAmount = parseFloat((cleanAmountUSD * userRate).toFixed(2));

    // Update Redis
    try {
      const sanitized = {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        currency: userCurrency,
        balance: displayBalance,
        baseBalance: newBalanceUSD,
        exchangeRate: userRate,
        gamesPlayed: Number(savedUser.gamesPlayed),
        totalWon: Number(savedUser.totalWon),
        bestMultiplier: Number(savedUser.bestMultiplier),
        createdAt: savedUser.createdAt ? new Date(savedUser.createdAt).getTime() : Date.now(),
      };
      await this.redisService.set(`user:${savedUser.username.toLowerCase()}`, JSON.stringify(sanitized));
      if (savedUser.email) {
        await this.redisService.set(`user:${savedUser.email.toLowerCase()}`, JSON.stringify(sanitized));
      }
    } catch {}

    // Record ledger transaction in USD
    try {
      await this.transactionRepo.save({
        userId: savedUser.id,
        type: 'MANUAL_DEPOSIT',
        amount: cleanAmountUSD,
        multiplier: null,
        balanceAfter: newBalanceUSD,
        currency: 'USD',
      });
    } catch {}

    // Create an approved deposit audit record in USD
    try {
      await this.depositRepo.save({
        userId: savedUser.id,
        username: savedUser.username,
        email: savedUser.email || undefined,
        amount: cleanAmountUSD,
        currency: 'USD',
        paymentMethod: 'admin_manual',
        referenceNumber: `ADMIN-${Date.now()}`,
        status: DepositStatus.APPROVED,
        adminNote: note || 'Direct admin manual credit ($ USD)',
        approvedBy: adminUser,
        approvedAt: new Date(),
      });
    } catch {}

    this.gameService.notifyUserBalance(
      {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
      },
      displayBalance,
      `🎉 Admin credited $${cleanAmountUSD.toFixed(2)} USD (+${userCurrency} ${creditedDisplayAmount.toFixed(2)}) to your wallet! 💰`,
      userCurrency,
    );

    return {
      success: true,
      message: `Successfully credited $${cleanAmountUSD.toFixed(2)} USD to ${savedUser.username}`,
      user: savedUser,
    };
  }

  async getUsers(search?: string, limit: number = 50): Promise<User[]> {
    const where: any[] = [];
    const clean = (search || '').trim();

    if (clean) {
      where.push({ username: ILike(`%${clean}%`) });
      where.push({ email: ILike(`%${clean}%`) });
      where.push({ phoneNumber: ILike(`%${clean}%`) });
    }

    return this.userRepo.find({
      where: where.length > 0 ? where : undefined,
      order: { createdAt: 'DESC' },
      take: limit,
      select: {
        id: true,
        username: true,
        email: true,
        phoneNumber: true,
        currency: true,
        balance: true,
        gamesPlayed: true,
        totalWon: true,
        isFrozen: true,
        isMarketing: true,
        isMarketingAutoWin: true,
        createdAt: true,
      },
    });
  }

  // -------------------------------------------------------------
  // CLIENT WITHDRAWAL FLOW
  // -------------------------------------------------------------

  async clientSubmitWithdrawal(
    userId: string,
    username: string,
    email: string | undefined,
    amount: number,
    currency: string,
    method: string,
    payoutDetails: any,
    saveDetails?: boolean,
  ): Promise<WithdrawalRequest> {
    const cleanAmount = Number(amount);
    const targetCurrency = (currency || 'USD').toUpperCase();
    const rate = PLATFORM_EXCHANGE_RATES[targetCurrency] || 1.0;
    const usdtEquivalent = cleanAmount / rate;

    // Minimum 7 USDT validation across all supported currencies
    if (!cleanAmount || usdtEquivalent < 6.99) {
      const minLocal = (7.0 * rate).toFixed(2);
      throw new BadRequestException(
        `Minimum withdrawal amount is 7 USDT (approx ${targetCurrency} ${minLocal})`,
      );
    }

    if (!payoutDetails) {
      throw new BadRequestException('Payout details are required');
    }

    if (this.gameService.hasActiveBet(username)) {
      throw new BadRequestException(
        'Cannot request a withdrawal while you have an active bet in flight! Please cash out or wait for the round to conclude.',
      );
    }

    const user = await this.userRepo.findOne({ where: [{ id: userId }, { username }] });
    if (!user) {
      throw new NotFoundException('User account not found');
    }

    if (user.isMarketing) {
      throw new ForbiddenException('Marketing promotional accounts are strictly restricted from real money withdrawals.');
    }

    const currentBalanceUSD = Number(user.balance);
    const amountUSD = parseFloat((cleanAmount / rate).toFixed(2));

    if (currentBalanceUSD < amountUSD) {
      const availableDisplay = (currentBalanceUSD * rate).toFixed(2);
      throw new BadRequestException(`Insufficient wallet balance. Available: ${targetCurrency} ${availableDisplay}`);
    }

    // Atomically hold/deduct the requested amount from active wallet balance in pure USD
    const newBalanceUSD = parseFloat((currentBalanceUSD - amountUSD).toFixed(2));
    user.balance = newBalanceUSD;

    if (saveDetails) {
      const currentDetails = user.savedWithdrawalDetails || {};
      currentDetails[method] = payoutDetails;
      user.savedWithdrawalDetails = { ...currentDetails };
    }

    const savedUser = await this.userRepo.save(user);

    const userRate = PLATFORM_EXCHANGE_RATES[(savedUser.currency || 'USD').toUpperCase()] || 1.0;
    const displayBalance = parseFloat((newBalanceUSD * userRate).toFixed(2));

    // Update Redis
    try {
      const sanitized = {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        currency: savedUser.currency,
        balance: displayBalance,
        baseBalance: newBalanceUSD,
        exchangeRate: userRate,
        gamesPlayed: Number(savedUser.gamesPlayed),
        totalWon: Number(savedUser.totalWon),
        bestMultiplier: Number(savedUser.bestMultiplier),
        createdAt: savedUser.createdAt ? new Date(savedUser.createdAt).getTime() : Date.now(),
        savedWithdrawalDetails: savedUser.savedWithdrawalDetails,
      };
      await this.redisService.set(`user:${savedUser.username.toLowerCase()}`, JSON.stringify(sanitized));
      if (savedUser.email) {
        await this.redisService.set(`user:${savedUser.email.toLowerCase()}`, JSON.stringify(sanitized));
      }
    } catch {}

    // Record transaction ledger (escrow hold in USD)
    try {
      await this.transactionRepo.save({
        userId: savedUser.id,
        type: 'WITHDRAWAL_ESCROW',
        amount: -amountUSD,
        multiplier: rate !== 1.0 ? rate : null,
        balanceAfter: newBalanceUSD,
        currency: 'USD',
      });
    } catch (err) {
      this.logger.error('Failed to save withdrawal escrow transaction', err);
    }

    // Create WithdrawalRequest record
    const detailsString = typeof payoutDetails === 'string' ? payoutDetails : JSON.stringify(payoutDetails);
    const newWithdrawal = this.withdrawalRepo.create({
      userId: savedUser.id,
      username: savedUser.username,
      email: email || savedUser.email || undefined,
      amount: cleanAmount,
      currency: targetCurrency,
      method: method || 'bank_transfer',
      payoutDetails: detailsString,
      status: WithdrawalStatus.PENDING,
    });

    const savedWithdrawal = await this.withdrawalRepo.save(newWithdrawal);
    this.logger.log(`New withdrawal request: ${savedUser.username} - ${savedWithdrawal.currency} ${cleanAmount} ($${amountUSD} USD) (${method})`);

    // Notify player's active game screen of updated balance
    this.gameService.notifyUserBalance(
      savedUser.username,
      displayBalance,
      `Withdrawal request for ${savedWithdrawal.currency} ${cleanAmount.toFixed(2)} submitted. Your wallet is held in escrow. ⏳`,
      savedUser.currency,
    );

    // Broadcast real-time notification to Next.js Admin Dashboard
    this.gameService.notifyNewWithdrawal(savedWithdrawal);

    return savedWithdrawal;
  }

  async getWithdrawals(status?: string, limit: number = 50): Promise<WithdrawalRequest[]> {
    const where: any = {};
    if (status && status !== 'ALL') {
      where.status = status;
    }

    return this.withdrawalRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async approveWithdrawal(
    withdrawalId: string,
    adminNote?: string,
    adminUser: string = 'Admin',
  ): Promise<{ success: boolean; message: string; withdrawal: WithdrawalRequest }> {
    const withdrawal = await this.withdrawalRepo.findOne({ where: { id: withdrawalId } });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal request not found');
    }

    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw new BadRequestException(`Withdrawal is already ${withdrawal.status}`);
    }

    withdrawal.status = WithdrawalStatus.PAID;
    withdrawal.adminNote = adminNote || 'Paid to client account';
    withdrawal.processedBy = adminUser;
    withdrawal.processedAt = new Date();

    const savedWithdrawal = await this.withdrawalRepo.save(withdrawal);

    // Record ledger finalized entry in base USD
    const withdrawCurrency = (withdrawal.currency || 'USD').toUpperCase();
    const rate = PLATFORM_EXCHANGE_RATES[withdrawCurrency] || 1.0;
    const amountUSD = parseFloat((Number(withdrawal.amount) / rate).toFixed(2));
    try {
      await this.transactionRepo.save({
        userId: withdrawal.userId,
        type: 'WITHDRAWAL_PAID',
        amount: -amountUSD,
        multiplier: rate !== 1.0 ? rate : null,
        balanceAfter: 0,
        currency: 'USD',
      });
    } catch {}

    // Real-time notification to player: Money has been sent!
    const user = await this.userRepo.findOne({ where: { id: withdrawal.userId } });
    if (user) {
      const userRate = PLATFORM_EXCHANGE_RATES[(user.currency || 'USD').toUpperCase()] || 1.0;
      const displayBal = parseFloat((Number(user.balance) * userRate).toFixed(2));
      this.gameService.notifyUserBalance(
        user.username,
        displayBal,
        `Your withdrawal of ${withdrawal.currency} ${Number(withdrawal.amount).toFixed(2)} has been transferred to your account! 💸`,
        user.currency,
      );
    }

    this.logger.log(`Withdrawal PAID: ${savedWithdrawal.id} for ${withdrawal.username} (${withdrawal.currency} ${withdrawal.amount}) ($${amountUSD} USD)`);

    return {
      success: true,
      message: `Withdrawal of ${withdrawal.currency} ${Number(withdrawal.amount).toFixed(2)} marked as PAID for ${withdrawal.username}!`,
      withdrawal: savedWithdrawal,
    };
  }

  async rejectWithdrawal(
    withdrawalId: string,
    reason?: string,
    adminUser: string = 'Admin',
  ): Promise<{ success: boolean; message: string; withdrawal: WithdrawalRequest }> {
    const withdrawal = await this.withdrawalRepo.findOne({ where: { id: withdrawalId } });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal request not found');
    }

    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw new BadRequestException(`Withdrawal is already ${withdrawal.status}`);
    }

    const user = await this.userRepo.findOne({ where: [{ id: withdrawal.userId }, { username: withdrawal.username }] });
    if (!user) {
      throw new NotFoundException('User for this withdrawal was not found');
    }

    // REFUND amount back to active wallet balance (Universal Base USD)
    const withdrawCurrency = (withdrawal.currency || 'USD').toUpperCase();
    const rate = PLATFORM_EXCHANGE_RATES[withdrawCurrency] || 1.0;
    const refundUSD = parseFloat((Number(withdrawal.amount) / rate).toFixed(2));
    const prevBalanceUSD = Number(user.balance);
    const newBalanceUSD = parseFloat((prevBalanceUSD + refundUSD).toFixed(2));
    user.balance = newBalanceUSD;
    const savedUser = await this.userRepo.save(user);

    const userRate = PLATFORM_EXCHANGE_RATES[(savedUser.currency || 'USD').toUpperCase()] || 1.0;
    const displayBalance = parseFloat((newBalanceUSD * userRate).toFixed(2));

    // Update Redis
    try {
      const sanitized = {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        currency: savedUser.currency,
        balance: displayBalance,
        baseBalance: newBalanceUSD,
        exchangeRate: userRate,
        gamesPlayed: Number(savedUser.gamesPlayed),
        totalWon: Number(savedUser.totalWon),
        bestMultiplier: Number(savedUser.bestMultiplier),
        createdAt: savedUser.createdAt ? new Date(savedUser.createdAt).getTime() : Date.now(),
      };
      await this.redisService.set(`user:${savedUser.username.toLowerCase()}`, JSON.stringify(sanitized));
      if (savedUser.email) {
        await this.redisService.set(`user:${savedUser.email.toLowerCase()}`, JSON.stringify(sanitized));
      }
    } catch {}

    // Record ledger refund in USD
    try {
      await this.transactionRepo.save({
        userId: savedUser.id,
        type: 'WITHDRAWAL_REFUND',
        amount: refundUSD,
        multiplier: null,
        balanceAfter: newBalanceUSD,
        currency: 'USD',
      });
    } catch {}

    withdrawal.status = WithdrawalStatus.REJECTED;
    withdrawal.adminNote = reason || 'Payment details could not be verified. Funds refunded.';
    withdrawal.processedBy = adminUser;
    withdrawal.processedAt = new Date();
    const savedWithdrawal = await this.withdrawalRepo.save(withdrawal);

    // Notify player that funds were refunded
    this.gameService.notifyUserBalance(
      savedUser.username,
      displayBalance,
      `Withdrawal of ${withdrawal.currency} ${Number(withdrawal.amount).toFixed(2)} rejected (${withdrawal.adminNote}). Funds refunded to your wallet! 🔄`,
      savedUser.currency,
    );

    this.logger.log(`Withdrawal REJECTED & REFUNDED: ${savedWithdrawal.id} for ${savedUser.username}`);

    return {
      success: true,
      message: `Withdrawal rejected and ${withdrawal.currency} ${Number(withdrawal.amount).toFixed(2)} refunded to ${savedUser.username}`,
      withdrawal: savedWithdrawal,
    };
  }

  async clientCancelWithdrawal(
    userId: string,
    withdrawalId: string,
  ): Promise<{ success: boolean; message: string; withdrawal: WithdrawalRequest; newBalance: number }> {
    const withdrawal = await this.withdrawalRepo.findOne({ where: { id: withdrawalId } });
    if (!withdrawal) {
      throw new NotFoundException('Withdrawal request not found');
    }

    if (withdrawal.userId !== userId) {
      throw new BadRequestException('You do not have permission to cancel this withdrawal request.');
    }

    if (withdrawal.status !== WithdrawalStatus.PENDING) {
      throw new BadRequestException(`Withdrawal cannot be cancelled because it is already ${withdrawal.status}.`);
    }

    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User account not found');
    }

    // Instantly refund escrowed amount back to playable balance in USD
    const withdrawCurrency = (withdrawal.currency || 'USD').toUpperCase();
    const rate = PLATFORM_EXCHANGE_RATES[withdrawCurrency] || 1.0;
    const refundUSD = parseFloat((Number(withdrawal.amount) / rate).toFixed(2));
    const prevBalanceUSD = Number(user.balance);
    const newBalanceUSD = parseFloat((prevBalanceUSD + refundUSD).toFixed(2));
    user.balance = newBalanceUSD;
    const savedUser = await this.userRepo.save(user);

    const userRate = PLATFORM_EXCHANGE_RATES[(savedUser.currency || 'USD').toUpperCase()] || 1.0;
    const displayBalance = parseFloat((newBalanceUSD * userRate).toFixed(2));

    // Update Redis Cache
    try {
      const sanitized = {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        currency: savedUser.currency,
        balance: displayBalance,
        baseBalance: newBalanceUSD,
        exchangeRate: userRate,
        gamesPlayed: Number(savedUser.gamesPlayed),
        totalWon: Number(savedUser.totalWon),
        bestMultiplier: Number(savedUser.bestMultiplier),
        createdAt: savedUser.createdAt ? new Date(savedUser.createdAt).getTime() : Date.now(),
      };
      await this.redisService.set(`user:${savedUser.username.toLowerCase()}`, JSON.stringify(sanitized));
      if (savedUser.email) {
        await this.redisService.set(`user:${savedUser.email.toLowerCase()}`, JSON.stringify(sanitized));
      }
    } catch {}

    // Record Transaction Ledger Entry in USD
    try {
      await this.transactionRepo.save({
        userId: savedUser.id,
        type: 'WITHDRAWAL_CANCEL_REFUND',
        amount: refundUSD,
        multiplier: null,
        balanceAfter: newBalanceUSD,
        currency: 'USD',
      });
    } catch (err) {
      this.logger.error('Failed to log WITHDRAWAL_CANCEL_REFUND ledger entry', err);
    }

    // Update Withdrawal Request status to CANCELLED
    withdrawal.status = WithdrawalStatus.CANCELLED;
    withdrawal.adminNote = 'Cancelled by player to return funds to wallet';
    withdrawal.processedBy = `Player (${savedUser.username})`;
    withdrawal.processedAt = new Date();
    const savedWithdrawal = await this.withdrawalRepo.save(withdrawal);

    // Notify player's active game screen in real-time via Socket.IO
    this.gameService.notifyUserBalance(
      savedUser.username,
      displayBalance,
      `Withdrawal cancelled! ${withdrawal.currency} ${Number(withdrawal.amount).toFixed(2)} refunded to your balance. Ready to play! 🔄`,
      savedUser.currency,
    );

    // Notify Next.js Admin Dashboard so admin live table updates
    this.gameService.notifyNewWithdrawal(savedWithdrawal);

    this.logger.log(`Withdrawal CANCELLED by player: ${savedWithdrawal.id} for ${savedUser.username} (+${withdrawal.currency} ${Number(withdrawal.amount).toFixed(2)})`);

    return {
      success: true,
      message: `Withdrawal cancelled! ${withdrawal.currency} ${Number(withdrawal.amount).toFixed(2)} has been restored to your playable wallet balance.`,
      withdrawal: savedWithdrawal,
      newBalance: displayBalance,
    };
  }

  async getClientHistory(userId: string, username: string) {
    const deposits = await this.depositRepo.find({
      where: [{ userId }, { username }],
      order: { createdAt: 'DESC' },
      take: 50,
    });

    const withdrawals = await this.withdrawalRepo.find({
      where: [{ userId }, { username }],
      order: { createdAt: 'DESC' },
      take: 50,
    });

    return {
      deposits,
      withdrawals,
    };
  }

  // -------------------------------------------------------------
  // PHASE 4: FINANCIAL LEDGER INTEGRITY & ANTI-FRAUD ENGINE
  // -------------------------------------------------------------

  async reconcileUserLedger(userId: string) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const txs = await this.transactionRepo.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });

    const userCurrency = (user.currency || 'USD').toUpperCase();
    let currentLedgerCurrency = txs.length > 0 && txs[0].currency ? txs[0].currency.toUpperCase() : userCurrency;
    let calculatedBalance = 0;
    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let totalWins = 0;
    let totalBets = 0;

    for (const tx of txs) {
      const amt = Number(tx.amount);
      const txCurrency = (tx.currency || currentLedgerCurrency).toUpperCase();

      if (tx.type === 'CURRENCY_CONVERSION') {
        // Multi-Currency Checkpoint: User converted currency through official exchange
        // The balance was set to tx.balanceAfter in the new currency
        calculatedBalance = Number(tx.balanceAfter);
        currentLedgerCurrency = (tx.currency || userCurrency).toUpperCase();
        continue;
      }

      // If transaction currency differs from currently tracked ledger currency, normalize it
      let normalizedAmt = amt;
      if (txCurrency !== currentLedgerCurrency) {
        const fromRate = PLATFORM_EXCHANGE_RATES[txCurrency] || 1.0;
        const toRate = PLATFORM_EXCHANGE_RATES[currentLedgerCurrency] || 1.0;
        normalizedAmt = (amt / fromRate) * toRate;
      }

      if (['DEPOSIT', 'MANUAL_CREDIT', 'WITHDRAWAL_REFUND', 'WITHDRAWAL_CANCEL_REFUND'].includes(tx.type)) {
        calculatedBalance += Math.abs(normalizedAmt);
        totalDeposits += Math.abs(normalizedAmt);
      } else if (['CASHOUT', 'CANCEL_BET', 'BONUS'].includes(tx.type)) {
        calculatedBalance += Math.abs(normalizedAmt);
        totalWins += Math.abs(normalizedAmt);
      } else if (tx.type === 'BET') {
        calculatedBalance -= Math.abs(normalizedAmt);
        totalBets += Math.abs(normalizedAmt);
      } else if (['WITHDRAWAL', 'WITHDRAWAL_ESCROW'].includes(tx.type)) {
        calculatedBalance -= Math.abs(normalizedAmt);
        totalWithdrawals += Math.abs(normalizedAmt);
      }
    }

    // Convert accumulated ledger balance to user's current currency if there's any residual discrepancy
    if (currentLedgerCurrency !== userCurrency) {
      const fromRate = PLATFORM_EXCHANGE_RATES[currentLedgerCurrency] || 1.0;
      const toRate = PLATFORM_EXCHANGE_RATES[userCurrency] || 1.0;
      calculatedBalance = (calculatedBalance / fromRate) * toRate;
    }

    calculatedBalance = parseFloat(calculatedBalance.toFixed(2));
    const currentBalance = Number(user.balance);
    const variance = parseFloat(Math.abs(currentBalance - calculatedBalance).toFixed(2));
    // Tolerance of 0.10 for standard floating-point conversion roundings
    const isClean = variance <= 0.10;

    if (!isClean && !user.isFrozen) {
      user.isFrozen = true;
      user.freezeReason = `Automated Security Audit: Ledger variance of ${userCurrency} ${variance.toFixed(2)} detected (Balance: ${currentBalance}, Ledger: ${calculatedBalance})`;
      user.isFlaggedForReview = true;
      user.flaggedReason = `Ledger discrepancy: ${userCurrency} ${variance.toFixed(2)}`;
      await this.userRepo.save(user);
      this.logger.error(`🚨 FRAUD ALARM: User ${user.username} frozen! Balance: ${currentBalance} ${userCurrency}, Ledger: ${calculatedBalance}, Variance: ${variance}`);
    } else if (isClean && user.isFrozen && user.freezeReason?.includes('Automated Security Audit: Ledger variance')) {
      // Auto-recovery: User was suspended due to a false-positive ledger variance before multi-currency awareness
      user.isFrozen = false;
      user.freezeReason = null as any;
      user.isFlaggedForReview = false;
      user.flaggedReason = null as any;
      await this.userRepo.save(user);
      try {
        await this.redisService.del(`user:${user.username.toLowerCase()}`);
        if (user.email) await this.redisService.del(`user:${user.email.toLowerCase()}`);
      } catch {}
      this.logger.log(`🛡️ AUTO-RECOVERY: User ${user.username} successfully unfrozen after multi-currency reconciliation verified clean ledger!`);
    }

    return {
      userId: user.id,
      username: user.username,
      currency: userCurrency,
      currentBalance,
      calculatedBalance,
      variance,
      isClean,
      isFrozen: user.isFrozen,
      freezeReason: user.freezeReason,
      totalDeposits: parseFloat(totalDeposits.toFixed(2)),
      totalWithdrawals: parseFloat(totalWithdrawals.toFixed(2)),
      totalBets: parseFloat(totalBets.toFixed(2)),
      totalWins: parseFloat(totalWins.toFixed(2)),
      transactionCount: txs.length,
    };
  }

  async runFullSystemReconciliation() {
    this.logger.log('🔍 Starting system-wide financial ledger reconciliation...');
    const users = await this.userRepo.find();
    let reconciledCount = 0;
    let flaggedCount = 0;
    const discrepancies: any[] = [];

    for (const user of users) {
      try {
        const result = await this.reconcileUserLedger(user.id);
        if (result.isClean) {
          reconciledCount++;
        } else {
          flaggedCount++;
          discrepancies.push(result);
        }
      } catch (err) {
        this.logger.error(`Failed to reconcile user ${user.id}`, err);
      }
    }

    this.logger.log(`✅ Reconciliation finished: ${reconciledCount} passed, ${flaggedCount} flagged out of ${users.length} total users.`);

    return {
      totalUsersChecked: users.length,
      reconciledCount,
      flaggedCount,
      discrepancies,
      auditedAt: new Date().toISOString(),
    };
  }

  async getFraudAlerts() {
    const users = await this.userRepo.find({
      order: { createdAt: 'DESC' },
    });

    const alerts: any[] = [];

    // 1. Check for frozen or flagged accounts
    for (const user of users) {
      if (user.isFrozen || user.isFlaggedForReview) {
        alerts.push({
          type: 'ACCOUNT_FROZEN_OR_FLAGGED',
          severity: 'HIGH',
          userId: user.id,
          username: user.username,
          currency: user.currency,
          balance: Number(user.balance),
          reason: user.freezeReason || user.flaggedReason || 'Account under review',
          createdAt: user.createdAt,
        });
      }
    }

    // 2. Sybil / Multi-account detection: users sharing same withdrawal account
    const accountMap = new Map<string, string[]>();
    for (const user of users) {
      if (user.savedWithdrawalDetails?.accountNumber) {
        const accNum = String(user.savedWithdrawalDetails.accountNumber).trim();
        if (accNum.length > 4) {
          if (!accountMap.has(accNum)) {
            accountMap.set(accNum, []);
          }
          accountMap.get(accNum)!.push(user.username);
        }
      }
    }

    for (const [accNum, usernames] of accountMap.entries()) {
      if (usernames.length > 1) {
        alerts.push({
          type: 'SHARED_BANK_ACCOUNT',
          severity: 'CRITICAL',
          details: `Bank account/phone "${accNum}" is shared by ${usernames.length} different users: [${usernames.join(', ')}]`,
          usernames,
        });
      }
    }

    // 3. Statistical win anomaly detection
    for (const user of users) {
      const games = Number(user.gamesPlayed);
      const won = Number(user.totalWon);
      const balance = Number(user.balance);

      if (games >= 5 && won > 50000 && balance > 50000) {
        alerts.push({
          type: 'HIGH_ROLLER_WIN_STREAK',
          severity: 'MEDIUM',
          userId: user.id,
          username: user.username,
          details: `Player won ${won} across ${games} games. Best multiplier: ${user.bestMultiplier}x.`,
        });
      }
    }

    return {
      alerts,
      totalAlerts: alerts.length,
      auditedAt: new Date().toISOString(),
    };
  }

  async freezeUser(userId: string, reason: string, adminUser: string = 'Admin') {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    user.isFrozen = true;
    user.freezeReason = reason || 'Suspended by Administrator';
    user.isFlaggedForReview = true;
    const saved = await this.userRepo.save(user);

    try {
      await this.redisService.del(`token:*`);
      await this.redisService.del(`user:${user.username.toLowerCase()}`);
    } catch {}

    this.logger.warn(`User ${user.username} frozen by ${adminUser}: ${reason}`);
    return saved;
  }

  async unfreezeUser(userId: string, adminUser: string = 'Admin') {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    user.isFrozen = false;
    user.freezeReason = null as any;
    user.isFlaggedForReview = false;
    user.flaggedReason = null as any;
    const saved = await this.userRepo.save(user);

    this.logger.log(`User ${user.username} unfrozen by ${adminUser}`);
    return saved;
  }

  async toggleMarketingStatus(
    userId: string,
    isMarketing: boolean,
    isMarketingAutoWin: boolean,
    adminUser: string = 'Admin',
  ) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    user.isMarketing = isMarketing;
    user.isMarketingAutoWin = isMarketing ? isMarketingAutoWin : false;
    const saved = await this.userRepo.save(user);

    try {
      const sanitized = {
        id: saved.id,
        username: saved.username,
        email: saved.email,
        phoneNumber: saved.phoneNumber,
        currency: saved.currency,
        balance: Number(saved.balance),
        gamesPlayed: Number(saved.gamesPlayed),
        totalWon: Number(saved.totalWon),
        bestMultiplier: Number(saved.bestMultiplier),
        createdAt: saved.createdAt ? new Date(saved.createdAt).getTime() : Date.now(),
        savedWithdrawalDetails: saved.savedWithdrawalDetails,
        isFrozen: saved.isFrozen,
        isMarketing: saved.isMarketing,
        isMarketingAutoWin: saved.isMarketingAutoWin,
      };
      await this.redisService.set(`user:${saved.username.toLowerCase()}`, JSON.stringify(sanitized));
      if (saved.email) {
        await this.redisService.set(`user:${saved.email.toLowerCase()}`, JSON.stringify(sanitized));
      }
    } catch {}

    this.logger.log(
      `Marketing status for user ${user.username} updated: isMarketing=${saved.isMarketing}, isMarketingAutoWin=${saved.isMarketingAutoWin} by ${adminUser}`,
    );
    return {
      success: true,
      message: `Marketing status updated for ${user.username}`,
      user: saved,
    };
  }

  async adjustUserBalance(
    userId: string,
    action: 'RESET_ZERO' | 'SET_AMOUNT' | 'DEDUCT',
    amount?: number,
    reason: string = 'Administrative Balance Adjustment',
    adminUser: string = 'Admin',
  ) {
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const currentBalance = Number(user.balance);
    let newBalance = currentBalance;
    let delta = 0;

    if (action === 'RESET_ZERO') {
      newBalance = 0;
      delta = -currentBalance;
    } else if (action === 'SET_AMOUNT') {
      const target = Number(amount);
      if (isNaN(target) || target < 0) {
        throw new BadRequestException('Target amount must be a positive number');
      }
      newBalance = parseFloat(target.toFixed(2));
      delta = parseFloat((newBalance - currentBalance).toFixed(2));
    } else if (action === 'DEDUCT') {
      const deductAmt = Number(amount);
      if (isNaN(deductAmt) || deductAmt <= 0) {
        throw new BadRequestException('Deduct amount must be greater than zero');
      }
      newBalance = Math.max(0, parseFloat((currentBalance - deductAmt).toFixed(2)));
      delta = parseFloat((newBalance - currentBalance).toFixed(2));
    } else {
      throw new BadRequestException('Invalid balance adjustment action');
    }

    let savedUser: User | null = null;
    await this.userRepo.manager.transaction(async (manager) => {
      const lockedUser = await manager.findOne(User, {
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedUser) throw new NotFoundException('User not found during transaction');

      lockedUser.balance = newBalance;
      savedUser = await manager.save(lockedUser);

      await manager.save(Transaction, {
        userId: savedUser.id,
        type: action === 'RESET_ZERO' ? 'ADMIN_RESET' : (delta < 0 ? 'ADMIN_DEDUCT' : 'ADMIN_CREDIT'),
        amount: delta,
        currency: 'USD',
        multiplier: null,
        balanceAfter: newBalance,
      });
    });

    if (!savedUser) throw new BadRequestException('Failed to adjust balance');
    const userObj: User = savedUser;

    const userCurr = (userObj.currency || 'USD').toUpperCase();
    const rate = PLATFORM_EXCHANGE_RATES[userCurr] || 1.0;
    const displayBal = parseFloat((newBalance * rate).toFixed(2));

    try {
      const sanitized = {
        id: userObj.id,
        username: userObj.username,
        email: userObj.email,
        phoneNumber: userObj.phoneNumber,
        currency: userCurr,
        balance: displayBal,
        baseBalance: Number(userObj.balance),
        exchangeRate: rate,
        gamesPlayed: Number(userObj.gamesPlayed),
        totalWon: Number(userObj.totalWon),
        bestMultiplier: Number(userObj.bestMultiplier),
        createdAt: userObj.createdAt ? new Date(userObj.createdAt).getTime() : Date.now(),
        savedWithdrawalDetails: userObj.savedWithdrawalDetails,
        isFrozen: userObj.isFrozen,
        isMarketing: userObj.isMarketing,
        isMarketingAutoWin: userObj.isMarketingAutoWin,
      };
      await this.redisService.set(`user:${userObj.username.toLowerCase()}`, JSON.stringify(sanitized));
      if (userObj.email) {
        await this.redisService.set(`user:${userObj.email.toLowerCase()}`, JSON.stringify(sanitized));
      }
    } catch {}

    this.gameService.notifyUserBalance(
      userObj.username,
      displayBal,
      `Wallet balance updated to $${newBalance.toFixed(2)} USD (${userCurr} ${displayBal.toFixed(2)}) (${reason})`,
      userCurr,
    );

    this.logger.log(
      `Balance adjusted for ${user.username}: ${currentBalance} -> ${newBalance} (delta: ${delta}) by ${adminUser}. Reason: ${reason}`,
    );

    return {
      success: true,
      message: `Balance adjusted for ${user.username} to ${newBalance.toFixed(2)}`,
      oldBalance: currentBalance,
      newBalance,
      delta,
      user: userObj,
    };
  }
}

