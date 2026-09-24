import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Res,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { RedisService } from '../redis/redis.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../auth/entities/user.entity';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly redisService: RedisService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  // -------------------------------------------------------------
  // CLIENT FACING DEPOSIT ENDPOINTS
  // -------------------------------------------------------------

  @Get('channels')
  getClientChannels() {
    return {
      success: true,
      channels: this.adminService.getPaymentChannels(),
    };
  }

  @Post('deposit-request')
  async submitClientDeposit(
    @Body()
    body: {
      token: string;
      amount: number;
      currency?: string;
      paymentMethod: string;
      referenceNumber: string;
    },
  ) {
    if (!body.token) {
      throw new UnauthorizedException('Please log in to submit a deposit request');
    }

    let username: string | null = null;
    try {
      username = await this.redisService.get(`token:${body.token}`);
    } catch {}

    if (!username) {
      throw new UnauthorizedException('Session expired. Please log in again.');
    }

    const user = await this.userRepo.findOne({ where: { username } });
    if (!user) {
      throw new UnauthorizedException('User account not found');
    }

    const deposit = await this.adminService.clientSubmitDeposit(
      user.id,
      user.username,
      user.email,
      body.amount,
      body.currency || user.currency || 'LKR',
      body.paymentMethod,
      body.referenceNumber,
    );

    return {
      success: true,
      message: 'Deposit request submitted successfully! An administrator will verify and credit your wallet shortly.',
      deposit,
    };
  }

  @Post('withdrawal-request')
  async submitClientWithdrawal(
    @Body()
    body: {
      token: string;
      amount: number;
      currency?: string;
      method: string;
      payoutDetails: any;
    },
  ) {
    if (!body.token) {
      throw new UnauthorizedException('Please log in to submit a withdrawal request');
    }

    let username: string | null = null;
    try {
      username = await this.redisService.get(`token:${body.token}`);
    } catch {}

    if (!username) {
      throw new UnauthorizedException('Session expired. Please log in again.');
    }

    const user = await this.userRepo.findOne({ where: { username } });
    if (!user) {
      throw new UnauthorizedException('User account not found');
    }

    const withdrawal = await this.adminService.clientSubmitWithdrawal(
      user.id,
      user.username,
      user.email,
      body.amount,
      body.currency || user.currency || 'LKR',
      body.method,
      body.payoutDetails,
      body.saveDetails,
    );

    return {
      success: true,
      message: 'Withdrawal request submitted! Funds have been placed in escrow pending transfer.',
      withdrawal,
    };
  }

  @Get('my-history')
  async getMyHistory(@Query('token') token?: string) {
    if (!token) {
      throw new UnauthorizedException('Session token required');
    }

    let username: string | null = null;
    try {
      username = await this.redisService.get(`token:${token}`);
    } catch {}

    if (!username) {
      throw new UnauthorizedException('Session expired. Please log in again.');
    }

    const user = await this.userRepo.findOne({ where: { username } });
    if (!user) {
      throw new UnauthorizedException('User account not found');
    }

    const history = await this.adminService.getClientHistory(user.id, user.username);
    return {
      success: true,
      ...history,
    };
  }

  // -------------------------------------------------------------
  // ADMIN REST APIS
  // -------------------------------------------------------------

  @Get('api/stats')
  async getStats() {
    return this.adminService.getDashboardStats();
  }

  @Get('api/deposits')
  async getDeposits(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const numLimit = limit ? parseInt(limit, 10) : 100;
    return this.adminService.getDeposits(status, numLimit);
  }

  @Get('api/withdrawals')
  async getWithdrawals(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const numLimit = limit ? parseInt(limit, 10) : 100;
    return this.adminService.getWithdrawals(status, numLimit);
  }

  @Post('api/withdrawals/:id/approve')
  async approveWithdrawal(
    @Param('id') id: string,
    @Body() body: { adminNote?: string; adminUser?: string },
  ) {
    return this.adminService.approveWithdrawal(id, body?.adminNote, body?.adminUser || 'Admin');
  }

  @Post('api/withdrawals/:id/reject')
  async rejectWithdrawal(
    @Param('id') id: string,
    @Body() body: { reason?: string; adminUser?: string },
  ) {
    return this.adminService.rejectWithdrawal(id, body?.reason, body?.adminUser || 'Admin');
  }

  @Post('api/deposits/:id/approve')
  async approveDeposit(
    @Param('id') id: string,
    @Body() body: { adminUser?: string },
  ) {
    return this.adminService.approveDeposit(id, body?.adminUser || 'Admin');
  }

  @Post('api/deposits/:id/reject')
  async rejectDeposit(
    @Param('id') id: string,
    @Body() body: { reason?: string; adminUser?: string },
  ) {
    return this.adminService.rejectDeposit(id, body?.reason, body?.adminUser || 'Admin');
  }

  @Post('api/manual-credit')
  async manualCredit(
    @Body()
    body: {
      identifier: string;
      amount: number;
      note?: string;
      adminUser?: string;
    },
  ) {
    return this.adminService.manualCredit(
      body.identifier,
      body.amount,
      body.note,
      body?.adminUser || 'Admin',
    );
  }

  @Get('api/users')
  async getUsers(
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    const numLimit = limit ? parseInt(limit, 10) : 50;
    return this.adminService.getUsers(search, numLimit);
  }

  // -------------------------------------------------------------
  // WEB ADMIN DASHBOARD UI (SERVED AT GET /admin)
  // -------------------------------------------------------------

  @Get()
  renderDashboard(@Res() res: any) {
    res.setHeader('Content-Type', 'text/html');
    return res.send(this.getDashboardHtml());
  }

  private getDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SkyRush Aviator - Admin Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #0a0e17;
      --card-bg: rgba(18, 25, 38, 0.85);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --success-hover: #059669;
      --warning: #f59e0b;
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #8b5cf6;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background: #080c14;
      background-image: 
        radial-gradient(circle at 15% 15%, rgba(59, 130, 246, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 85% 85%, rgba(139, 92, 246, 0.08) 0%, transparent 40%);
      font-family: 'Outfit', sans-serif;
      color: var(--text);
      min-height: 100vh;
      padding-bottom: 60px;
    }
    .header {
      background: rgba(13, 18, 29, 0.95);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--card-border);
      padding: 18px 36px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .brand-icon {
      width: 42px;
      height: 42px;
      background: linear-gradient(135deg, #ef4444, #f97316);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 4px 15px rgba(239, 68, 68, 0.35);
    }
    .brand-title {
      font-size: 22px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(90deg, #ffffff, #93c5fd);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .brand-subtitle {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--text-muted);
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .live-badge {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      color: #34d399;
      font-weight: 600;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background: #10b981;
      border-radius: 50%;
      box-shadow: 0 0 10px #10b981;
      animation: pulse 1.8s infinite;
    }
    @keyframes pulse {
      0% { opacity: 0.4; transform: scale(0.9); }
      50% { opacity: 1; transform: scale(1.2); }
      100% { opacity: 0.4; transform: scale(0.9); }
    }
    .btn {
      padding: 9px 18px;
      border-radius: 8px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .btn-primary {
      background: var(--primary);
      color: white;
    }
    .btn-primary:hover {
      background: var(--primary-hover);
      transform: translateY(-1px);
    }
    .btn-success {
      background: var(--success);
      color: white;
    }
    .btn-success:hover {
      background: var(--success-hover);
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .btn-danger:hover {
      background: var(--danger);
      color: white;
    }
    .container {
      max-width: 1400px;
      margin: 32px auto;
      padding: 0 24px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 20px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 22px;
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      position: relative;
      overflow: hidden;
    }
    .stat-card::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, transparent, var(--card-accent, var(--primary)), transparent);
    }
    .stat-label {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #fff;
    }
    .stat-highlight {
      color: var(--warning);
      animation: soft-pulse 2s infinite ease-in-out;
    }
    @keyframes soft-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .main-grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 28px;
      margin-bottom: 32px;
    }
    @media (max-width: 1024px) {
      .main-grid { grid-template-columns: 1fr; }
    }
    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 24px;
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .section-title {
      font-size: 18px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge-count {
      background: #ef4444;
      color: white;
      font-size: 12px;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th {
      text-align: left;
      padding: 12px 14px;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    td {
      padding: 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      vertical-align: middle;
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .pill {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .pill-ipay {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }
    .pill-upay {
      background: rgba(139, 92, 246, 0.15);
      color: #a78bfa;
      border: 1px solid rgba(139, 92, 246, 0.3);
    }
    .pill-bank {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    .pill-manual {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }
    .pill-approved {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
    }
    .pill-pending {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
    }
    .pill-rejected {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
    }
    .ref-code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      font-weight: 600;
      color: #93c5fd;
      background: rgba(147, 197, 253, 0.08);
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px dashed rgba(147, 197, 253, 0.25);
    }
    .form-group {
      margin-bottom: 16px;
    }
    .form-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .form-input {
      width: 100%;
      padding: 10px 14px;
      background: rgba(10, 14, 23, 0.8);
      border: 1px solid var(--card-border);
      border-radius: 8px;
      font-family: inherit;
      font-size: 14px;
      color: #fff;
      outline: none;
      transition: border-color 0.2s;
    }
    .form-input:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
    }
    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 16px;
    }
    .tab-btn {
      padding: 8px 16px;
      background: transparent;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      color: var(--text-muted);
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      transition: all 0.2s;
    }
    .tab-btn.active {
      background: var(--primary);
      color: white;
      border-color: var(--primary);
    }
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-muted);
      font-size: 15px;
    }
    .empty-state-icon {
      font-size: 40px;
      margin-bottom: 12px;
      opacity: 0.6;
    }
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: rgba(16, 185, 129, 0.95);
      color: white;
      padding: 14px 22px;
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      font-weight: 600;
      display: none;
      z-index: 100;
      animation: slideUp 0.3s ease;
    }
    .toast.error {
      background: rgba(239, 68, 68, 0.95);
    }
    @keyframes slideUp {
      from { transform: translateY(20px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  </style>
</head>
<body>

  <header class="header">
    <div class="brand">
      <div class="brand-icon">✈️</div>
      <div>
        <div class="brand-title">SkyRush Aviator</div>
        <div class="brand-subtitle">Deposit Management & Player Operations</div>
      </div>
    </div>
    <div class="header-actions">
      <div class="live-badge">
        <div class="pulse-dot"></div>
        Live Server Connected
      </div>
      <button class="btn btn-primary" onclick="loadAllData()">
        🔄 Refresh
      </button>
    </div>
  </header>

  <div class="container">
    <!-- STATS ROW -->
    <div class="stats-grid">
      <div class="stat-card" style="--card-accent: #ef4444;">
        <div class="stat-label">Pending Approval Requests</div>
        <div class="stat-value stat-highlight" id="stat-pending">0</div>
      </div>
      <div class="stat-card" style="--card-accent: #10b981;">
        <div class="stat-label">Total Approved Deposits</div>
        <div class="stat-value" id="stat-approved">0</div>
      </div>
      <div class="stat-card" style="--card-accent: #3b82f6;">
        <div class="stat-label">Total Deposited Volume</div>
        <div class="stat-value" id="stat-volume">LKR 0.00</div>
      </div>
      <div class="stat-card" style="--card-accent: #8b5cf6;">
        <div class="stat-label">Registered Players</div>
        <div class="stat-value" id="stat-users">0</div>
      </div>
      <div class="stat-card" style="--card-accent: #f59e0b;">
        <div class="stat-label">Total Player Wallets Balance</div>
        <div class="stat-value" id="stat-balance">LKR 0.00</div>
      </div>
    </div>

    <!-- MAIN TWO COLUMN SECTION -->
    <div class="main-grid">
      <!-- LEFT: PENDING DEPOSITS QUEUE -->
      <div class="section-card">
        <div class="section-header">
          <div class="section-title">
            <span>⚡ Pending Deposit Approvals</span>
            <span class="badge-count" id="pending-badge">0</span>
          </div>
          <span style="font-size: 13px; color: var(--text-muted);">Real-time action queue</span>
        </div>

        <div style="overflow-x: auto;">
          <table id="pending-table">
            <thead>
              <tr>
                <th>Player</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Reference / Slip</th>
                <th>Submitted</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody id="pending-tbody">
              <tr>
                <td colspan="6" class="empty-state">
                  <div class="empty-state-icon">⏳</div>
                  Loading pending requests...
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- RIGHT: MANUAL PLAYER CREDIT FORM -->
      <div class="section-card">
        <div class="section-header">
          <div class="section-title">
            <span>💳 Direct Wallet Credit</span>
          </div>
          <span style="font-size: 12px; color: #93c5fd; background: rgba(59, 130, 246, 0.1); padding: 3px 8px; border-radius: 6px;">Instant Credit</span>
        </div>

        <form id="manual-credit-form" onsubmit="handleManualCredit(event)">
          <div class="form-group">
            <label class="form-label">Player Username or Mobile / Email</label>
            <input type="text" id="credit-user" class="form-input" placeholder="e.g. 0771234567 or player1" required>
          </div>

          <div class="form-group">
            <label class="form-label">Credit Amount (LKR)</label>
            <input type="number" id="credit-amount" class="form-input" placeholder="e.g. 1000" min="1" step="any" required>
          </div>

          <div class="form-group">
            <label class="form-label">Admin Reason / Remark</label>
            <input type="text" id="credit-note" class="form-input" placeholder="e.g. Direct CDM deposit confirmation / VIP top up">
          </div>

          <button type="submit" class="btn btn-success" style="width: 100%; justify-content: center; padding: 12px; font-size: 15px;">
            💰 Credit Player Wallet Now
          </button>
        </form>

        <div style="margin-top: 24px; padding: 14px; background: rgba(255,255,255,0.03); border-radius: 10px; border: 1px dashed rgba(255,255,255,0.08); font-size: 13px; color: var(--text-muted); line-height: 1.5;">
          ℹ️ <b>Instant Update:</b> When you approve a deposit or make a direct wallet credit, the player's game screen will automatically update its credit balance via WebSocket in real-time without requiring a page refresh!
        </div>
      </div>
    </div>

    <!-- LOWER SECTION: DEPOSIT HISTORY & REGISTERED USERS -->
    <div class="section-card" style="margin-bottom: 32px;">
      <div class="section-header">
        <div class="section-title">
          <span>📜 Deposit Logs & History</span>
        </div>
        <div class="tabs">
          <button class="tab-btn active" onclick="setHistoryFilter('ALL', this)">All</button>
          <button class="tab-btn" onclick="setHistoryFilter('APPROVED', this)">Approved</button>
          <button class="tab-btn" onclick="setHistoryFilter('REJECTED', this)">Rejected</button>
          <button class="tab-btn" onclick="setHistoryFilter('PENDING', this)">Pending</button>
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table id="history-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Player</th>
              <th>Amount</th>
              <th>Channel</th>
              <th>Reference Number</th>
              <th>Status</th>
              <th>Approved By</th>
              <th>Created At</th>
            </tr>
          </thead>
          <tbody id="history-tbody">
            <tr>
              <td colspan="8" class="empty-state">Loading history...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- USERS DIRECTORY -->
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">
          <span>👥 Registered Players Directory</span>
        </div>
        <div style="width: 320px;">
          <input type="text" id="user-search-input" class="form-input" placeholder="🔍 Search username, email, phone..." oninput="handleUserSearch(this.value)">
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table id="users-table">
          <thead>
            <tr>
              <th>Player Username</th>
              <th>Contact / Email</th>
              <th>Currency</th>
              <th>Wallet Balance</th>
              <th>Games Played</th>
              <th>Total Won</th>
              <th style="text-align: right;">Quick Actions</th>
            </tr>
          </thead>
          <tbody id="users-tbody">
            <tr>
              <td colspan="7" class="empty-state">Loading players...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>

  <div id="toast" class="toast">Action completed successfully</div>

  <script>
    let currentFilter = 'ALL';
    let userSearchTimer = null;

    async function loadStats() {
      try {
        const res = await fetch('/admin/api/stats');
        const data = await res.json();
        document.getElementById('stat-pending').textContent = data.pendingDeposits || 0;
        document.getElementById('pending-badge').textContent = data.pendingDeposits || 0;
        document.getElementById('stat-approved').textContent = data.approvedDeposits || 0;
        document.getElementById('stat-volume').textContent = 'LKR ' + (data.totalDepositedAmount || 0).toLocaleString(undefined, {minimumFractionDigits: 2});
        document.getElementById('stat-users').textContent = data.totalUsers || 0;
        document.getElementById('stat-balance').textContent = 'LKR ' + (data.totalSystemBalance || 0).toLocaleString(undefined, {minimumFractionDigits: 2});
      } catch (err) {
        console.error('Failed to load stats', err);
      }
    }

    function formatMethod(method) {
      if (!method) return '<span class="pill pill-manual">MANUAL</span>';
      const m = method.toLowerCase();
      if (m.includes('ipay')) return '<span class="pill pill-ipay">iPay LK</span>';
      if (m.includes('upay')) return '<span class="pill pill-upay">UPay LK</span>';
      if (m.includes('bank')) return '<span class="pill pill-bank">Bank CDM</span>';
      return '<span class="pill pill-manual">' + method.toUpperCase() + '</span>';
    }

    function formatStatus(status) {
      if (status === 'APPROVED') return '<span class="pill pill-approved">✓ APPROVED</span>';
      if (status === 'REJECTED') return '<span class="pill pill-rejected">✕ REJECTED</span>';
      return '<span class="pill pill-pending">⏳ PENDING</span>';
    }

    function formatDate(dateStr) {
      if (!dateStr) return '-';
      const d = new Date(dateStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + d.toLocaleDateString() + ')';
    }

    async function loadPendingDeposits() {
      try {
        const res = await fetch('/admin/api/deposits?status=PENDING');
        const deposits = await res.json();
        const tbody = document.getElementById('pending-tbody');

        if (!deposits || deposits.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" class="empty-state"><div class="empty-state-icon">🎉</div>All caught up! No pending deposit approvals.</td></tr>';
          return;
        }

        tbody.innerHTML = deposits.map(d => \`
          <tr>
            <td>
              <div style="font-weight: 700; color: #fff;">\${d.username}</div>
              <div style="font-size: 12px; color: var(--text-muted);">\${d.email || d.userId}</div>
            </td>
            <td>
              <span style="font-size: 16px; font-weight: 800; color: #34d399;">\${d.currency} \${Number(d.amount).toFixed(2)}</span>
            </td>
            <td>\${formatMethod(d.paymentMethod)}</td>
            <td>
              <span class="ref-code">\${d.referenceNumber}</span>
            </td>
            <td style="font-size: 13px; color: var(--text-muted);">\${formatDate(d.createdAt)}</td>
            <td style="text-align: right;">
              <button class="btn btn-success" style="padding: 6px 14px; font-size: 13px;" onclick="approveDeposit('\${d.id}', '\${d.username}', \${d.amount})">
                ✓ Approve
              </button>
              <button class="btn btn-danger" style="padding: 6px 12px; font-size: 13px; margin-left: 6px;" onclick="rejectDeposit('\${d.id}')">
                ✕ Reject
              </button>
            </td>
          </tr>
        \`).join('');
      } catch (err) {
        console.error('Failed to load pending', err);
      }
    }

    async function loadHistory() {
      try {
        const url = currentFilter === 'ALL' ? '/admin/api/deposits?limit=100' : \`/admin/api/deposits?status=\${currentFilter}&limit=100\`;
        const res = await fetch(url);
        const deposits = await res.json();
        const tbody = document.getElementById('history-tbody');

        if (!deposits || deposits.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No deposit records found for this filter.</td></tr>';
          return;
        }

        tbody.innerHTML = deposits.map(d => \`
          <tr>
            <td style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-muted);">\${d.id.substring(0, 8)}...</td>
            <td style="font-weight: 600;">\${d.username}</td>
            <td style="font-weight: 700; color: #fff;">\${d.currency} \${Number(d.amount).toFixed(2)}</td>
            <td>\${formatMethod(d.paymentMethod)}</td>
            <td><span class="ref-code">\${d.referenceNumber}</span></td>
            <td>\${formatStatus(d.status)}</td>
            <td style="font-size: 13px; color: var(--text-muted);">\${d.approvedBy || '-'}</td>
            <td style="font-size: 13px; color: var(--text-muted);">\${formatDate(d.createdAt)}</td>
          </tr>
        \`).join('');
      } catch (err) {
        console.error('Failed to load history', err);
      }
    }

    async function loadUsers(search = '') {
      try {
        const url = search ? \`/admin/api/users?search=\${encodeURIComponent(search)}\` : '/admin/api/users';
        const res = await fetch(url);
        const users = await res.json();
        const tbody = document.getElementById('users-tbody');

        if (!users || users.length === 0) {
          tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No players found matching "\' + search + \'".</td></tr>';
          return;
        }

        tbody.innerHTML = users.map(u => \`
          <tr>
            <td style="font-weight: 700; color: #fff;">\${u.username}</td>
            <td style="font-size: 13px; color: var(--text-muted);">\${u.email || u.phoneNumber || '-'}</td>
            <td><span style="font-weight: 600; color: #93c5fd;">\${u.currency || 'LKR'}</span></td>
            <td>
              <span style="font-size: 15px; font-weight: 800; color: #34d399;">
                \${u.currency || 'LKR'} \${Number(u.balance || 0).toFixed(2)}
              </span>
            </td>
            <td>\${u.gamesPlayed || 0}</td>
            <td style="color: #fbbf24; font-weight: 600;">\${Number(u.totalWon || 0).toFixed(2)}</td>
            <td style="text-align: right;">
              <button class="btn btn-primary" style="padding: 5px 12px; font-size: 12px;" onclick="prefillCredit('\${u.username}')">
                + Quick Credit
              </button>
            </td>
          </tr>
        \`).join('');
      } catch (err) {
        console.error('Failed to load users', err);
      }
    }

    async function approveDeposit(id, username, amount) {
      if (!confirm(\`Are you sure you want to approve deposit of LKR \${amount} for player "\${username}"? Their wallet will be credited immediately.\`)) {
        return;
      }
      try {
        const res = await fetch(\`/admin/api/deposits/\${id}/approve\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adminUser: 'Admin Dashboard' })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(\`✅ Approved! \${username} credited successfully.\`);
          loadAllData();
        } else {
          showToast(data.message || 'Failed to approve', true);
        }
      } catch (err) {
        showToast('Network error while approving', true);
      }
    }

    async function rejectDeposit(id) {
      const reason = prompt('Please enter reason for rejection (optional):', 'Invalid Reference / Payment not found');
      if (reason === null) return;
      try {
        const res = await fetch(\`/admin/api/deposits/\${id}/reject\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason, adminUser: 'Admin Dashboard' })
        });
        const data = await res.json();
        if (res.ok) {
          showToast('Deposit rejected.');
          loadAllData();
        } else {
          showToast(data.message || 'Failed to reject', true);
        }
      } catch (err) {
        showToast('Network error while rejecting', true);
      }
    }

    async function handleManualCredit(e) {
      e.preventDefault();
      const identifier = document.getElementById('credit-user').value.trim();
      const amount = parseFloat(document.getElementById('credit-amount').value);
      const note = document.getElementById('credit-note').value.trim();

      if (!identifier || !amount || amount <= 0) {
        showToast('Please fill player and valid amount', true);
        return;
      }

      try {
        const res = await fetch('/admin/api/manual-credit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, amount, note, adminUser: 'Admin Dashboard' })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(\`✅ Successfully credited LKR \${amount} to \${identifier}!\`);
          document.getElementById('manual-credit-form').reset();
          loadAllData();
        } else {
          showToast(data.message || 'Failed to credit player', true);
        }
      } catch (err) {
        showToast('Network error during credit', true);
      }
    }

    function prefillCredit(username) {
      document.getElementById('credit-user').value = username;
      document.getElementById('credit-amount').focus();
      window.scrollTo({ top: 300, behavior: 'smooth' });
    }

    function setHistoryFilter(status, btn) {
      currentFilter = status;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadHistory();
    }

    function handleUserSearch(val) {
      clearTimeout(userSearchTimer);
      userSearchTimer = setTimeout(() => {
        loadUsers(val);
      }, 300);
    }

    function showToast(msg, isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.className = isError ? 'toast error' : 'toast';
      toast.style.display = 'block';
      setTimeout(() => {
        toast.style.display = 'none';
      }, 4000);
    }

    function loadAllData() {
      loadStats();
      loadPendingDeposits();
      loadHistory();
      loadUsers();
    }

    // Initial load and periodic refresh
    loadAllData();
    setInterval(() => {
      loadStats();
      loadPendingDeposits();
    }, 15000);
  </script>
</body>
</html>
`;
  }
}
