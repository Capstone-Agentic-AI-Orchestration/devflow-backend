import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { DevFlowGateway } from './devflow.gateway';
import { SupabaseAuthService } from '../auth/supabase-auth.service';
import { PrismaService } from '@app/prisma';
import type { AuthUser } from '../auth/auth.types';

// ─── Mock dependencies ────────────────────────────────────────────────────────

const mockAuthService = {
  verifyAccessToken: jest.fn(),
};

const mockPrisma = {
  project: {
    findFirst: jest.fn(),
  },
};

// ─── Socket / Server helpers ──────────────────────────────────────────────────

interface MockSocket {
  id: string;
  handshake: {
    auth: Record<string, unknown>;
    headers: Record<string, string>;
  };
  data: Record<string, unknown>;
  join: jest.Mock;
  leave: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
}

function makeSocket(overrides: Partial<MockSocket['handshake']> = {}): MockSocket {
  return {
    id: 'socket-test-id',
    handshake: {
      auth: {},
      headers: {},
      ...overrides,
    },
    data: {},
    join: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

function makeAdminUser(): AuthUser {
  return { id: 'admin-1', email: 'admin@test.com', fullName: 'Admin', role: UserRole.ADMIN };
}

function makeMemberUser(): AuthUser {
  return { id: 'member-1', email: 'member@test.com', fullName: 'Member', role: UserRole.PM };
}

function makeNonMemberUser(): AuthUser {
  return { id: 'other-1', email: 'other@test.com', fullName: 'Other', role: UserRole.DEV };
}

// ─── Middleware helper: simulate afterInit middleware execution ────────────────

async function runMiddleware(
  gateway: DevFlowGateway,
  socket: MockSocket,
): Promise<Error | null> {
  // afterInit registers a middleware on the server. We simulate this by
  // calling the middleware function captured from the server mock.
  return new Promise((resolve) => {
    const next = (err?: Error) => resolve(err ?? null);
    // Access the private method via type cast to simulate the middleware
    const gw = gateway as unknown as {
      afterInit(server: { use: (fn: (s: MockSocket, cb: (e?: Error) => void) => void) => void }): void;
    };
    let capturedMiddleware: ((s: MockSocket, cb: (e?: Error) => void) => void) | null = null;
    gw.afterInit({
      use: (fn) => {
        capturedMiddleware = fn;
      },
    });
    if (!capturedMiddleware) {
      resolve(new Error('No middleware registered'));
      return;
    }
    void (capturedMiddleware as (s: MockSocket, cb: (e?: Error) => void) => void)(socket, next);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DevFlowGateway', () => {
  let gateway: DevFlowGateway;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DevFlowGateway,
        { provide: SupabaseAuthService, useValue: mockAuthService },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    gateway = module.get<DevFlowGateway>(DevFlowGateway);
  });

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  // ─── Handshake authentication ────────────────────────────────────────────────

  describe('afterInit middleware (handshake authentication)', () => {
    it('calls next with error when no token is present in auth or headers', async () => {
      const socket = makeSocket();
      const err = await runMiddleware(gateway, socket);
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toMatch(/Unauthorized/i);
      expect(mockAuthService.verifyAccessToken).not.toHaveBeenCalled();
    });

    it('calls next with error when token is invalid (verifyAccessToken throws)', async () => {
      mockAuthService.verifyAccessToken.mockRejectedValueOnce(
        new UnauthorizedException('Invalid or expired access token'),
      );
      const socket = makeSocket({ auth: { token: 'bad-token' }, headers: {} });
      const err = await runMiddleware(gateway, socket);
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toMatch(/Unauthorized/i);
    });

    it('attaches AuthUser to socket.data.user and calls next without error on valid token', async () => {
      const user = makeAdminUser();
      mockAuthService.verifyAccessToken.mockResolvedValueOnce(user);
      const socket = makeSocket({ auth: { token: 'valid-token' }, headers: {} });
      const err = await runMiddleware(gateway, socket);
      expect(err).toBeNull();
      expect(socket.data.user).toEqual(user);
    });

    it('reads token from Authorization header as fallback when auth.token is absent', async () => {
      const user = makeMemberUser();
      mockAuthService.verifyAccessToken.mockResolvedValueOnce(user);
      const socket = makeSocket({
        auth: {},
        headers: { authorization: 'Bearer header-token' },
      });
      const err = await runMiddleware(gateway, socket);
      expect(err).toBeNull();
      expect(mockAuthService.verifyAccessToken).toHaveBeenCalledWith('header-token');
    });
  });

  // ─── Subscribe authorization ─────────────────────────────────────────────────

  describe('handleSubscribe (per-room authorization)', () => {
    const PROJECT_ID = 'project-abc';

    it('emits subscribe:denied when socket has no authenticated user', async () => {
      const socket = makeSocket();
      // data.user is absent — simulate a socket that somehow bypassed middleware
      await gateway.handleSubscribe({ projectId: PROJECT_ID }, socket as unknown as import('socket.io').Socket);
      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('subscribe:denied', expect.objectContaining({ reason: 'Unauthorized' }));
    });

    it('allows ADMIN user to subscribe to any project without a DB lookup', async () => {
      const socket = makeSocket();
      socket.data.user = makeAdminUser();
      // No DB response needed for ADMIN — findFirst should not be called
      await gateway.handleSubscribe({ projectId: PROJECT_ID }, socket as unknown as import('socket.io').Socket);
      expect(mockPrisma.project.findFirst).not.toHaveBeenCalled();
      expect(socket.join).toHaveBeenCalledWith(PROJECT_ID);
      expect(socket.emit).not.toHaveBeenCalledWith('subscribe:denied', expect.anything());
    });

    it('allows a project member to subscribe to their project', async () => {
      const user = makeMemberUser();
      const socket = makeSocket();
      socket.data.user = user;
      // Simulate a project found for this user (creator or member)
      mockPrisma.project.findFirst.mockResolvedValueOnce({ id: PROJECT_ID });

      await gateway.handleSubscribe({ projectId: PROJECT_ID }, socket as unknown as import('socket.io').Socket);
      expect(mockPrisma.project.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: PROJECT_ID,
            OR: expect.arrayContaining([
              { createdById: user.id },
              { members: { some: { userId: user.id } } },
            ]),
          }),
        }),
      );
      expect(socket.join).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('denies a non-member from subscribing (IDOR fix)', async () => {
      const user = makeNonMemberUser();
      const socket = makeSocket();
      socket.data.user = user;
      // DB returns null — user is not the creator and not a member
      mockPrisma.project.findFirst.mockResolvedValueOnce(null);

      await gateway.handleSubscribe({ projectId: PROJECT_ID }, socket as unknown as import('socket.io').Socket);
      expect(socket.join).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('subscribe:denied', expect.objectContaining({
        projectId: PROJECT_ID,
        reason: 'Forbidden',
      }));
    });

    it('does nothing when projectId is missing from the payload', async () => {
      const socket = makeSocket();
      socket.data.user = makeAdminUser();
      await gateway.handleSubscribe({ projectId: '' }, socket as unknown as import('socket.io').Socket);
      expect(socket.join).not.toHaveBeenCalled();
      expect(mockPrisma.project.findFirst).not.toHaveBeenCalled();
    });
  });
});
