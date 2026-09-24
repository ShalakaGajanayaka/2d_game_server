import { Controller, Post, Get, Body, Headers, Query, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('detect-currency')
  async detectCurrency(
    @Req() req: any,
    @Query('ip') ip?: string,
    @Query('tz') tz?: string,
    @Query('offset') offset?: string,
  ) {
    return this.authService.detectCurrency(req, ip, tz, offset);
  }

  @Get('check-phone')
  async checkPhone(@Query('phone') phone: string) {
    const exists = await this.authService.checkPhoneExists(phone);
    return { exists };
  }

  @Post('register')
  async register(@Body() body: { email?: string; username?: string; mobile?: string; phoneNumber?: string; password: string; currency?: string }) {
    const identifier = body.email || body.phoneNumber || body.mobile || body.username || '';
    return this.authService.register(identifier, body.password, body.currency);
  }

  @Post('login')
  async login(@Body() body: { email?: string; username?: string; mobile?: string; phoneNumber?: string; password: string }) {
    const identifier = body.email || body.phoneNumber || body.mobile || body.username || '';
    return this.authService.login(identifier, body.password);
  }

  @Post('forgot-password/request-otp')
  async requestResetOtp(@Body() body: { email?: string; phoneNumber?: string; mobile?: string; phone?: string }) {
    const identifier = body.email || body.phoneNumber || body.mobile || body.phone || '';
    return this.authService.requestPasswordResetOtp(identifier);
  }

  @Post('forgot-password/reset')
  async resetPassword(
    @Body() body: { email?: string; phoneNumber?: string; mobile?: string; phone?: string; otp: string; newPassword: string },
  ) {
    const identifier = body.email || body.phoneNumber || body.mobile || body.phone || '';
    return this.authService.resetPassword(identifier, body.otp, body.newPassword);
  }

  @Get('profile')
  async getProfile(@Headers('authorization') authHeader: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token missing');
    }
    const token = authHeader.replace('Bearer ', '').trim();
    return this.authService.getProfile(token);
  }

  @Post('update-balance')
  async updateBalance(
    @Body() body: { token: string; balance: number; winDelta?: number; mult?: number },
  ) {
    return this.authService.updateBalance(body.token, body.balance, body.winDelta, body.mult);
  }

  @Get('bet-history')
  async getBetHistory(@Headers('authorization') authHeader: string) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token missing');
    }
    const token = authHeader.replace('Bearer ', '').trim();
    return this.authService.getBetHistory(token);
  }

  @Post('bet-history')
  async saveBetHistory(
    @Headers('authorization') authHeader: string,
    @Body() body: { betAmount: number; cashOutMultiplier: number | null; crashPoint: number; winAmount: number; currency: string }
  ) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token missing');
    }
    const token = authHeader.replace('Bearer ', '').trim();
    return this.authService.saveBetHistory(token, body);
  }
}
