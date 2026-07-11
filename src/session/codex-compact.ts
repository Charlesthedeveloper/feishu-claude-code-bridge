import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import {
  mergeProcessEnv,
  spawnProcess,
  type SpawnedProcessByStdio,
} from '../platform/spawn';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CompactCodexThreadOptions {
  binary: string;
  threadId: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  timeoutMs?: number;
}

export interface CompactCodexThreadResult {
  threadId: string;
  turnId?: string;
}

export type CodexCompactErrorCode =
  | 'spawn-failed'
  | 'timeout'
  | 'app-server-error'
  | 'compaction-failed';

export class CodexCompactError extends Error {
  readonly code: CodexCompactErrorCode;

  constructor(code: CodexCompactErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexCompactError';
    this.code = code;
  }
}

const DEFAULT_COMPACT_TIMEOUT_MS = 5 * 60 * 1000;

export async function compactCodexThread(
  options: CompactCodexThreadOptions,
): Promise<CompactCodexThreadResult> {
  const child = spawnCodexAppServer(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMPACT_TIMEOUT_MS;
  const stderrChunks: Buffer[] = [];
  let settled = false;

  const result = await new Promise<CompactCodexThreadResult>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (kill: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      child.removeListener('error', fail);
      child.stdin.removeListener('error', fail);
      child.stderr.removeAllListeners('data');
      if (kill && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };

    const finish = (value: CompactCodexThreadResult): void => {
      if (settled) return;
      resolve(value);
      cleanup(true);
    };

    const fail = (err: unknown): void => {
      if (settled) return;
      reject(
        err instanceof CodexCompactError
          ? err
          : new CodexCompactError('spawn-failed', errorMessage(err)),
      );
      cleanup(true);
    };

    timer = setTimeout(() => {
      fail(
        new CodexCompactError(
          'timeout',
          `codex compaction timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    child.once('error', fail);
    child.stdin.once('error', fail);
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    rl.on('line', (line) => {
      const message = parseRecord(line);
      if (!message) return;

      if ((message.id === 2 || message.id === 3) && message.error) {
        const error = recordValue(message.error);
        fail(
          new CodexCompactError(
            'app-server-error',
            stringValue(error?.message) ?? 'codex app-server rejected compaction',
          ),
        );
        return;
      }

      if (message.id === 2 && message.result) {
        try {
          child.stdin.write(`${JSON.stringify(compactRequest(options.threadId))}\n`, 'utf8', (err?: Error | null) => {
            if (err) fail(err);
          });
        } catch (err) {
          fail(err);
        }
        return;
      }

      const method = stringValue(message.method);
      const params = recordValue(message.params);
      if (!method || !params || stringValue(params.threadId) !== options.threadId) return;

      if (method === 'thread/compacted') {
        finish({
          threadId: options.threadId,
          ...(stringValue(params.turnId) ? { turnId: stringValue(params.turnId) } : {}),
        });
        return;
      }

      if (method === 'item/completed') {
        const item = recordValue(params.item);
        if (stringValue(item?.type) !== 'contextCompaction') return;
        finish({
          threadId: options.threadId,
          ...(stringValue(params.turnId) ? { turnId: stringValue(params.turnId) } : {}),
        });
        return;
      }

      if (method === 'error' && params.willRetry !== true) {
        const error = recordValue(params.error);
        fail(
          new CodexCompactError(
            'compaction-failed',
            stringValue(error?.message) ?? 'codex compaction failed',
          ),
        );
        return;
      }

      if (method === 'turn/completed') {
        const turn = recordValue(params.turn);
        if (stringValue(turn?.status) !== 'failed') return;
        const error = recordValue(turn?.error);
        fail(
          new CodexCompactError(
            'compaction-failed',
            stringValue(error?.message) ?? 'codex compaction failed',
          ),
        );
      }
    });

    child.once('exit', (code) => {
      if (settled) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      fail(
        new CodexCompactError(
          'spawn-failed',
          `codex app-server exited before compaction completed: ${code ?? 'signal'}${stderr ? `: ${stderr}` : ''}`,
        ),
      );
    });

    try {
      child.stdin.write(
        `${JSON.stringify(initializeRequest())}\n${JSON.stringify(resumeRequest(options.threadId))}\n`,
        'utf8',
        (err?: Error | null) => {
          if (err) fail(err);
        },
      );
    } catch (err) {
      fail(err);
    }
  });

  await waitForChildExit(child, 250);
  return result;
}

function spawnCodexAppServer(options: CompactCodexThreadOptions): CodexAppServerChild {
  const envOverrides: NodeJS.ProcessEnv = {};
  if (options.codexHome) {
    envOverrides.CODEX_HOME = options.codexHome;
  } else if (options.inheritCodexHome === false) {
    envOverrides.CODEX_HOME = join(options.profileStateDir, 'codex-home');
  }

  return spawnProcess(options.binary, ['app-server', '--listen', 'stdio://'], {
    env: mergeProcessEnv(process.env, envOverrides),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CodexAppServerChild;
}

function initializeRequest() {
  return {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge',
        version: '0.3.1',
      },
      capabilities: null,
    },
  };
}

function compactRequest(threadId: string) {
  return {
    method: 'thread/compact/start',
    id: 3,
    params: { threadId },
  };
}

function resumeRequest(threadId: string) {
  return {
    method: 'thread/resume',
    id: 2,
    params: { threadId },
  };
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return recordValue(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

async function waitForChildExit(child: CodexAppServerChild, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      resolve();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
