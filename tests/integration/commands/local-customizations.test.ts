import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { RunExecutor } from '../../../src/runtime/run-executor.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  activeRuns: ActiveRuns;
  agent: ReturnType<typeof createFakeAgent>;
  controls: Controls;
  run(content: string): Promise<boolean>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('local bridge customizations', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('sets per-session effort through /effort and /new effort', async () => {
    const h = await createHarness();

    await expect(h.run('/effort low')).resolves.toBe(true);
    expect(h.sessions.getEffort('chat-1')).toBe('low');
    expect(lastMarkdown(h.channel)).toContain('low');

    h.sessions.set('chat-1', 'session-old', await realpath(h.tmp.workspace));
    await expect(h.run('/new max')).resolves.toBe(true);
    expect(h.sessions.resumeFor('chat-1', await realpath(h.tmp.workspace))).toBeUndefined();
    expect(h.sessions.getEffort('chat-1')).toBe('max');
    expect(lastMarkdown(h.channel)).toContain('max');

    await expect(h.run('/effort default')).resolves.toBe(true);
    expect(h.sessions.getEffort('chat-1')).toBeUndefined();
  });

  it('sets the Claude profile model through /model aliases', async () => {
    const h = await createHarness();

    await expect(h.run('/model')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('Claude Code default');

    await expect(h.run('/model fable')).resolves.toBe(true);
    expect(h.controls.cfg.preferences?.model).toBe('claude-fable-5');
    expect(lastMarkdown(h.channel)).toContain('claude-fable-5');

    await expect(h.run('/model opus')).resolves.toBe(true);
    expect(h.controls.cfg.preferences?.model).toBe('claude-opus-4-8');
    expect(lastMarkdown(h.channel)).toContain('claude-opus-4-8');

    await expect(h.run('/model default')).resolves.toBe(true);
    expect(h.controls.cfg.preferences?.model).toBe('');
    expect(lastMarkdown(h.channel)).toContain('已清除默认 Claude model');
  });

  it('runs /compact against the current session without creating a fresh one', async () => {
    const h = await createHarness();
    const cwd = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'session-existing', cwd);
    h.sessions.setEffort('chat-1', 'medium');
    h.controls.cfg.preferences = {
      ...(h.controls.cfg.preferences ?? {}),
      model: 'claude-fable-5',
    };
    h.agent.setEvents([
      { type: 'system', sessionId: 'session-existing', cwd },
      { type: 'text', delta: 'compacted' },
      { type: 'done', sessionId: 'session-existing', terminationReason: 'normal' },
    ]);

    await expect(h.run('/compact keep naming preferences')).resolves.toBe(true);

    expect(h.agent.runOptions).toHaveLength(1);
    expect(h.agent.runOptions[0]).toMatchObject({
      prompt: '/compact keep naming preferences',
      cwd,
      sessionId: 'session-existing',
      model: 'claude-fable-5',
      effort: 'medium',
    });
    expect(h.sessions.resumeFor('chat-1', cwd)).toBe('session-existing');
    expect(JSON.stringify(h.channel.streams.at(-1)?.cardUpdates)).toContain('compacted');
  });
});

async function createHarness(): Promise<Harness> {
  const tmp = await createTmpProfile('local-custom-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const agent = createFakeAgent();
  const pool = new ProcessPool(() => 2);
  const runExecutor = new RunExecutor({ agent, pool, activeRuns });
  const workspaceRealpath = await realpath(tmp.workspace);
  const configPath = join(tmp.root, 'config.json');
  const profileConfig = appConfig(workspaceRealpath);
  await saveRootConfig(createRootConfig('claude', profileConfig), configPath);
  const controls = {
    profile: 'claude',
    profileConfig,
    botOwnerId: 'ou-owner',
    ownerRefreshState: 'ok',
    ownerRefreshedAt: 1_700_000_000_000,
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;

  workspaces.setCwd('chat-1', workspaceRealpath);

  const run = (content: string): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: 'p2p',
      sessions,
      workspaces,
      agent,
      activeRuns,
      runExecutor,
      processPool: pool,
      controls,
    });

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return { tmp, channel, sessions, workspaces, activeRuns, agent, controls, run };
}

function appConfig(defaultWorkspace: string): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    preferences: { maxConcurrentRuns: 2, effort: 'xhigh' },
  });
  config.workspaces.default = defaultWorkspace;
  return config;
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-admin',
    senderName: 'User',
    content,
    resources: [],
    mentions: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = lastContent(channel);
  expect(content.markdown).toBeTypeOf('string');
  return content.markdown as string;
}
