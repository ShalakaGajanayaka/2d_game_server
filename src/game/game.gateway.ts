import { WebSocketGateway, WebSocketServer, OnGatewayInit, OnGatewayConnection, SubscribeMessage } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService, GameRoomType } from './game.service';
import { RedisService } from '../redis/redis.service';
import { forwardRef, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import * as crypto from 'crypto';

const isProd = process.env.NODE_ENV === 'production';
const customOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().toLowerCase())
  .filter(Boolean);

@WebSocketGateway({
  cors: {
    origin: (origin: string, callback: (err: Error | null, allow?: boolean) => void) => {
      // Allow non-browser connections (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);

      if (!isProd) {
        return callback(null, true);
      }

      const lower = origin.toLowerCase();
      const SKYRUSH_ORIGIN_REGEX = /^https:\/\/([a-z0-9-]+\.)?skyrush\.cc$/i;
      const isAllowedDomain =
        SKYRUSH_ORIGIN_REGEX.test(lower) ||
        customOrigins.includes(lower);

      if (isAllowedDomain) {
        callback(null, true);
      } else {
        callback(new Error(`WebSocket Origin ${origin} not permitted by SkyRush CORS policy`));
      }
    },
    credentials: true,
  },
})
export class GameGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(GameGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    @Inject(forwardRef(() => GameService))
    private readonly gameService: GameService,
    private readonly redisService: RedisService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  afterInit(server: Server) {
    this.gameService.setServer(server);
  }

  async handleConnection(client: Socket) {
    const token = (client.handshake?.auth?.token || client.handshake?.query?.token) as string | undefined;
    if (token && typeof token === 'string' && token.trim().length > 0) {
      try {
        const cleanToken = token.trim();
        const username = await this.redisService.get(`token:${cleanToken}`);
        if (username) {
          const dbUser = await this.userRepo.findOne({
            where: [{ username: ILike(username) }, { email: ILike(username) }],
          });
          if (dbUser && dbUser.isMarketing) {
            await client.join('room:marketing');
            await client.join(`user:${username.toLowerCase()}`);
            await client.join(`user:${dbUser.id}`);
            client.emit('gameState', this.gameService.getGameState(GameRoomType.MARKETING, true));
            this.logger.log(`🎯 Marketing Streamer [${username}] auto-joined [room:marketing] on connection handshake`);
            return;
          }
        }
      } catch (err) {
        this.logger.warn(`Error during connection handshake auth check: ${err?.message}`);
      }
    }

    // Default to room:standard
    await client.join('room:standard');
    client.emit('gameState', this.gameService.getGameState(GameRoomType.STANDARD, true));
  }

  @SubscribeMessage('pingSync')
  handlePingSync(client: Socket, data: { clientSendTime: number }) {
    const now = Date.now();
    const rate = (client as any)._pingRate || { count: 0, resetTime: now + 1000 };
    if (now > rate.resetTime) {
      rate.count = 0;
      rate.resetTime = now + 1000;
    }
    rate.count++;
    (client as any)._pingRate = rate;
    if (rate.count > 12) {
      return { error: 'Ping rate limit exceeded' };
    }

    const payload = {
      clientSendTime: data?.clientSendTime || Date.now(),
      serverReceiveTime: Date.now(),
    };
    client.emit('pongSync', payload);
    return payload;
  }

  @SubscribeMessage('subscribeUser')
  async handleSubscribeUser(client: Socket, data: { token?: string }) {
    if (!data?.token || typeof data.token !== 'string') {
      return { success: false, error: 'Token required' };
    }

    const now = Date.now();
    const rate = (client as any)._subUserRate || { count: 0, resetTime: now + 5000 };
    if (now > rate.resetTime) {
      rate.count = 0;
      rate.resetTime = now + 5000;
    }
    rate.count++;
    (client as any)._subUserRate = rate;
    if (rate.count > 5) {
      return { success: false, error: 'Too many subscription attempts. Please wait.' };
    }

    try {
      const cleanToken = data.token.trim();
      const username = await this.redisService.get(`token:${cleanToken}`);
      if (username) {
        // SECURITY PATCH: Purge any previously joined private user rooms, admin, or radar rooms on this socket
        // to strictly prevent multi-user cross-subscription eavesdropping attacks
        for (const room of client.rooms) {
          if (room.startsWith('user:')) {
            client.leave(room);
            this.logger.log(`Security: Socket [${client.id}] purged prior private room [${room}] on re-auth`);
          }
        }
        client.leave('admin_room');
        client.leave('streamer_radar_room');

        // Join username room
        const userRoom = `user:${username.toLowerCase()}`;
        client.join(userRoom);

        // Authoritative Database Verification for Marketing Role
        let isMarketing = false;
        let dbUser: User | null = null;
        try {
          dbUser = await this.userRepo.findOne({
            where: [{ username: ILike(username) }, { email: ILike(username) }],
          });
          if (dbUser) {
            isMarketing = !!dbUser.isMarketing;
            client.join(`user:${dbUser.id}`);
          }
        } catch (dbErr) {
          this.logger.warn(`Database user lookup fallback for ${username}: ${dbErr?.message}`);
        }

        // Fallback to Redis cache if DB lookup didn't resolve user
        if (!dbUser) {
          const userJson = await this.redisService.get(`user:${username.toLowerCase()}`);
          if (userJson) {
            const userObj = JSON.parse(userJson);
            if (userObj?.id) {
              client.join(`user:${userObj.id}`);
            }
            if (userObj?.isMarketing) {
              isMarketing = true;
            }
          }
        } else {
          // Synchronize Redis with authoritative DB flags
          try {
            const userJson = await this.redisService.get(`user:${username.toLowerCase()}`);
            const userObj = userJson ? JSON.parse(userJson) : {};
            userObj.isMarketing = isMarketing;
            userObj.isMarketingAutoWin = !!dbUser.isMarketingAutoWin;
            userObj.id = dbUser.id;
            await this.redisService.set(`user:${username.toLowerCase()}`, JSON.stringify(userObj), 86400 * 7);
          } catch {}
        }

        // Dynamic Room Routing: Marketing accounts route to room:marketing; real clients strictly to room:standard
        if (isMarketing) {
          client.leave('room:standard');
          client.join('room:marketing');
          this.logger.log(`🎯 Marketing Streamer [${username}] authoritatively routed to [room:marketing]`);
          client.emit('gameState', this.gameService.getGameState(GameRoomType.MARKETING, true));
        } else {
          client.leave('room:marketing');
          client.join('room:standard');
          this.logger.log(`👤 Real Client [${username}] authoritatively routed to [room:standard]`);
          client.emit('gameState', this.gameService.getGameState(GameRoomType.STANDARD, true));
        }

        this.logger.log(`Socket [${client.id}] subscribed to private room: ${userRoom} (marketing: ${isMarketing})`);
        const response = { success: true, username, isMarketing, room: isMarketing ? GameRoomType.MARKETING : GameRoomType.STANDARD };
        client.emit('userSubscribed', response);
        return response;
      } else {
        const response = { success: false, error: 'Invalid or expired session token' };
        client.emit('userSubscribed', response);
        return response;
      }
    } catch (err) {
      this.logger.error('Error during subscribeUser', err);
      return { success: false, error: 'Subscription error' };
    }
  }

  @SubscribeMessage('unsubscribeUser')
  handleUnsubscribeUser(client: Socket) {
    for (const room of client.rooms) {
      if (room.startsWith('user:')) {
        client.leave(room);
        this.logger.log(`Socket [${client.id}] left private room: ${room}`);
      }
    }
    client.leave('room:marketing');
    client.join('room:standard');
    client.emit('gameState', this.gameService.getGameState(GameRoomType.STANDARD, true));
    client.emit('userUnsubscribed', { success: true });
    return { success: true };
  }

  @SubscribeMessage('subscribeAdmin')
  async handleSubscribeAdmin(client: Socket, data: { token?: string }) {
    if (!data?.token || typeof data.token !== 'string') {
      return { success: false, error: 'Admin token required' };
    }

    const now = Date.now();
    const rate = (client as any)._subAdminRate || { count: 0, resetTime: now + 10000 };
    if (now > rate.resetTime) {
      rate.count = 0;
      rate.resetTime = now + 10000;
    }
    rate.count++;
    (client as any)._subAdminRate = rate;
    if (rate.count > 3) {
      return { success: false, error: 'Too many admin authorization attempts.' };
    }

    try {
      const cleanToken = data.token.trim();
      const isAdmin = await this.redisService.get(`admin_token:${cleanToken}`);
      if (isAdmin) {
        client.join('admin_room');
        this.logger.log(`Socket [${client.id}] authorized and subscribed to [admin_room]`);
        const response = { success: true };
        client.emit('adminSubscribed', response);
        client.emit('marketingPreviewUpdate', this.gameService.getMarketingPreview());
        return response;
      } else {
        this.logger.warn(`Socket [${client.id}] rejected unauthorized subscribeAdmin attempt`);
        const response = { success: false, error: 'Unauthorized admin credentials' };
        client.emit('adminSubscribed', response);
        return response;
      }
    } catch (err) {
      this.logger.error('Error during subscribeAdmin', err);
      return { success: false, error: 'Admin subscription error' };
    }
  }

  @SubscribeMessage('subscribeStreamerRadar')
  async handleSubscribeStreamerRadar(client: Socket, data: { token?: string; key?: string }) {
    const now = Date.now();
    const rate = (client as any)._radarRate || { count: 0, resetTime: now + 10000 };
    if (now > rate.resetTime) {
      rate.count = 0;
      rate.resetTime = now + 10000;
    }
    rate.count++;
    (client as any)._radarRate = rate;
    if (rate.count > 3) {
      return { success: false, error: 'Too many radar authorization attempts.' };
    }

    const configuredSecret = process.env.STREAMER_RADAR_SECRET;
    let authorized = false;

    if (configuredSecret && data?.key && typeof data.key === 'string') {
      const cleanKey = data.key.trim();
      const targetSec = configuredSecret.trim();
      try {
        const bufA = Buffer.from(cleanKey);
        const bufB = Buffer.from(targetSec);
        if (bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB)) {
          authorized = true;
        }
      } catch {
        authorized = false;
      }
    } else if (data?.token && typeof data.token === 'string') {
      const cleanToken = data.token.trim();
      const isAdmin = await this.redisService.get(`admin_token:${cleanToken}`);
      if (isAdmin) authorized = true;
    }

    if (authorized) {
      // SECURITY FIX: Join isolated streamer_radar_room strictly without financial admin_room access
      client.join('streamer_radar_room');
      this.logger.log(`Socket [${client.id}] authorized for [streamer_radar_room]`);
      const payload = this.gameService.getMarketingPreview();
      client.emit('streamerRadarSubscribed', { success: true });
      client.emit('marketingPreviewUpdate', payload);
      return { success: true, data: payload };
    } else {
      this.logger.warn(`Socket [${client.id}] rejected unauthorized subscribeStreamerRadar attempt`);
      const response = { success: false, error: 'Unauthorized radar access' };
      client.emit('streamerRadarSubscribed', response);
      return response;
    }
  }
}

