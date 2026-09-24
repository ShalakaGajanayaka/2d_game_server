import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly redisService: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Admin token missing');
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const isAdmin = await this.redisService.get(`admin_token:${token}`);

    if (!isAdmin) {
      throw new UnauthorizedException('Invalid or expired admin token');
    }

    return true;
  }
}
