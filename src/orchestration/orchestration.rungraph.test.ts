import { describe, it, expect, vi } from 'vitest';
import { OrchestrationService } from './orchestration.service';

/**
 * Exercises the private runGraph stream loop directly: it should emit a
 * run.status event and persist currentNode for each streamed node update, and
 * surface a real error as run.error + markRunFailed.
 */
function makeService(streamImpl: () => AsyncGenerator<Record<string, unknown>>) {
  const prisma = {
    orchestrationRun: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({}) },
  };
  const emitter = {
    runStatus: vi.fn(),
    runError: vi.fn(),
    nodeLifecycle: vi.fn(),
    nodeTelemetry: vi.fn(),
  };
  const graph = { stream: vi.fn().mockImplementation(async () => streamImpl()) };

  const u = undefined as unknown as never;
  const service = new OrchestrationService(
    prisma as never,
    u, u, u, u, u, u, u, u, u, u, u, u, u, u,
    null as never,
    null as never,
    emitter as never,
  );
  return { service, prisma, emitter, graph };
}

const config = { configurable: { thread_id: 't' } } as never;

describe('OrchestrationService.runGraph', () => {
  it('emits run.status and persists currentNode for each node update', async () => {
    const { service, prisma, emitter, graph } = makeService(async function* () {
      yield { parse_requirements: { requirements: {} } };
      yield { negotiate_contract: {} };
    });

    await (service as unknown as {
      runGraph: (p: string, r: string, c: unknown, i: unknown, g: unknown) => Promise<void>;
    }).runGraph('proj-1', 'run-1', config, { projectId: 'proj-1' }, graph);

    const nodes = emitter.runStatus.mock.calls.map((c) => c[3]);
    expect(nodes).toContain('parse_requirements');
    expect(nodes).toContain('negotiate_contract');

    const persistedNodes = prisma.orchestrationRun.update.mock.calls.map((c) => c[0].data.currentNode);
    expect(persistedNodes).toContain('parse_requirements');
    expect(persistedNodes).toContain('negotiate_contract');
  });

  it('surfaces a real stream error as run.error + markRunFailed', async () => {
    const { service, prisma, emitter, graph } = makeService(async function* () {
      yield { parse_requirements: {} };
      throw new Error('llm exploded');
    });

    await (service as unknown as {
      runGraph: (p: string, r: string, c: unknown, i: unknown, g: unknown) => Promise<void>;
    }).runGraph('proj-1', 'run-1', config, null, graph);

    expect(emitter.runError).toHaveBeenCalledWith(
      'proj-1',
      'run-1',
      expect.objectContaining({ code: 'NODE_FAILED', severity: 'permanent' }),
    );
    // markRunFailed marks the run FAILED via updateMany
    expect(prisma.orchestrationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });
});
