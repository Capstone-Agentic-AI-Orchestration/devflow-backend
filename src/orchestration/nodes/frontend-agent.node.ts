import { Injectable, Logger } from '@nestjs/common';
import { DevFlowStateType, GeneratedArtifact } from '../graph/devflow.state';
import { MemoryService } from '../../memory/memory.service';
import { EventLogService } from '../../supervisor/event-log.service';
import { GraphLlmProvider } from '../providers/graph-llm.provider';
import { PrismaService } from '../../prisma/prisma.service';
import { StreamEmitter } from '../streaming/stream-emitter.service';
import { humanReadableError } from './human-readable-error';

// ─── Constants ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior frontend engineer generating production-quality React/Next.js code.
Generate complete, working TypeScript files. Each file must be standalone and well-commented.
Respond ONLY with a JSON array — no prose, no markdown fences.

Each element: { "filePath": string, "content": string, "language": string }`;

// ─── Node ─────────────────────────────────────────────────────────────────────

@Injectable()
export class FrontendAgentNode {
  private readonly logger = new Logger(FrontendAgentNode.name);

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
    this.logger.log(`[${projectId}] Frontend agent generating files`);

    if (!state.contract) {
      this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'error', 'Frontend agent skipped: contract is missing');
      return { error: 'FrontendAgentNode: contract is null' };
    }

    // Log STARTED — allSettled inside, so failure here does not block the node.
    await this.eventLog.logStarted(projectId, 'frontend_agent');

    this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'decision', 'Starting frontend code generation...');

    try {
      // ── 1. Read relevant memories ──────────────────────────────────────────
      // companyName is included so industry-specific frontend patterns surface
      // alongside stack + feature context.
      const memoryQuery = [
        state.contract.requirements.projectType,
        state.stackKey,
        state.contract.requirements.techStack.frontend,
        state.contract.requirements.features.join(' '),
        state.companyName,
      ]
        .filter(Boolean)
        .join(' ');

      const memoryBundle = await this.memory.buildContextForAgent({
        agentType: 'frontend',
        projectId: state.projectId,
        query: memoryQuery,
      });
      const memoryContext = memoryBundle.context;

      this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'decision', `Loaded ${memoryBundle.total} memory references for frontend context`);

      // ── 2. Build file list (source-only; configs injected after LLM) ──────
      const frontendSourceFiles = state.contract.fileManifest.filter((f) =>
        /\.(tsx|jsx|css|scss|module\.css)$|README-frontend\.md$/i.test(f),
      );

      const projectName = state.contract.projectName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      const coreSourceFiles = [
        'src/app/page.tsx',
        'src/app/layout.tsx',
        'src/components/ui/Button.tsx',
        'src/components/ui/Card.tsx',
        'src/styles/globals.css',
        'README-frontend.md',
      ];
      const allFrontendFiles = [
        ...new Set([...coreSourceFiles, ...frontendSourceFiles]),
      ];

      // ── 3. Skip-generation check ───────────────────────────────────────────
      // Must run AFTER readRelevant so memory context is still available if the
      // skip threshold is not met. Returns immediately — no LLM tokens consumed.
      const skipCandidate = await this.memory.findSkipCandidate(
        'frontend',
        memoryQuery,
        state.stackKey,
        state.projectId,
      );

      if (skipCandidate) {
        this.logger.log(
          `[${state.projectId}] Skip-generation: reusing frontend memory artifact (similarity=${skipCandidate.similarity?.toFixed(3)})`,
        );
        const rememberedFilePath = skipCandidate.metadata['filePath'];
        const artifact: GeneratedArtifact = {
          agentType: 'frontend',
          filePath:
            typeof rememberedFilePath === 'string'
              ? rememberedFilePath
              : 'src/app/page.tsx',
          content: skipCandidate.content,
          language: 'typescript',
        };
        return { artifacts: this.completeArtifacts(allFrontendFiles, [artifact], state) };
      }

      if (process.env.MOCK_MODE === 'true') {
        this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'decision', 'Mock mode: generating predefined frontend components');
        const artifacts = this.completeArtifacts(
          allFrontendFiles,
          [
          {
            agentType: 'frontend',
            filePath: 'src/app/page.tsx',
            content: `export default function Page() { return <div>Mock Frontend for ${state.companyName}</div>; }`,
            language: 'tsx'
          }
          ],
          state,
        );
        await this.eventLog.logCompleted(state.projectId, 'frontend_agent', { inputTokens: 0, outputTokens: 0, model: 'mock' });
        return { artifacts };
      }

      this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'decision', `Calling LLM (${this.graphLlm.model()}) to generate frontend code for ${allFrontendFiles.length} files...`);

      // ── 4. LLM call ───────────────────────────────────────────────────────
      const result = await this.graphLlm.generateJson<Array<{
        filePath: string;
        content: string;
        language?: string;
      }>>({
        agentName: 'frontend_agent',
        systemPrompt: memoryContext
          ? `${SYSTEM_PROMPT}\n\nRelevant memory:\n${memoryContext}`
          : SYSTEM_PROMPT,
        userPrompt: `Generate frontend files for this project:

Project: ${state.contract.projectName}
Description: ${state.contract.description}
Tech Stack: ${JSON.stringify(state.contract.requirements.techStack, null, 2)}
Features: ${state.contract.requirements.features.join(', ')}
Acceptance Criteria: ${state.contract.acceptanceCriteria.join('; ')}

Files to generate:
${allFrontendFiles.map((f) => `- ${f}`).join('\n')}

Generate complete, production-quality code for each file. For README-frontend.md, include setup instructions, architecture overview, and component documentation.`,
        expectedShape: 'array',
      });

      const artifacts = this.completeArtifacts(
        allFrontendFiles,
        result.value.map((item) => ({
          agentType: 'frontend' as const,
          filePath: item.filePath,
          content: item.content,
          language: item.language ?? this.inferLanguage(item.filePath),
        })),
        state,
      );

      this.logger.log(
        `[${state.projectId}] Frontend agent generated ${artifacts.length} files (${memoryBundle.total} layered memories injected)`,
      );

      // ── 5. Inject bootstrapping configs (overrides any LLM-generated garbage) ──
      const now = JSON.stringify(new Date().toISOString().split('T')[0]);
      const configFiles: GeneratedArtifact[] = [
        {
          agentType: 'frontend',
          filePath: 'package.json',
          content: `{
  "name": "${projectName}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "^16.2.6",
    "react": "^19.2.6",
    "react-dom": "^19.2.6"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "tailwindcss": "^4.2.0",
    "@tailwindcss/postcss": "^4.2.0"
  }
}`,
          language: 'json',
        },
        {
          agentType: 'frontend',
          filePath: 'tsconfig.json',
          content: `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}`,
          language: 'json',
        },
        {
          agentType: 'frontend',
          filePath: 'next.config.ts',
          content: `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {};

export default nextConfig;`,
          language: 'typescript',
        },
        {
          agentType: 'frontend',
          filePath: 'postcss.config.mjs',
          content: `const config = { plugins: { '@tailwindcss/postcss': {} } };

export default config;`,
          language: 'javascript',
        },
        {
          agentType: 'frontend',
          filePath: 'src/app/layout.tsx',
          content: `import type { Metadata } from 'next';
import '../styles/globals.css';

export const metadata: Metadata = {
  title: '${state.contract.projectName}',
  description: 'Generated by DevFlow',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}`,
          language: 'typescript',
        },
        {
          agentType: 'frontend',
          filePath: 'src/styles/globals.css',
          content: `@import "tailwindcss";

:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: #f8fafc;
  color: #0f172a;
}`,
          language: 'css',
        },
      ];
      for (const cfg of configFiles) {
        const idx = artifacts.findIndex((a) => a.filePath === cfg.filePath);
        if (idx >= 0) artifacts[idx] = cfg;
        else artifacts.push(cfg);
      }

      // ── 6. Override README-frontend.md with a precise template ─────────────
      const readmeIdx = artifacts.findIndex((a) => a.filePath === 'README-frontend.md');
      if (readmeIdx >= 0) {
        artifacts[readmeIdx].content = `# ${state.contract.projectName}

Generated by DevFlow.

## Quick start

\`\`\`bash
npm install
npm run dev
\`\`\`

Open http://localhost:3000 in your browser.

## Project structure

\`\`\`
.
├── src/
│   ├── app/
│   │   ├── layout.tsx        # Root layout
│   │   └── page.tsx          # Main page
│   ├── components/
│   │   └── ui/
│   │       ├── Button.tsx
│   │       └── Card.tsx
│   └── styles/
│       └── globals.css
├── package.json
├── next.config.ts
├── postcss.config.mjs
├── tsconfig.json
└── README-frontend.md
\`\`\`

## Available scripts

| Command | Description |
|---------|-------------|
| \`npm run dev\` | Start development server |
| \`npm run build\` | Production build |
| \`npm run start\` | Start production server |

## Tech stack

- **Framework:** Next.js 16
- **Language:** TypeScript
- **Styling:** Tailwind CSS v4

## Features

${state.contract.requirements.features.map((f: string) => `- ${f}`).join('\n')}
`;
      }

      // Log COMPLETED with cost metadata — budget is updated atomically inside.
      await this.eventLog.logCompleted(state.projectId, 'frontend_agent', {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        model: result.model,
      });

      // Persist artifacts to DB immediately so the frontend sees them
      await this.prisma.artifact.createMany({
        data: artifacts.map((a) => ({
          projectId: state.projectId,
          agentType: a.agentType,
          filePath: a.filePath,
          content: a.content,
          language: a.language,
        })),
        skipDuplicates: true,
      }).catch((err: unknown) => {
        this.logger.warn(`[${state.projectId}] Artifact persist failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      });

      this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'decision', `Frontend generation complete: ${artifacts.length} files generated (${result.usage.outputTokens} output tokens)`);

      return { artifacts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${state.projectId}] Frontend agent failed: ${message}`);
      this.streamEmitter.emit(projectId, 'frontend_agent', runId ?? '', 'error', `Frontend generation failed: ${humanReadableError(message)}`);
      return { error: `FrontendAgentNode failed: ${message}` };
    }
  }

  private inferLanguage(filePath: string): string {
    if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx')) return 'typescript';
    if (filePath.endsWith('.ts') || filePath.endsWith('.js')) return 'typescript';
    if (filePath.endsWith('.css') || filePath.endsWith('.scss')) return 'css';
    if (filePath.endsWith('.md')) return 'markdown';
    return 'text';
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
        agentType: 'frontend' as const,
        filePath,
        content: this.fallbackContent(filePath, state),
        language: this.inferLanguage(filePath),
      };
    });
  }

  private fallbackContent(filePath: string, state: DevFlowStateType): string {
    const projectName = state.contract?.projectName ?? state.companyName;

    if (filePath === 'src/app/page.tsx') {
      return `import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';

const tasks = ['Review generated scope', 'Confirm backend API', 'Prepare deployment'];

export default function Page() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950">
      <section className="mx-auto max-w-4xl space-y-6">
        <div>
          <h1 className="text-3xl font-semibold">${projectName}</h1>
          <p className="mt-2 text-slate-600">Generated task tracking workspace.</p>
        </div>
        <Card>
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-xl font-medium">Tasks</h2>
            <Button>Add task</Button>
          </div>
          <ul className="mt-4 space-y-2">
            {tasks.map((task) => (
              <li key={task} className="rounded border border-slate-200 bg-white px-3 py-2">
                {task}
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </main>
  );
}
`;
    }

    if (filePath === 'src/app/layout.tsx') {
      return `export const metadata = {
  title: '${projectName}',
  description: 'Generated DevFlow application',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;
    }

    if (filePath === 'src/components/ui/Button.tsx') {
      return `import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
};

export function Button({ children, className = '', ...props }: ButtonProps) {
  return (
    <button
      className={\`rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 \${className}\`}
      {...props}
    >
      {children}
    </button>
  );
}
`;
    }

    if (filePath === 'src/components/ui/Card.tsx') {
      return `import type { ReactNode } from 'react';

export function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">{children}</div>;
}
`;
    }

    if (filePath.endsWith('.css') || filePath.endsWith('.scss')) {
      return `:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f8fafc;
}
`;
    }

    if (filePath.endsWith('.md')) {
      return `# Frontend

This frontend was generated for ${projectName}.

## Setup

Install dependencies, configure the backend API URL, then run the Next.js development server.

## Structure

- \`src/app/page.tsx\` contains the main task workspace.
- \`src/components/ui\` contains reusable interface primitives.
`;
    }

    return `export default function GeneratedComponent() {
  return <div>${projectName}</div>;
}
`;
  }
}
