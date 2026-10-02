import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly redisService: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    let token: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '').trim();
    } else if (request.query && request.query.token) {
      token = String(request.query.token).trim();
    }

    if (!token) {
      throw new UnauthorizedException('Admin token missing');
    }

    const isAdmin = await this.redisService.get(`admin_token:${token}`);

    if (!isAdmin) {
      throw new UnauthorizedException('Invalid or expired admin token');
    }

    return true;
  }
}
