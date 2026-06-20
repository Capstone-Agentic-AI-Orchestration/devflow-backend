import { Injectable, Logger } from '@nestjs/common';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { GraphLlmProvider } from '../providers/graph-llm.provider';
import { PrismaService } from '../../prisma/prisma.service';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior NestJS backend engineer generating production-quality TypeScript code.
Generate complete, working NestJS files with proper decorators, dependency injection, and type safety.
Respond ONLY with a JSON array — no prose, no markdown fences.

Each element: { "filePath": string, "content": string, "language": string }`;

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class BackendAgentNode {
  private readonly logger = new Logger(BackendAgentNode.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly eventLog: EventLogService,
    private readonly graphLlm: GraphLlmProvider,
    private readonly streamEmitter: StreamEmitter,
  ) {}

  async execute(
    state: DevFlowStateType,
  ): Promise<Partial<DevFlowStateType>> {
    const { projectId, runId } = state;
    this.logger.log(`[${projectId}] Backend agent generating files`);

    if (!state.contract) {
      this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'error', 'Backend agent skipped: contract is missing');
      return { error: 'BackendAgentNode: contract is null' };
    }

    // Log STARTED — allSettled inside, so failure here does not block the node.
    await this.eventLog.logStarted(projectId, 'backend_agent');

    this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'decision', 'Starting backend code generation...');

    try {
      // ── 1. Read relevant memories before LLM call ──────────────────────────
      // companyName is included so domain-specific backend patterns (e.g.
      // "fintech NestJS CQRS") surface alongside the stack and feature context.
      const memoryQuery = [
        state.contract.requirements.projectType,
        state.stackKey,
        state.contract.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memoryBundle = await this.memory.buildContextForAgent({
        agentType: 'backend',
        projectId: state.projectId,
        query: memoryQuery,
      });
      const memoryContext = memoryBundle.context;

      this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'decision', `Loaded ${memoryBundle.total} memory references for backend context`);

      // ── 2. Build file list ───────────────────────────────────────────────
      const backendFiles = state.contract.fileManifest.filter((f) =>
        /\.(module|controller|service|dto|guard|pipe|interceptor)\.ts$|README-backend\.md$/i.test(f),
      );

      const coreFiles = [
        'src/app.module.ts',
        'src/main.ts',
        'src/modules/core/core.module.ts',
        'src/modules/core/core.controller.ts',
        'src/modules/core/core.service.ts',
        'src/modules/core/dto/create-item.dto.ts',
        'README-backend.md',
      ];
      const allBackendFiles = [
        ...new Set([...coreFiles, ...backendFiles]),
      ];

      // ── 2. Skip-generation check ───────────────────────────────────────────
      // Must run AFTER readRelevant so memory context is still available if the
      // skip threshold is not met. Returns immediately — no LLM tokens consumed.
      const skipCandidate = await this.memory.findSkipCandidate(
        'backend',
        memoryQuery,
        state.stackKey,
        state.projectId,
      );

      if (skipCandidate) {
        this.logger.log(
          `[${state.projectId}] Skip-generation: reusing backend memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
        );
        const rememberedFilePath = skipCandidate.metadata['filePath'];
        const artifact: GeneratedArtifact = {
          agentType: 'backend',
          filePath:
            typeof rememberedFilePath === 'string'
              ? rememberedFilePath
              : 'src/generated/artifact.ts',
          content: skipCandidate.content,
          language: 'typescript',
        };
        return { artifacts: this.completeArtifacts(allBackendFiles, [artifact], state) };
      }

      if (process.env.MOCK_MODE === 'true') {
        this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'decision', 'Mock mode: generating predefined backend files');
        const artifacts = this.completeArtifacts(
          allBackendFiles,
          [
          {
            agentType: 'backend',
            filePath: 'src/main.ts',
            content: `export function bootstrap() {\n  console.log("Mock Backend Running!");\n}`,
            language: 'typescript'
          }
          ],
          state,
        );
        await this.eventLog.logCompleted(state.projectId, 'backend_agent', { inputTokens: 0, outputTokens: 0, model: 'mock' });
        return { artifacts };
      }

      this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'decision', `Calling LLM (${this.graphLlm.model()}) to generate backend code for ${allBackendFiles.length} files...`);

      // ── 4. LLM call ───────────────────────────────────────────────────────
      const result = await this.graphLlm.generateJson<Array<{
        filePath: string;
        content: string;
        language?: string;
      }>>({
        agentName: 'backend_agent',
        systemPrompt: memoryContext
          ? `${SYSTEM_PROMPT}\n\nRelevant memory:\n${memoryContext}`
          : SYSTEM_PROMPT,
        userPrompt: `Generate NestJS backend files for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Tech Stack: ${JSON.stringify(state.contract.requirements.techStack, null, 2)}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Files to generate:
${allBackendFiles.map((f) => `- ${f}`).join('\n')}

Generate complete NestJS code with:
- Proper @Module, @Controller, @Injectable decorators
- Full CRUD operations where applicable
- Zod-validated DTOs
- Swagger/OpenAPI decorators where appropriate
- For README-backend.md: include API documentation, setup guide, and architecture notes`,
        expectedShape: 'array',
      });

      const artifacts = this.completeArtifacts(
        allBackendFiles,
        result.value.map((item) => ({
          agentType: 'backend' as const,
          filePath: item.filePath,
          content: item.content,
          language: item.language ?? this.inferLanguage(item.filePath),
        })),
        state,
      );

      this.logger.log(
        `[${state.projectId}] Backend agent generated ${artifacts.length} files (${memoryBundle.total} layered memories injected)`,
      );

      // ── 5. Inject bootstrapping configs ────────────────────────────────────
      const projectName = state.contract.projectName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      const configFiles: GeneratedArtifact[] = [
        {
          agentType: 'backend',
          filePath: 'nest-cli.json',
          content: JSON.stringify({
            $schema: 'https://json.schemastore.org/nest-cli',
            collection: '@nestjs/schematics',
            sourceRoot: 'src',
          }, null, 2),
          language: 'json',
        },
        {
          agentType: 'backend',
          filePath: 'tsconfig.build.json',
          content: JSON.stringify({
            extends: './tsconfig.json',
            exclude: ['node_modules', 'test', 'dist', '**/*spec.ts'],
          }, null, 2),
          language: 'json',
        },
      ];
      for (const cfg of configFiles) {
        const idx = artifacts.findIndex((a) => a.filePath === cfg.filePath);
        if (idx >= 0) artifacts[idx] = cfg;
        else artifacts.push(cfg);
      }

      // ── 6. Override README-backend.md ──────────────────────────────────────
      const readmeIdx = artifacts.findIndex((a) => a.filePath === 'README-backend.md');
      if (readmeIdx >= 0) {
        artifacts[readmeIdx].content = `# ${state.contract.projectName} — Backend

Generated by DevFlow.

## Quick start

\`\`\`bash
npm install
npm run start:dev
\`\`\`

The API listens on http://localhost:4001 by default.

## Project structure

\`\`\`
.
├── src/
│   ├── main.ts                     # Application entrypoint
│   ├── app.module.ts               # Root module
│   └── modules/
│       └── core/
│           ├── core.module.ts
│           ├── core.controller.ts
│           ├── core.service.ts
│           └── dto/
│               └── create-item.dto.ts
├── nest-cli.json
├── tsconfig.build.json
├── package.json
└── README-backend.md
\`\`\`

## Available scripts

| Command | Description |
|---------|-------------|
| \`npm run start:dev\` | Hot-reload development |
| \`npm run build\` | Production build |
| \`npm run start\` | Start production server |

## Tech stack

- **Framework:** NestJS 10
- **Language:** TypeScript
- **Database:** PostgreSQL via Prisma
`;
      }

      // Log COMPLETED with cost metadata — budget is updated atomically inside.
      await this.eventLog.logCompleted(state.projectId, 'backend_agent', {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
      });

      // Persist artifacts to DB immediately so the frontend sees them
      await this.prisma.artifact.createMany({
        data: artifacts.map((a: GeneratedArtifact) => ({
          projectId: state.projectId,
          agentType: a.agentType,
          filePath: a.filePath,
          content: a.content,
          language: a.language,
        })),
        skipDuplicates: true,
      }).catch((err: unknown) => {
        this.logger.warn(`[${state.projectId}] Artifact persist failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      });

      this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'decision', `Backend generation complete: ${artifacts.length} files generated (${result.usage.outputTokens} output tokens)`);

      return { artifacts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Backend agent failed: ${message}`);
      this.streamEmitter.emit(projectId, 'backend_agent', runId ?? '', 'error', `Backend generation failed: ${humanReadableError(message)}`);
      return { error: `BackendAgentNode failed: ${message}` };
    }
  }

  private completeArtifacts(
    requestedFiles: string[],
    generated: GeneratedArtifact[],
    state: DevFlowStateType,
  ): GeneratedArtifact[] {
    const byPath = new Map(generated.map((artifact) => [artifact.filePath, artifact]));

    return requestedFiles.map((filePath) => {
      const artifact = byPath.get(filePath);
      if (artifact?.content?.trim()) return artifact;

      return {
        agentType: 'backend' as const,
        filePath,
        content: this.fallbackContent(filePath, state),
        language: this.inferLanguage(filePath),
      };
    });
  }

  private fallbackContent(filePath: string, state: DevFlowStateType): string {
    const projectName = state.contract?.projectName ?? state.companyName;

    if (filePath === 'src/app.module.ts') {
      return `import { Module } from '@nestjs/common';
import { CoreModule } from './modules/core/core.module';

@Module({
  imports: [CoreModule],
})
export class AppModule {}
`;
    }

    if (filePath === 'src/main.ts') {
      return `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap();
`;
    }

    if (filePath.endsWith('core.module.ts')) {
      return `import { Module } from '@nestjs/common';
import { CoreController } from './core.controller';
import { CoreService } from './core.service';

@Module({
  controllers: [CoreController],
  providers: [CoreService],
})
export class CoreModule {}
`;
    }

    if (filePath.endsWith('core.controller.ts')) {
      return `import { Body, Controller, Get, Post } from '@nestjs/common';
import { CoreService } from './core.service';
import { CreateItemDto } from './dto/create-item.dto';

@Controller('tasks')
export class CoreController {
  constructor(private readonly coreService: CoreService) {}

  @Get()
  findAll() {
    return this.coreService.findAll();
  }

  @Post()
  create(@Body() dto: CreateItemDto) {
    return this.coreService.create(dto);
  }
}
`;
    }

    if (filePath.endsWith('core.service.ts')) {
      return `import { Injectable } from '@nestjs/common';
import { CreateItemDto } from './dto/create-item.dto';

@Injectable()
export class CoreService {
  private readonly tasks = [{ id: 'task-1', title: 'Review generated project', completed: false }];

  findAll() {
    return this.tasks;
  }

  create(dto: CreateItemDto) {
    const task = { id: \`task-\${this.tasks.length + 1}\`, title: dto.title, completed: false };
    this.tasks.push(task);
    return task;
  }
}
`;
    }

    if (filePath.endsWith('.dto.ts')) {
      return `export class CreateItemDto {
  title!: string;
  description?: string;
}
`;
    }

    if (filePath.endsWith('.module.ts')) {
      return `import { Module } from '@nestjs/common';

@Module({})
export class GeneratedModule {}
`;
    }

    if (filePath.endsWith('.controller.ts')) {
      return `import { Controller, Get } from '@nestjs/common';

@Controller()
export class GeneratedController {
  @Get('health')
  health() {
    return { status: 'ok', project: '${projectName}' };
  }
}
`;
    }

    if (filePath.endsWith('.service.ts')) {
      return `import { Injectable } from '@nestjs/common';

@Injectable()
export class GeneratedService {
  getStatus() {
    return { status: 'ready', project: '${projectName}' };
  }
}
`;
    }

    if (filePath.endsWith('.md')) {
      return `# Backend

This NestJS backend was generated for ${projectName}.

## Endpoints

- \`GET /tasks\` returns generated task data.
- \`POST /tasks\` creates a task payload.

## Setup

Install dependencies, configure the database URL, and run the NestJS server.
`;
    }

    return `export const generatedBackendFile = '${projectName}';
`;
  }

  private inferLanguage(filePath: string): string {
    if (filePath.endsWith('.md')) return 'markdown';
    return 'typescript';
  }
}
