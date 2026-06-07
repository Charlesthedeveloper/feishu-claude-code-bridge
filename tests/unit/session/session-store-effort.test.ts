import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store.js';

const cleanups: Array<() => Promise<void>> = [];

describe('SessionStore effort override', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('preserves effort across run starts and reloads', async () => {
    const file = await sessionFile();
    const store = new SessionStore(file);

    store.setEffort('chat-a', 'low');
    store.set('chat-a', 'session-1', '/tmp/project');
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();

    expect(reloaded.resumeFor('chat-a', '/tmp/project')).toBe('session-1');
    expect(reloaded.getEffort('chat-a')).toBe('low');
  });

  it('clears only session identity after a silent timeout', async () => {
    const file = await sessionFile();
    const store = new SessionStore(file);

    store.set('chat-a', 'session-1', '/tmp/project');
    store.setEffort('chat-a', 'medium');
    expect(store.clearSession('chat-a')).toBe(true);
    await store.flush();

    const reloaded = new SessionStore(file);
    await reloaded.load();

    expect(reloaded.resumeFor('chat-a', '/tmp/project')).toBeUndefined();
    expect(reloaded.getRaw('chat-a')?.sessionId).toBeUndefined();
    expect(reloaded.getRaw('chat-a')?.cwd).toBeUndefined();
    expect(reloaded.getEffort('chat-a')).toBe('medium');
  });

  it('normalizes effort aliases while loading persisted state', async () => {
    const file = await sessionFile();
    await writeFile(
      file,
      `${JSON.stringify({ 'chat-a': { updatedAt: 1, effort: 'extra high' } }, null, 2)}\n`,
      'utf8',
    );

    const store = new SessionStore(file);
    await store.load();

    expect(store.getEffort('chat-a')).toBe('xhigh');
  });
});

async function sessionFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-effort-test-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }));
  return join(dir, 'sessions.json');
}
