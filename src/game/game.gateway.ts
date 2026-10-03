import { WebSocketGateway, WebSocketServer, OnGatewayInit, OnGatewayConnection, SubscribeMessage } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService, GameRoomType } from './game.service';
import { RedisService } from '../redis/redis.service';
import { forwardRef, Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike } from 'typeorm';
import { User } from '../auth/entities/user.entity';

@WebSocketGateway({ cors: true })
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
    try {
      const cleanToken = data.token.trim();
      const username = await this.redisService.get(`token:${cleanToken}`);
      if (username) {
        // SECURITY PATCH: Purge any previously joined private user rooms on this socket
        // to strictly prevent multi-user cross-subscription eavesdropping attacks
        for (const room of client.rooms) {
          if (room.startsWith('user:')) {
            client.leave(room);
            this.logger.log(`Security: Socket [${client.id}] purged prior private room [${room}] on re-auth`);
          }
        }

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
    const validKey = 'skyrush_streamer_2026';
    let authorized = false;
    if (data?.key && data.key.trim() === validKey) {
      authorized = true;
    } else if (data?.token && typeof data.token === 'string') {
      const cleanToken = data.token.trim();
      const isAdmin = await this.redisService.get(`admin_token:${cleanToken}`);
      if (isAdmin) authorized = true;
    }

    if (authorized) {
      client.join('admin_room');
      this.logger.log(`Socket [${client.id}] authorized for [streamer_radar]`);
      const payload = this.gameService.getMarketingPreview();
      client.emit('streamerRadarSubscribed', { success: true });
      client.emit('marketingPreviewUpdate', payload);
      return { success: true, data: payload };
    } else {
      const response = { success: false, error: 'Unauthorized radar access' };
      client.emit('streamerRadarSubscribed', response);
      return response;
    }
  }
}

