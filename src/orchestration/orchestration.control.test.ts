import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestrationService } from './orchestration.service';

/**
 * Focused unit tests for the Phase 2 mid-run control dispatch. The service has
 * many DI dependencies; we construct it with stubs for only the collaborators
 * the control paths touch (prisma, the compiled graph, the emitter) and inject
 * the graph directly (normally set in onModuleInit).
 */
function makeService() {
  const prisma = {
    project: {
      findUnique: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    orchestrationRun: {
      updateMany: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ status: 'RUNNING' }),
    },
    workOrder: { updateMany: vi.fn().mockResolvedValue({}) },
    runBudget: { update: vi.fn().mockResolvedValue({}) },
  };

  const graph = {
    updateState: vi.fn().mockResolvedValue(undefined),
    // runGraph consumes this; an empty async iterable lets it complete cleanly.
    stream: vi.fn().mockResolvedValue((async function* () {})()),
  };

  const emitter = {
    runStatus: vi.fn(),
    runError: vi.fn(),
    nodeLifecycle: vi.fn(),
    nodeTelemetry: vi.fn(),
  };

  // Positional constructor args — only prisma (1st), gateway (17th=null) and
  // emitter (18th) matter here; the rest are unused by control paths.
  const u = undefined as unknown as never;
  const service = new OrchestrationService(
    prisma as never,
    u, u, u, u, u, u, u, u, u, u, u, u, u, u,
    null as never,
    null as never,
    emitter as never,
  );
  (service as unknown as { graph: typeof graph }).graph = graph;

  return { service, prisma, graph, emitter };
}

describe('OrchestrationService.control', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('cancel: run CANCELLED + project FAILED + work orders CANCELLED', async () => {
    const res = await ctx.service.control('proj-1', 'cancel', { actorId: 'user-9' });
    expect(res).toEqual({ accepted: true, action: 'cancel', status: 'CANCELLED' });
    expect(ctx.prisma.orchestrationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    expect(ctx.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'FAILED' } }),
    );
    expect(ctx.prisma.workOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }),
    );
    expect(ctx.emitter.runStatus).toHaveBeenCalled();
    expect(ctx.emitter.runError).toHaveBeenCalled();
  });

  it('pause sets the halt flag; resume clears it', async () => {
    await ctx.service.control('proj-1', 'pause', {});
    expect(ctx.service.isManuallyHalted('proj-1')).toBe(true);

    await ctx.service.control('proj-1', 'resume', {});
    expect(ctx.service.isManuallyHalted('proj-1')).toBe(false);
    expect(ctx.graph.stream).toHaveBeenCalled();
  });

  it('resume throws if the run was cancelled', async () => {
    ctx.prisma.orchestrationRun.findUnique.mockResolvedValueOnce({ status: 'CANCELLED' });
    await expect(ctx.service.control('proj-1', 'resume', {})).rejects.toThrow();
  });

  it('modify_params patches whitelisted graph state', async () => {
    const res = await ctx.service.control('proj-1', 'modify_params', { params: { retryCount: 0 } });
    expect(res.action).toBe('modify_params');
    expect(ctx.graph.updateState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ retryCount: 0 }),
    );
  });

  it('modify_params with no recognized fields throws', async () => {
    await expect(
      ctx.service.control('proj-1', 'modify_params', { params: { bogus: 1 } }),
    ).rejects.toThrow();
  });

  it('skip_node without a nodeId throws', async () => {
    await expect(ctx.service.control('proj-1', 'skip_node', {})).rejects.toThrow();
  });

  it('skip_node writes state as the node and re-streams', async () => {
    await ctx.service.control('proj-1', 'skip_node', { nodeId: 'database_agent' });
    expect(ctx.graph.updateState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: null }),
      'database_agent',
    );
    expect(ctx.emitter.nodeLifecycle).toHaveBeenCalledWith(
      'proj-1', 'run-1', 'database_agent', 'skipped',
    );
  });
});
