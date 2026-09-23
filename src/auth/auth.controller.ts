import { Controller, Post, Get, Body, Headers, Query, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('check-phone')
  async checkPhone(@Query('phone') phone: string) {
    const exists = await this.authService.checkPhoneExists(phone);
    return { exists };
  }

  @Post('register')
  async register(@Body() body: { username?: string; mobile?: string; phoneNumber?: string; password: string; currency?: string }) {
    const identifier = body.phoneNumber || body.mobile || body.username || '';
    return this.authService.register(identifier, body.password, body.currency);
  }

  @Post('login')
  async login(@Body() body: { username?: string; mobile?: string; phoneNumber?: string; password: string }) {
    const identifier = body.phoneNumber || body.mobile || body.username || '';
    return this.authService.login(identifier, body.password);
  }

  @Post('forgot-password/request-otp')
  async requestResetOtp(@Body() body: { phoneNumber?: string; mobile?: string; phone?: string }) {
    const phone = body.phoneNumber || body.mobile || body.phone || '';
    return this.authService.requestPasswordResetOtp(phone);
  }

  @Post('forgot-password/reset')
  async resetPassword(
    @Body() body: { phoneNumber?: string; mobile?: string; phone?: string; otp: string; newPassword: string },
  ) {
    const phone = body.phoneNumber || body.mobile || body.phone || '';
    return this.authService.resetPassword(phone, body.otp, body.newPassword);
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
}
