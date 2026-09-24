import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { Transaction } from '../auth/entities/transaction.entity';
import { DepositRequest, DepositStatus } from '../auth/entities/deposit-request.entity';
import { WithdrawalRequest, WithdrawalStatus } from '../auth/entities/withdrawal-request.entity';
import { RedisService } from '../redis/redis.service';
import { GameService } from '../game/game.service';

export interface PaymentChannel {
  id: string;
  name: string;
  type: string;
  badge: string;
  accountNumber: string;
  accountName: string;
  instructions: string;
  iconName: string;
}

@Injectable()
export class AdminService {
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
    private readonly redisService: RedisService,
    private readonly gameService: GameService,
  ) {}

  getPaymentChannels(): PaymentChannel[] {
    return [
      {
        id: 'ipay',
        name: 'iPay (Sri Lanka)',
        type: 'ipay',
        badge: 'Instant QR / App',
        accountNumber: 'IPAY-784210',
        accountName: 'SkyRush Entertainment LK',
        instructions: 'Open your iPay app, choose Pay Merchant, enter Merchant ID IPAY-784210, include your Gamer Tag as remark, and submit the iPay Reference Number below.',
        iconName: 'qr_code_scanner',
      },
      {
        id: 'upay',
        name: 'UPay (Sri Lanka)',
        type: 'upay',
        badge: 'Mobile Transfer',
        accountNumber: '077 123 4567',
        accountName: 'SkyRush Official UPay',
        instructions: 'Open your UPay app, send money to mobile number 0771234567 with your Gamer Tag in description, and copy the transaction reference number below.',
        iconName: 'phone_android',
      },
      {
        id: 'bank_transfer',
        name: 'Commercial Bank of Ceylon',
        type: 'bank_transfer',
        badge: 'Direct Bank / CDM',
        accountNumber: '1000 2489 3104',
        accountName: 'SkyRush Interactive LK (Pvt) Ltd',
        instructions: 'Transfer via online banking or CDM. Bank: Commercial Bank, Kollupitiya Branch. Enter your Gamer Tag in the transfer remark and submit the deposit reference.',
        iconName: 'account_balance',
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
      where: { referenceNumber: cleanRef, status: DepositStatus.APPROVED },
    });
    if (existing) {
      throw new BadRequestException('This transaction reference has already been approved and credited');
    }

    const newDeposit = this.depositRepo.create({
      userId,
      username,
      email: email || undefined,
      amount: cleanAmount,
      currency: (currency || 'LKR').toUpperCase(),
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
    const pendingDeposits = await this.depositRepo.count({ where: { status: DepositStatus.PENDING } });
    const approvedDeposits = await this.depositRepo.count({ where: { status: DepositStatus.APPROVED } });

    const approvedList = await this.depositRepo.find({ where: { status: DepositStatus.APPROVED } });
    const totalDepositedAmount = approvedList.reduce((sum, d) => sum + Number(d.amount), 0);

    const pendingWithdrawals = await this.withdrawalRepo.count({ where: { status: WithdrawalStatus.PENDING } });
    const paidWithdrawals = await this.withdrawalRepo.count({ where: { status: WithdrawalStatus.PAID } });

    const paidWithdrawalList = await this.withdrawalRepo.find({ where: { status: WithdrawalStatus.PAID } });
    const totalWithdrawnAmount = paidWithdrawalList.reduce((sum, w) => sum + Number(w.amount), 0);

    const allUsers = await this.userRepo.find();
    const totalSystemBalance = allUsers.reduce((sum, u) => sum + Number(u.balance), 0);

    return {
      totalUsers,
      pendingDeposits,
      approvedDeposits,
      totalDepositedAmount,
      pendingWithdrawals,
      paidWithdrawals,
      totalWithdrawnAmount,
      totalSystemBalance,
    };
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
    const prevBalance = Number(user.balance);
    const newBalance = parseFloat((prevBalance + depositAmount).toFixed(2));

    // Atomically update user balance in PostgreSQL
    user.balance = newBalance;
    const savedUser = await this.userRepo.save(user);

    // Update Redis Cache
    try {
      const sanitized = {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        currency: savedUser.currency,
        balance: Number(savedUser.balance),
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

    // Save transaction ledger entry
    try {
      await this.transactionRepo.save({
        userId: savedUser.id,
        type: 'DEPOSIT',
        amount: depositAmount,
        multiplier: null,
        balanceAfter: newBalance,
        currency: deposit.currency,
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
    this.gameService.notifyUserBalance(
      savedUser.username,
      newBalance,
      `Deposit of ${deposit.currency} ${depositAmount.toFixed(2)} approved! Your wallet has been credited. 💰`,
    );

    this.logger.log(`Deposit APPROVED: ${savedDeposit.id} for ${savedUser.username} (+${savedDeposit.currency} ${depositAmount}). New Balance: ${newBalance}`);

    return {
      success: true,
      message: `Deposit of ${savedDeposit.currency} ${depositAmount.toFixed(2)} approved successfully for ${savedUser.username}!`,
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
    const cleanAmount = Number(amount);

    if (!clean) {
      throw new BadRequestException('Please provide a username or email to credit');
    }
    if (!cleanAmount || cleanAmount <= 0) {
      throw new BadRequestException('Credit amount must be greater than zero');
    }

    const user = await this.userRepo.findOne({
      where: [{ username: ILike(clean) }, { email: ILike(clean) }],
    });

    if (!user) {
      throw new NotFoundException(`User '${clean}' not found in database`);
    }

    const prevBalance = Number(user.balance);
    const newBalance = parseFloat((prevBalance + cleanAmount).toFixed(2));
    user.balance = newBalance;
    const savedUser = await this.userRepo.save(user);

    // Update Redis
    try {
      const sanitized = {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        currency: savedUser.currency,
        balance: Number(savedUser.balance),
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

    // Record ledger transaction
    try {
      await this.transactionRepo.save({
        userId: savedUser.id,
        type: 'MANUAL_DEPOSIT',
        amount: cleanAmount,
        multiplier: null,
        balanceAfter: newBalance,
        currency: savedUser.currency,
      });
    } catch {}

    // Create an approved deposit audit record
    try {
      await this.depositRepo.save({
        userId: savedUser.id,
        username: savedUser.username,
        email: savedUser.email || undefined,
        amount: cleanAmount,
        currency: savedUser.currency,
        paymentMethod: 'admin_manual',
        referenceNumber: `ADMIN-${Date.now()}`,
        status: DepositStatus.APPROVED,
        adminNote: note || 'Direct admin manual credit',
        approvedBy: adminUser,
        approvedAt: new Date(),
      });
    } catch {}

    // Real-time WebSocket notify
    this.gameService.notifyUserBalance(
      savedUser.username,
      newBalance,
      `Admin credited ${savedUser.currency} ${cleanAmount.toFixed(2)} to your wallet! 💰`,
    );

    this.logger.log(`Manual credit: ${adminUser} added ${savedUser.currency} ${cleanAmount} to ${savedUser.username}. New balance: ${newBalance}`);

    return {
      success: true,
      message: `Successfully credited ${savedUser.currency} ${cleanAmount.toFixed(2)} to ${savedUser.username}!`,
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
  ): Promise<WithdrawalRequest> {
    const cleanAmount = Number(amount);
    if (!cleanAmount || cleanAmount < 2500) {
      throw new BadRequestException('Minimum withdrawal amount is 2500');
    }

    if (!payoutDetails) {
      throw new BadRequestException('Payout details are required');
    }

    const user = await this.userRepo.findOne({ where: [{ id: userId }, { username }] });
    if (!user) {
      throw new NotFoundException('User account not found');
    }

    const currentBalance = Number(user.balance);
    if (currentBalance < cleanAmount) {
      throw new BadRequestException(`Insufficient wallet balance. Available: ${user.currency} ${currentBalance.toFixed(2)}`);
    }

    // Atomically hold/deduct the requested amount from active wallet balance
    const newBalance = parseFloat((currentBalance - cleanAmount).toFixed(2));
    user.balance = newBalance;
    const savedUser = await this.userRepo.save(user);

    // Update Redis
    try {
      const sanitized = {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        currency: savedUser.currency,
        balance: Number(savedUser.balance),
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

    // Record transaction ledger (escrow hold)
    try {
      await this.transactionRepo.save({
        userId: savedUser.id,
        type: 'WITHDRAWAL_ESCROW',
        amount: -cleanAmount,
        multiplier: null,
        balanceAfter: newBalance,
        currency: currency || user.currency || 'LKR',
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
      currency: (currency || user.currency || 'LKR').toUpperCase(),
      method: method || 'bank_transfer',
      payoutDetails: detailsString,
      status: WithdrawalStatus.PENDING,
    });

    const savedWithdrawal = await this.withdrawalRepo.save(newWithdrawal);
    this.logger.log(`New withdrawal request: ${savedUser.username} - ${savedWithdrawal.currency} ${cleanAmount} (${method})`);

    // Notify player's active game screen of updated balance
    this.gameService.notifyUserBalance(
      savedUser.username,
      newBalance,
      `Withdrawal request for ${savedWithdrawal.currency} ${cleanAmount.toFixed(2)} submitted. Your wallet is held in escrow. ⏳`,
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

    // Record ledger finalized entry
    try {
      await this.transactionRepo.save({
        userId: withdrawal.userId,
        type: 'WITHDRAWAL_PAID',
        amount: -Number(withdrawal.amount),
        multiplier: null,
        balanceAfter: 0,
        currency: withdrawal.currency,
      });
    } catch {}

    // Real-time notification to player: Money has been sent!
    const user = await this.userRepo.findOne({ where: { id: withdrawal.userId } });
    if (user) {
      this.gameService.notifyUserBalance(
        user.username,
        Number(user.balance),
        `Your withdrawal of ${withdrawal.currency} ${Number(withdrawal.amount).toFixed(2)} has been transferred to your account! 💸`,
      );
    }

    this.logger.log(`Withdrawal PAID: ${savedWithdrawal.id} for ${withdrawal.username} (${withdrawal.currency} ${withdrawal.amount})`);

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

    // REFUND amount back to active wallet balance!
    const refundAmount = Number(withdrawal.amount);
    const prevBalance = Number(user.balance);
    const newBalance = parseFloat((prevBalance + refundAmount).toFixed(2));
    user.balance = newBalance;
    const savedUser = await this.userRepo.save(user);

    // Update Redis
    try {
      const sanitized = {
        id: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        phoneNumber: savedUser.phoneNumber,
        currency: savedUser.currency,
        balance: Number(savedUser.balance),
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

    // Record ledger refund
    try {
      await this.transactionRepo.save({
        userId: savedUser.id,
        type: 'WITHDRAWAL_REFUND',
        amount: refundAmount,
        multiplier: null,
        balanceAfter: newBalance,
        currency: withdrawal.currency,
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
      newBalance,
      `Withdrawal of ${withdrawal.currency} ${refundAmount.toFixed(2)} rejected (${withdrawal.adminNote}). Funds refunded to your wallet! 🔄`,
    );

    this.logger.log(`Withdrawal REJECTED & REFUNDED: ${savedWithdrawal.id} for ${savedUser.username}`);

    return {
      success: true,
      message: `Withdrawal rejected and ${withdrawal.currency} ${refundAmount.toFixed(2)} refunded to ${savedUser.username}`,
      withdrawal: savedWithdrawal,
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
}
