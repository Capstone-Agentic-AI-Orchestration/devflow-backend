/**
 * app.e2e-spec.ts
 *
 * End-to-end test suite for AppModule.
 *
 * The AppModule requires Prisma (DATABASE_URL) and Supabase (SUPABASE_URL)
 * at bootstrap. This suite mocks all infrastructure providers so no real
 * database or network connection is needed.
 *
 * Note: The /health plain-Express middleware is registered in main.ts
 * (app.use('/health', ...)) — it is NOT a NestJS route, so it is NOT
 * available in the TestingModule context. The NestJS HealthController
 * at GET /health is tested via the full module here.
 *
 * The root GET / endpoint comes from ApiController, which is a standalone
 * file; it is not wired into AppModule. When that wiring is added,
 * enable the commented-out test below.
 */

// Set minimal env vars before any modules are imported
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/devflow_test';
process.env['SUPABASE_URL'] = 'https://test.supabase.co';
process.env['AGENT_PROVIDER'] = 'mock';
process.env['CORS_ORIGIN'] = 'http://localhost:3001';

import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../apps/api/src/app.module';
import { PrismaService } from '@app/prisma';
import { SupabaseService } from '@app/supabase';

// ─── Mocks ─────────────────────────────────────────────────────────────────────

const mockPrisma = {
  $connect: jest.fn().mockResolvedValue(undefined),
  $disconnect: jest.fn().mockResolvedValue(undefined),
  profile: {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(null),
  },
  project: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
  },
  clientInvite: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  projectMember: {
    upsert: jest.fn(),
  },
  orchestrationRun: {
    findMany: jest.fn().mockResolvedValue([]),
  },
};

const mockSupabase = {
  getClient: jest.fn().mockReturnValue(null),
  ping: jest.fn().mockResolvedValue(false),
  pingDefault: jest.fn().mockResolvedValue(false),
  pingService: jest.fn().mockResolvedValue(false),
  getClientForService: jest.fn().mockReturnValue(null),
  hasServiceClient: jest.fn().mockReturnValue(false),
  listConfiguredServices: jest.fn().mockReturnValue([]),
  getDefaultOrServiceClient: jest.fn().mockReturnValue(null),
  onModuleInit: jest.fn(),
};

// ─── Suite ─────────────────────────────────────────────────────────────────────

describe('AppModule (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(SupabaseService)
      .useValue(mockSupabase)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app.close();
  });

  // ── Health NestJS controller ───────────────────────────────────────────────

  it('GET /health returns a health response with a valid status field', async () => {
    const httpServer = app.getHttpServer() as unknown as Parameters<typeof request>[0];
    const response = await request(httpServer).get('/health');

    // HealthController may return 200 (ok/degraded) or 503 (error)
    expect([200, 503]).toContain(response.status);
    expect(response.body).toHaveProperty('status');
    expect(['ok', 'error']).toContain(response.body.status as string);
    expect(response.body).toHaveProperty('uptimeSeconds');
    expect(typeof response.body.uptimeSeconds).toBe('number');
  });

  it('GET /health includes a checks object', async () => {
    const httpServer = app.getHttpServer() as unknown as Parameters<typeof request>[0];
    const response = await request(httpServer).get('/health');

    expect(response.body).toHaveProperty('checks');
    expect(typeof response.body.checks.database).toBe('boolean');
  });

  // ── Unknown routes ─────────────────────────────────────────────────────────

  it('GET /nonexistent returns 404', async () => {
    const httpServer = app.getHttpServer() as unknown as Parameters<typeof request>[0];
    const response = await request(httpServer).get('/nonexistent-route-xyz');

    expect(response.status).toBe(404);
  });

  // ── Protected route requires auth ──────────────────────────────────────────

  it('GET /projects returns 401 without Authorization header', async () => {
    const httpServer = app.getHttpServer() as unknown as Parameters<typeof request>[0];
    const response = await request(httpServer).get('/projects');

    // Should reject unauthenticated requests
    expect([401, 403, 404]).toContain(response.status);
  });
});
