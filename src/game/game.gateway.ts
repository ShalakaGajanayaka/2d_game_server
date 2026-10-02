import { WebSocketGateway, WebSocketServer, OnGatewayInit, OnGatewayConnection, SubscribeMessage } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService, GameRoomType } from './game.service';
import { RedisService } from '../redis/redis.service';
import { forwardRef, Inject, Logger } from '@nestjs/common';

@WebSocketGateway({ cors: true })
export class GameGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(GameGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    @Inject(forwardRef(() => GameService))
    private readonly gameService: GameService,
    private readonly redisService: RedisService,
  ) {}

  afterInit(server: Server) {
    this.gameService.setServer(server);
  }

  handleConnection(client: Socket) {
    // Send public game state to newly connected client (defaults to room:standard)
    client.join('room:standard');
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
        // Join username room
        const userRoom = `user:${username.toLowerCase()}`;
        client.join(userRoom);

        // Also join user ID room for reliable UUID targeted notifications
        let isMarketing = false;
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

        // Dynamic Room Routing: If user is marketing, assign to room:marketing; otherwise room:standard
        if (isMarketing) {
          client.leave('room:standard');
          client.join('room:marketing');
          this.logger.log(`🎯 Marketing Streamer [${username}] routed to [room:marketing]`);
          client.emit('gameState', this.gameService.getGameState(GameRoomType.MARKETING, true));
        } else {
          client.join('room:standard');
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
}

