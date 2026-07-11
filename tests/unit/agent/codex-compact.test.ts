import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexCompactError,
  compactCodexThread,
} from '../../../src/session/codex-compact.js';

interface FakeCodex {
  dir: string;
  path: string;
  recordPath: string;
}

describe('Codex thread compaction provider', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('waits for a real contextCompaction completion notification', async () => {
    const fake = await createFakeCodex('success');
    cleanup.push(fake.dir);

    await expect(
      compactCodexThread({
        binary: fake.path,
        threadId: 'thread-1',
        profileStateDir: fake.dir,
        timeoutMs: 5000,
      }),
    ).resolves.toEqual({ threadId: 'thread-1', turnId: 'turn-1' });

    const record = JSON.parse(await readFile(fake.recordPath, 'utf8')) as {
      argv: string[];
      requests: Array<{ method: string; params?: unknown }>;
    };
    expect(record.argv).toEqual(['app-server', '--listen', 'stdio://']);
    expect(record.requests).toMatchObject([
      { method: 'initialize' },
      { method: 'thread/resume', params: { threadId: 'thread-1' } },
      { method: 'thread/compact/start', params: { threadId: 'thread-1' } },
    ]);
  });

  it('does not treat the accepted response as completed compaction', async () => {
    const fake = await createFakeCodex('accepted-only');
    cleanup.push(fake.dir);

    await expect(
      compactCodexThread({
        binary: fake.path,
        threadId: 'thread-1',
        profileStateDir: fake.dir,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      name: 'CodexCompactError',
      code: 'timeout',
    } satisfies Partial<CodexCompactError>);
  });

  it('surfaces app-server compaction failures', async () => {
    const fake = await createFakeCodex('failure');
    cleanup.push(fake.dir);

    await expect(
      compactCodexThread({
        binary: fake.path,
        threadId: 'thread-1',
        profileStateDir: fake.dir,
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({
      name: 'CodexCompactError',
      code: 'compaction-failed',
      message: 'upstream unavailable',
    } satisfies Partial<CodexCompactError>);
  });
});

async function createFakeCodex(
  mode: 'success' | 'accepted-only' | 'failure',
): Promise<FakeCodex> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-compact-test-'));
  const scriptPath = process.platform === 'win32' ? join(dir, 'codex-app-server.mjs') : join(dir, 'codex');
  const path = process.platform === 'win32' ? join(dir, 'codex.cmd') : scriptPath;
  const recordPath = join(dir, 'record.json');
  const script = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const requests = [];
const recordPath = ${JSON.stringify(recordPath)};
const mode = ${JSON.stringify(mode)};
let persisted = false;
let resumedThread;

function persist() {
  if (persisted) return;
  persisted = true;
  writeFileSync(recordPath, JSON.stringify({
    argv: process.argv.slice(2),
    requests
  }, null, 2));
}

process.on('SIGTERM', () => {
  persist();
  process.exit(0);
});
process.on('exit', persist);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  requests.push({ method: req.method, params: req.params });
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: req.id, result: {} }) + '\\n');
    return;
  }
  if (req.method === 'thread/resume') {
    resumedThread = req.params.threadId;
    process.stdout.write(JSON.stringify({
      id: req.id,
      result: { thread: { id: resumedThread } }
    }) + '\\n');
    return;
  }
  if (req.method !== 'thread/compact/start') return;

  if (resumedThread !== req.params.threadId) {
    process.stdout.write(JSON.stringify({
      id: req.id,
      error: { code: -32000, message: 'thread not found: ' + req.params.threadId }
    }) + '\\n');
    return;
  }

  process.stdout.write(JSON.stringify({ id: req.id, result: {} }) + '\\n');
  if (mode === 'success') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        method: 'item/completed',
        params: {
          threadId: req.params.threadId,
          turnId: 'turn-1',
          completedAtMs: Date.now(),
          item: { id: 'item-1', type: 'contextCompaction' }
        }
      }) + '\\n');
    }, 20);
  } else if (mode === 'failure') {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        method: 'error',
        params: {
          threadId: req.params.threadId,
          turnId: 'turn-1',
          willRetry: false,
          error: { message: 'upstream unavailable' }
        }
      }) + '\\n');
    }, 20);
  }
});
`;
  await writeFile(scriptPath, script, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await chmod(path, 0o755);
  }
  return { dir, path, recordPath };
}
