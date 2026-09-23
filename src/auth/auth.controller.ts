import { Controller, Post, Get, Body, Headers, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() body: { username: string; password: string }) {
    return this.authService.register(body.username, body.password);
  }

  @Post('login')
  async login(@Body() body: { username: string; password: string }) {
    return this.authService.login(body.username, body.password);
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
