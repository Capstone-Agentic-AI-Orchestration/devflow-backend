import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { UserRole } from '@prisma/client';
import { PrismaService } from '@app/prisma';
import { SupabaseAuthService } from '../auth/supabase-auth.service';
import type { AuthUser } from '../auth/auth.types';

interface SubscribePayload {
  projectId: string;
}

interface StatusPayload {
  projectId: string;
  status: string;
  currentNode: string;
  error: string | null;
}

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? '*' },
  namespace: '/devflow',
})
export class DevFlowGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(DevFlowGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(
    private readonly authService: SupabaseAuthService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Registers a socket middleware that authenticates every incoming connection
   * before NestJS hands the socket to handleConnection. The token is read from
   * the handshake auth object (preferred) with a fallback to the Authorization
   * header, matching the pattern used by the HTTP guard.
   */
  afterInit(server: Server): void {
    server.use(async (socket: Socket, next) => {
      try {
        const token = this.extractToken(socket);
        if (!token) {
          next(new Error('Unauthorized: missing token'));
          return;
        }
        const user = await this.authService.verifyAccessToken(token);
        socket.data.user = user;
        next();
      } catch {
        next(new Error('Unauthorized: invalid or expired token'));
      }
    });
  }

  handleConnection(client: Socket): void {
    const user = client.data.user as AuthUser | undefined;
    this.logger.log(
      `Client connected: ${client.id} (userId=${user?.id ?? 'unknown'})`,
    );
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  /**
   * Client subscribes to status updates for a given projectId.
   * Emits `{ event: 'subscribe', data: { projectId } }` from the client side.
   * The client is joined to a Socket.IO room named after the projectId so only
   * that client (and any others monitoring the same project) receive events.
   *
   * Authorization: ADMIN users may subscribe to any project; other users must
   * be the project creator or a project member (mirrors projectAccessWhere in
   * ProjectsService).
   */
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @MessageBody() data: SubscribePayload,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const { projectId } = data;
    if (!projectId) {
      this.logger.warn(`Client ${client.id} sent subscribe without projectId`);
      return;
    }

    const user = client.data.user as AuthUser | undefined;
    if (!user) {
      this.logger.warn(
        `Client ${client.id} attempted subscribe without authenticated user`,
      );
      client.emit('subscribe:denied', { projectId, reason: 'Unauthorized' });
      return;
    }

    const authorized = await this.canAccessProject(user, projectId);
    if (!authorized) {
      this.logger.warn(
        `Access denied: user ${user.id} attempted to subscribe to project ${projectId}`,
      );
      client.emit('subscribe:denied', { projectId, reason: 'Forbidden' });
      return;
    }

    void client.join(projectId);
    this.logger.log(
      `Client ${client.id} (userId=${user.id}) subscribed to project ${projectId}`,
    );
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @MessageBody() data: SubscribePayload,
    @ConnectedSocket() client: Socket,
  ): void {
    const { projectId } = data;
    if (!projectId) return;
    void client.leave(projectId);
    this.logger.log(`Client ${client.id} unsubscribed from project ${projectId}`);
  }

  /**
   * Called by OrchestrationService at each status transition.
   * Broadcasts a `project:status` event to all clients in the projectId room.
   */
  emitStatusUpdate(
    projectId: string,
    status: string,
    currentNode: string,
    error: string | null = null,
  ): void {
    const payload: StatusPayload = { projectId, status, currentNode, error };
    this.server.to(projectId).emit('project:status', payload);
    this.logger.log(
      `Emitted project:status to room ${projectId}: status=${status} node=${currentNode}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private extractToken(socket: Socket): string | null {
    // Preferred: socket.io handshake auth { token: '<jwt>' }
    const authToken = (socket.handshake.auth as Record<string, unknown>)?.token;
    if (typeof authToken === 'string' && authToken) {
      return authToken;
    }

    // Fallback: Authorization: Bearer <jwt> header
    const authHeader = socket.handshake.headers?.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    return null;
  }

  private async canAccessProject(user: AuthUser, projectId: string): Promise<boolean> {
    if (user.role === UserRole.ADMIN) {
      return true;
    }

    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { createdById: user.id },
          { members: { some: { userId: user.id } } },
        ],
      },
      select: { id: true },
    });

    return project !== null;
  }
}
