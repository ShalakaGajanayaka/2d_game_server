import { Controller, Post, Get, Body, Headers, Query, Req, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  RegisterDto,
  LoginDto,
  RequestResetOtpDto,
  ResetPasswordDto,
  RenameUserDto,
} from './dto/auth.dto';

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
  async register(@Body() body: RegisterDto) {
    const identifier = body.email || body.phoneNumber || body.mobile || body.username || '';
    return this.authService.register(identifier, body.password, body.currency);
  }

  @Post('login')
  async login(@Body() body: LoginDto) {
    const identifier = body.email || body.phoneNumber || body.mobile || body.username || '';
    return this.authService.login(identifier, body.password);
  }

  @Post('forgot-password/request-otp')
  async requestResetOtp(@Body() body: RequestResetOtpDto) {
    const identifier = body.email || body.phoneNumber || body.mobile || body.phone || '';
    return this.authService.requestPasswordResetOtp(identifier);
  }

  @Post('forgot-password/reset')
  async resetPassword(@Body() body: ResetPasswordDto) {
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

  @Post('rename')
  async renameUser(
    @Headers('authorization') authHeader: string,
    @Body() body: RenameUserDto,
  ) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Bearer token missing');
    }
    const token = authHeader.replace('Bearer ', '').trim();
    return this.authService.renameUser(token, body.newUsername.trim());
  }

  private extractToken(authHeader?: string, bodyToken?: string): string {
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.replace('Bearer ', '').trim();
    }
    if (bodyToken && typeof bodyToken === 'string' && bodyToken.trim()) {
      return bodyToken.trim();
    }
    throw new UnauthorizedException('Authentication token required');
  }

  @Post('game-bet')
  async placeGameBet(
    @Headers('authorization') authHeader: string,
    @Body() body: { token?: string; betIndex: number; amount: number },
  ) {
    const token = this.extractToken(authHeader, body?.token);
    return this.authService.placeGameBet(token, Number(body.betIndex), Number(body.amount));
  }

  @Post('game-cancel-bet')
  async cancelGameBet(
    @Headers('authorization') authHeader: string,
    @Body() body: { token?: string; betIndex: number },
  ) {
    const token = this.extractToken(authHeader, body?.token);
    return this.authService.cancelGameBet(token, Number(body.betIndex));
  }

  @Post('game-cashout')
  async cashoutGameBet(
    @Headers('authorization') authHeader: string,
    @Body() body: { token?: string; betIndex: number },
  ) {
    const token = this.extractToken(authHeader, body?.token);
    return this.authService.cashoutGameBet(token, Number(body.betIndex));
  }

  @Post('logout')
  async logout(
    @Headers('authorization') authHeader: string,
    @Body() body?: { token?: string },
  ) {
    const token = this.extractToken(authHeader, body?.token);
    return this.authService.logout(token);
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
    @Body() body: any,
  ) {
    throw new BadRequestException(
      'Client-side bet history injection is permanently disabled. All game records are server-authoritative.',
    );
  }

  @Get('exchange-rates')
  getExchangeRates() {
    return this.authService.getExchangeRates();
  }

  @Post('change-currency')
  async changeCurrency(
    @Headers('authorization') authHeader: string,
    @Body() body: { token?: string; targetCurrency: string },
  ) {
    const token = this.extractToken(authHeader, body?.token);
    if (!body?.targetCurrency) {
      throw new BadRequestException('targetCurrency is required');
    }
    return this.authService.changeCurrency(token, body.targetCurrency);
  }
}
