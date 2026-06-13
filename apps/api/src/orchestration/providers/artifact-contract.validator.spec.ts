import { ArtifactContractValidator } from './artifact-contract.validator';
import type { ArtifactContractValidationResult } from './artifact-contract.validator';
import type { GeneratedWorkOrderOutput, WorkOrderAgentContext } from './agent-provider.types';
import { WorkOrderAgentType, WorkOrderPriority } from '@prisma/client';
import { ORCHESTRATION_CONTRACT_VERSION } from './agent-contracts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WORK_ORDER_ID = 'wo-abc-123';

function makeContext(
  agentType: WorkOrderAgentType = WorkOrderAgentType.BACKEND,
  overrides: Partial<WorkOrderAgentContext['workOrder']> = {},
): WorkOrderAgentContext {
  return {
    project: {
      id: 'proj-1',
      companyName: 'Acme Corp',
      brief: 'Build a backend API',
      stackKey: 'nextjs-nestjs-supabase',
    },
    workOrder: {
      id: WORK_ORDER_ID,
      title: 'Implement auth service',
      instructions: 'Build a NestJS auth service',
      agentType,
      priority: WorkOrderPriority.NORMAL,
      ...overrides,
    },
    task: null,
    sourceArtifact: null,
    executionRunId: 'run-1',
  };
}

function makeBackendOutput(overrides: Partial<GeneratedWorkOrderOutput> = {}): GeneratedWorkOrderOutput {
  return {
    filePath: `work-orders/${WORK_ORDER_ID}/backend-output.ts`,
    displayName: 'Backend Auth Service',
    content: [
      'export class AuthService {',
      '  @Injectable()',
      '  handle() { return describeWorkOrder(); }',
      '}',
    ].join('\n'),
    language: 'typescript',
    ...overrides,
  };
}

function makeFrontendOutput(overrides: Partial<GeneratedWorkOrderOutput> = {}): GeneratedWorkOrderOutput {
  return {
    filePath: `work-orders/${WORK_ORDER_ID}/frontend-output.tsx`,
    displayName: 'Dashboard Component',
    content: [
      'export default function Dashboard() {',
      '  return <section><div>Hello</div></section>;',
      '}',
    ].join('\n'),
    language: 'typescript',
    ...overrides,
  };
}

function makeDatabaseOutput(overrides: Partial<GeneratedWorkOrderOutput> = {}): GeneratedWorkOrderOutput {
  return {
    filePath: `work-orders/${WORK_ORDER_ID}/database-output.sql`,
    displayName: 'Create Users Table',
    content: 'CREATE TABLE users (id UUID PRIMARY KEY);',
    language: 'sql',
    ...overrides,
  };
}

function makeArchitectureOutput(overrides: Partial<GeneratedWorkOrderOutput> = {}): GeneratedWorkOrderOutput {
  return {
    filePath: `work-orders/${WORK_ORDER_ID}/architecture-output.md`,
    displayName: 'System Architecture',
    content: '## Objective\n\nDesign the auth system.\n\nDelivery Notes: use JWT.',
    language: 'markdown',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ArtifactContractValidator', () => {
  let validator: ArtifactContractValidator;

  beforeEach(() => {
    validator = new ArtifactContractValidator();
  });

  it('should be defined', () => {
    expect(validator).toBeDefined();
  });

  // ── BACKEND ────────────────────────────────────────────────────────────────

  describe('BACKEND agent type', () => {
    const ctx = makeContext(WorkOrderAgentType.BACKEND);

    it('validates a well-formed backend artifact as valid', () => {
      const result: ArtifactContractValidationResult = validator.validate(makeBackendOutput(), ctx);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.summary).toContain('passed');
      expect(result.summary).toContain(ORCHESTRATION_CONTRACT_VERSION);
    });

    it('fails when filePath does not start with the expected work-order prefix', () => {
      const result = validator.validate(
        makeBackendOutput({ filePath: 'wrong-path/backend-output.ts' }),
        ctx,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('filePath'))).toBe(true);
    });

    it('fails when filePath is empty', () => {
      const result = validator.validate(makeBackendOutput({ filePath: '' }), ctx);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('filePath is required');
    });

    it('fails when displayName is empty', () => {
      const result = validator.validate(makeBackendOutput({ displayName: '' }), ctx);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('displayName is required');
    });

    it('fails when content is too short (under 40 chars)', () => {
      const result = validator.validate(makeBackendOutput({ content: 'short' }), ctx);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('content'))).toBe(true);
    });

    it('fails when content does not include an export statement', () => {
      const result = validator.validate(
        makeBackendOutput({
          content: '// A backend service without any keyword at all, just a long plain comment spanning many characters',
        }),
        ctx,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('export'))).toBe(true);
    });

    it('fails when backend output lacks NestJS contract signal', () => {
      const result = validator.validate(
        makeBackendOutput({
          // Has `export class` so first signal passes, but lacks @Injectable / describeWorkOrder / Controller
          content: 'export class MyService { getStuff() { return [1,2,3]; } } // no framework signal present',
        }),
        ctx,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('NestJS'))).toBe(true);
    });

    it('fails with wrong file extension (.js instead of .ts)', () => {
      const result = validator.validate(
        makeBackendOutput({
          filePath: `work-orders/${WORK_ORDER_ID}/backend-output.js`,
        }),
        ctx,
      );
      expect(result.valid).toBe(false);
    });
  });

  // ── FRONTEND ───────────────────────────────────────────────────────────────

  describe('FRONTEND agent type', () => {
    const ctx = makeContext(WorkOrderAgentType.FRONTEND);

    it('validates a well-formed frontend artifact as valid', () => {
      const result = validator.validate(makeFrontendOutput(), ctx);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails when .tsx file lacks renderable UI signals', () => {
      const result = validator.validate(
        makeFrontendOutput({
          // Has `export default` so first signal passes, but lacks <section, <div, or React
          content: 'export default function handler() { return null; } // no JSX markup at all here',
        }),
        ctx,
      );
      expect(result.valid).toBe(false);
    });

    it('fails when file extension is not .tsx or .jsx', () => {
      const result = validator.validate(
        makeFrontendOutput({
          filePath: `work-orders/${WORK_ORDER_ID}/frontend-output.ts`,
        }),
        ctx,
      );
      expect(result.valid).toBe(false);
    });
  });

  // ── DATABASE ───────────────────────────────────────────────────────────────

  describe('DATABASE agent type', () => {
    const ctx = makeContext(WorkOrderAgentType.DATABASE);

    it('validates a well-formed database artifact as valid', () => {
      const result = validator.validate(makeDatabaseOutput(), ctx);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails when SQL lacks DDL statement (CREATE TABLE or ALTER TABLE)', () => {
      const result = validator.validate(
        makeDatabaseOutput({
          content: 'SELECT * FROM users; INSERT INTO logs VALUES (1); UPDATE settings SET val = 1;',
        }),
        ctx,
      );
      expect(result.valid).toBe(false);
    });

    it('fails when SQL lacks statement terminators', () => {
      const result = validator.validate(
        makeDatabaseOutput({
          content: 'CREATE TABLE users (id UUID PRIMARY KEY)\nALTER TABLE users ADD COLUMN name TEXT',
        }),
        ctx,
      );
      expect(result.valid).toBe(false);
    });
  });

  // ── ARCHITECTURE ───────────────────────────────────────────────────────────

  describe('ARCHITECTURE agent type', () => {
    const ctx = makeContext(WorkOrderAgentType.ARCHITECTURE);

    it('validates a well-formed architecture artifact as valid', () => {
      const result = validator.validate(makeArchitectureOutput(), ctx);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails when architecture output lacks markdown heading', () => {
      const result = validator.validate(
        makeArchitectureOutput({
          content: 'No heading here, just plain text about delivery notes and objectives without any # markers at all.',
        }),
        ctx,
      );
      expect(result.valid).toBe(false);
    });
  });

  // ── Summary field ──────────────────────────────────────────────────────────

  describe('summary field', () => {
    it('includes agentType in summary', () => {
      const ctx = makeContext(WorkOrderAgentType.BACKEND);
      const result = validator.validate(makeBackendOutput(), ctx);
      expect(result.summary).toContain(WorkOrderAgentType.BACKEND);
    });

    it('says "failed" in summary when validation fails', () => {
      const ctx = makeContext(WorkOrderAgentType.BACKEND);
      const result = validator.validate(makeBackendOutput({ filePath: '' }), ctx);
      expect(result.summary).toContain('failed');
    });
  });
});
