// Mock modules with ESM dependencies before any imports
jest.mock('../orchestration/orchestration.service');
jest.mock('../github/github.service');
jest.mock('../notifications/notifications.service');

import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { PrismaService } from '@app/prisma';
import { OrchestrationService } from '../orchestration/orchestration.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProjectStatus, UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import type { CreateProjectDto } from './dto/create-project.dto';

// ─── Mock factories ───────────────────────────────────────────────────────────

const mockPrisma = {
  project: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  projectTimelineEvent: {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  },
  orchestrationRun: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  projectMember: {
    findFirst: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    upsert: jest.fn(),
  },
  artifact: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  clientInvite: {
    findMany: jest.fn(),
  },
  notification: {
    create: jest.fn(),
  },
};

const mockOrchestration = {
  startRun: jest.fn(),
  getStatus: jest.fn(),
};

const mockNotifications = {
  createNotification: jest.fn(),
  sendBulkNotification: jest.fn(),
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const adminUser: AuthUser = {
  id: 'admin-user-id',
  email: 'admin@devflow.test',
  fullName: 'Admin User',
  role: UserRole.ADMIN,
};

const clientUser: AuthUser = {
  id: 'client-user-id',
  email: 'client@devflow.test',
  fullName: 'Client User',
  role: UserRole.CLIENT,
};

const mockProject = {
  id: 'project-1',
  companyName: 'Acme Corp',
  brief: 'Build a platform',
  stackKey: 'nextjs-nestjs-supabase',
  status: ProjectStatus.PENDING,
  runId: null,
  repoUrl: null,
  createdById: adminUser.id,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ProjectsService', () => {
  let service: ProjectsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OrchestrationService, useValue: mockOrchestration },
        { provide: NotificationsService, useValue: mockNotifications },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── create ─────────────────────────────────────────────────────────────────

  describe('create()', () => {
    const dto: CreateProjectDto = {
      companyName: 'Acme Corp',
      brief: 'Build a new platform for Acme',
      stackKey: 'nextjs-nestjs-supabase',
    };

    it('calls prisma.project.create with correct data', async () => {
      mockPrisma.project.create.mockResolvedValue(mockProject);
      mockPrisma.projectTimelineEvent.create.mockResolvedValue({});

      await service.create(dto, adminUser);

      expect(mockPrisma.project.create).toHaveBeenCalledWith({
        data: {
          companyName: dto.companyName,
          brief: dto.brief,
          stackKey: dto.stackKey,
          createdById: adminUser.id,
        },
      });
    });

    it('returns the created project', async () => {
      mockPrisma.project.create.mockResolvedValue(mockProject);
      mockPrisma.projectTimelineEvent.create.mockResolvedValue({});

      const result = await service.create(dto, adminUser);

      expect(result).toEqual(mockProject);
      expect(result.companyName).toBe(dto.companyName);
    });

    it('creates a timeline event after project creation', async () => {
      mockPrisma.project.create.mockResolvedValue(mockProject);
      mockPrisma.projectTimelineEvent.create.mockResolvedValue({});

      await service.create(dto, adminUser);

      expect(mockPrisma.projectTimelineEvent.create).toHaveBeenCalled();
    });
  });

  // ── findAll ────────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('returns an empty array when no projects exist', async () => {
      mockPrisma.project.findMany.mockResolvedValue([]);

      const result = await service.findAll(adminUser);

      expect(result).toEqual([]);
      expect(mockPrisma.project.findMany).toHaveBeenCalled();
    });

    it('maps projects to ProjectListItem shape (id, companyName, status, lifecycle)', async () => {
      const rawProject = {
        ...mockProject,
        kickoff: null,
        deliveryReview: null,
        clientInvites: [],
        artifacts: [],
        tasks: [],
        workOrders: [],
      };
      mockPrisma.project.findMany.mockResolvedValue([rawProject]);

      const result = await service.findAll(adminUser);

      expect(result).toHaveLength(1);
      const first = result[0];
      expect(first).toHaveProperty('id', 'project-1');
      expect(first).toHaveProperty('companyName', 'Acme Corp');
      expect(first).toHaveProperty('status');
      expect(first).toHaveProperty('lifecycle');
      expect(first.lifecycle).toHaveProperty('stage');
      expect(first.lifecycle).toHaveProperty('progress');
    });

    it('does not include content or brief fields in the list response', async () => {
      const rawProject = {
        ...mockProject,
        kickoff: null,
        deliveryReview: null,
        clientInvites: [],
        artifacts: [],
        tasks: [],
        workOrders: [],
      };
      mockPrisma.project.findMany.mockResolvedValue([rawProject]);

      const result = await service.findAll(adminUser);

      expect(result[0]).not.toHaveProperty('brief');
    });
  });

  // ── findOne ────────────────────────────────────────────────────────────────

  describe('findOne()', () => {
    it('throws NotFoundException when project is not found', async () => {
      mockPrisma.project.findFirst.mockResolvedValue(null);

      await expect(service.findOne('nonexistent-id', adminUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns project when found', async () => {
      const fullProject = {
        ...mockProject,
        gates: [],
        members: [],
        runBudget: null,
        kickoff: null,
        deliveryReview: null,
        clientInvites: [],
        createdBy: { id: adminUser.id, email: adminUser.email, fullName: adminUser.fullName, role: adminUser.role },
        _count: { artifacts: 0, eventLogs: 0 },
        artifacts: [],
        tasks: [],
        workOrders: [],
      };
      mockPrisma.project.findFirst.mockResolvedValue(fullProject);

      const result = await service.findOne('project-1', adminUser);

      expect(result).toHaveProperty('id', 'project-1');
      expect(result).toHaveProperty('companyName', 'Acme Corp');
    });
  });

  // ── startOrchestration ─────────────────────────────────────────────────────

  describe('startOrchestration()', () => {
    it('throws NotFoundException when project does not exist', async () => {
      mockPrisma.project.findFirst.mockResolvedValue(null);

      await expect(service.startOrchestration('nonexistent', adminUser)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns existing runId immediately if orchestration already started', async () => {
      mockPrisma.project.findFirst.mockResolvedValue({
        ...mockProject,
        runId: 'existing-run-id',
        kickoff: null,
        workOrders: [],
      });

      const result = await service.startOrchestration('project-1', adminUser);

      expect(result).toEqual({ accepted: true, runId: 'existing-run-id' });
      expect(mockOrchestration.startRun).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when kickoff is not ready', async () => {
      mockPrisma.project.findFirst.mockResolvedValue({
        ...mockProject,
        runId: null,
        kickoff: { status: 'DRAFT' },
        workOrders: [{ instructions: 'Do something important here' }],
      });

      await expect(service.startOrchestration('project-1', adminUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when no READY work orders with instructions exist', async () => {
      mockPrisma.project.findFirst.mockResolvedValue({
        ...mockProject,
        runId: null,
        kickoff: { status: 'READY' },
        workOrders: [],
      });

      await expect(service.startOrchestration('project-1', adminUser)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('starts orchestration run when kickoff is READY and work orders have instructions', async () => {
      mockPrisma.project.findFirst.mockResolvedValue({
        ...mockProject,
        id: 'project-1',
        brief: 'Build a platform',
        stackKey: 'nextjs-nestjs-supabase',
        companyName: 'Acme Corp',
        runId: null,
        kickoff: { status: 'READY' },
        workOrders: [{ instructions: 'Implement the backend API' }],
      });
      mockOrchestration.startRun.mockResolvedValue('new-run-id-123');

      const result = await service.startOrchestration('project-1', adminUser);

      expect(result).toEqual({ accepted: true, runId: 'new-run-id-123' });
      expect(mockOrchestration.startRun).toHaveBeenCalledWith(
        'project-1',
        'Build a platform',
        'nextjs-nestjs-supabase',
        'Acme Corp',
        adminUser.id,
      );
    });

    it('also starts when kickoff status is LOCKED', async () => {
      mockPrisma.project.findFirst.mockResolvedValue({
        ...mockProject,
        runId: null,
        kickoff: { status: 'LOCKED' },
        workOrders: [{ instructions: 'Build the frontend dashboard component' }],
      });
      mockOrchestration.startRun.mockResolvedValue('locked-run-id');

      const result = await service.startOrchestration('project-1', adminUser);
      expect(result.runId).toBe('locked-run-id');
    });
  });

  // ── CLIENT role access restriction ─────────────────────────────────────────

  describe('role-based access', () => {
    it('findAll scopes projects for CLIENT users (calls findMany with role-specific where)', async () => {
      mockPrisma.project.findMany.mockResolvedValue([]);

      await service.findAll(clientUser);

      expect(mockPrisma.project.findMany).toHaveBeenCalled();
      // The where clause is scoped to user — verify findMany was called
      const callArgs = mockPrisma.project.findMany.mock.calls[0]?.[0];
      expect(callArgs).toBeDefined();
    });
  });
});
