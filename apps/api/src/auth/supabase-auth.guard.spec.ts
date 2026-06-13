import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { SupabaseAuthService } from './supabase-auth.service';
import type { AuthUser } from './auth.types';

const mockAuthService = {
  verifyAccessToken: jest.fn(),
};

interface MockRequest {
  headers: { authorization?: string };
  user?: AuthUser;
}

function makeContext(authorization?: string): ExecutionContext {
  const request: MockRequest = { headers: { authorization }, user: undefined };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('SupabaseAuthGuard', () => {
  let guard: SupabaseAuthGuard;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupabaseAuthGuard,
        { provide: SupabaseAuthService, useValue: mockAuthService },
      ],
    }).compile();

    guard = module.get<SupabaseAuthGuard>(SupabaseAuthGuard);
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  it('throws UnauthorizedException when Authorization header is missing', async () => {
    const ctx = makeContext(undefined);
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when Authorization header is empty string', async () => {
    const ctx = makeContext('');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when scheme is not Bearer', async () => {
    const ctx = makeContext('Basic abc123');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when scheme is lower-case bearer (case-sensitive)', async () => {
    // The guard splits on space and checks scheme === 'Bearer' exactly
    mockAuthService.verifyAccessToken.mockRejectedValue(new UnauthorizedException('bad token'));
    const ctx = makeContext('bearer valid-token');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('calls authService.verifyAccessToken with extracted token', async () => {
    const user: AuthUser = {
      id: 'user-1',
      email: 'test@test.com',
      fullName: 'Test User',
      role: 'CLIENT' as const,
    } as AuthUser;
    mockAuthService.verifyAccessToken.mockResolvedValue(user);
    const ctx = makeContext('Bearer valid-token');
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockAuthService.verifyAccessToken).toHaveBeenCalledWith('valid-token');
    expect(mockAuthService.verifyAccessToken).toHaveBeenCalledTimes(1);
  });

  it('attaches resolved user to request object', async () => {
    const user: AuthUser = {
      id: 'user-2',
      email: 'another@test.com',
      fullName: null,
      role: 'PM' as const,
    } as AuthUser;
    mockAuthService.verifyAccessToken.mockResolvedValue(user);
    const request: MockRequest = { headers: { authorization: 'Bearer valid-token' }, user: undefined };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    await guard.canActivate(ctx);
    expect(request.user).toEqual(user);
  });

  it('propagates rejection from authService (expired token)', async () => {
    mockAuthService.verifyAccessToken.mockRejectedValue(
      new UnauthorizedException('Invalid or expired access token'),
    );
    const ctx = makeContext('Bearer expired-token');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('does not call authService when header is missing', async () => {
    const ctx = makeContext(undefined);
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(mockAuthService.verifyAccessToken).not.toHaveBeenCalled();
  });
});
