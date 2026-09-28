import { WebSocketGateway, WebSocketServer, OnGatewayInit, OnGatewayConnection, SubscribeMessage } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService } from './game.service';
import { forwardRef, Inject } from '@nestjs/common';

@WebSocketGateway({ cors: true })
export class GameGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    @Inject(forwardRef(() => GameService))
    private readonly gameService: GameService,
  ) {}

  afterInit(server: Server) {
    this.gameService.setServer(server);
  }

  handleConnection(client: Socket) {
    // Send the current game state to the newly connected client
    client.emit('gameState', this.gameService.getGameState(true));
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
}
