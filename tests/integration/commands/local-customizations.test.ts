import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { ProcessPool } from '../../../src/bot/process-pool.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import {
  createDefaultProfileConfig,
  type AgentKind,
  type ProfileConfig,
} from '../../../src/config/profile-schema.js';
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

    await expect(h.run('/effort ultracode')).resolves.toBe(true);
    expect(h.sessions.getEffort('chat-1')).toBe('ultracode');
    expect(lastMarkdown(h.channel)).toContain('ultracode');

    await expect(h.run('/effort auto')).resolves.toBe(true);
    expect(h.sessions.getEffort('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('auto');
  });

  it('sets the Claude session model through /model aliases without mutating global defaults', async () => {
    const h = await createHarness();
    h.controls.cfg.preferences = {
      ...(h.controls.cfg.preferences ?? {}),
      model: 'claude-opus-4-8',
    };

    await expect(h.run('/model')).resolves.toBe(true);
    expect(lastMarkdown(h.channel)).toContain('claude-opus-4-8');
    expect(lastMarkdown(h.channel)).toContain('跟随全局');

    await expect(h.run('/model fable')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('fable');
    expect(h.sessions.getModel('chat-2')).toBeUndefined();
    expect(h.controls.cfg.preferences?.model).toBe('claude-opus-4-8');
    expect(lastMarkdown(h.channel)).toContain('fable');

    await expect(h.run('/model fable5')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('claude-fable-5');
    expect(h.controls.cfg.preferences?.model).toBe('claude-opus-4-8');
    expect(lastMarkdown(h.channel)).toContain('claude-fable-5');

    await expect(h.run('/model best')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('best');
    expect(lastMarkdown(h.channel)).toContain('best');

    await expect(h.run('/model opus')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('opus');
    expect(h.controls.cfg.preferences?.model).toBe('claude-opus-4-8');
    expect(lastMarkdown(h.channel)).toContain('opus');

    await expect(h.run('/model sonnet-4-6')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('claude-sonnet-4-6');
    expect(h.controls.cfg.preferences?.model).toBe('claude-opus-4-8');
    expect(lastMarkdown(h.channel)).toContain('claude-sonnet-4-6');

    await expect(h.run('/model sonnet5')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('claude-sonnet-5');
    expect(h.controls.cfg.preferences?.model).toBe('claude-opus-4-8');
    expect(lastMarkdown(h.channel)).toContain('claude-sonnet-5');

    await expect(h.run('/model sonnet-1m')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('sonnet[1m]');
    expect(lastMarkdown(h.channel)).toContain('sonnet[1m]');

    await expect(h.run('/model opus-1m')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('opus[1m]');
    expect(lastMarkdown(h.channel)).toContain('opus[1m]');

    await expect(h.run('/model default')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBeUndefined();
    expect(h.controls.cfg.preferences?.model).toBe('claude-opus-4-8');
    expect(lastMarkdown(h.channel)).toContain('已清除当前 session Claude model');
  });

  it('can still set the Claude global default model explicitly', async () => {
    const h = await createHarness();

    await expect(h.run('/model global fable')).resolves.toBe(true);
    expect(h.controls.cfg.preferences?.model).toBe('fable');
    expect(h.sessions.getModel('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('全局默认 Claude model 已设为 `fable`');

    await expect(h.run('/model global default')).resolves.toBe(true);
    expect(h.controls.cfg.preferences?.model).toBe('');
    expect(lastMarkdown(h.channel)).toContain('已清除全局默认 Claude model');
  });

  it('sets Codex effort and model using Codex-native slash semantics', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/effort minimal')).resolves.toBe(true);
    expect(h.sessions.getEffort('chat-1')).toBe('minimal');
    expect(lastMarkdown(h.channel)).toContain('minimal');

    await expect(h.run('/effort max')).resolves.toBe(true);
    expect(h.sessions.getEffort('chat-1')).toBe('xhigh');
    expect(lastMarkdown(h.channel)).toContain('xhigh');

    await expect(h.run('/model gpt-5.5')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('gpt-5.5');
    expect(h.controls.cfg.preferences?.model).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('当前 session Codex model 已设为 `gpt-5.5`');

    await expect(h.run('/model fable')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBe('fable');
    expect(h.controls.cfg.preferences?.model).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('当前 session Codex model 已设为 `fable`');

    await expect(h.run('/model default')).resolves.toBe(true);
    expect(h.sessions.getModel('chat-1')).toBeUndefined();
    expect(h.controls.cfg.preferences?.model).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已清除当前 session Codex model');
  });

  it('runs /compact against the current session without creating a fresh one', async () => {
    const h = await createHarness();
    const cwd = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'session-existing', cwd);
    h.sessions.setEffort('chat-1', 'medium');
    h.sessions.setModel('chat-1', 'claude-opus-4-8');
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
      model: 'claude-opus-4-8',
      effort: 'medium',
    });
    expect(h.sessions.resumeFor('chat-1', cwd)).toBe('session-existing');
    expect(JSON.stringify(h.channel.streams.at(-1)?.cardUpdates)).toContain('compacted');
  });

  it('surfaces Claude compact text failures as failed cards', async () => {
    const h = await createHarness();
    const cwd = await realpath(h.tmp.workspace);
    h.sessions.set('chat-1', 'session-existing', cwd);
    h.agent.setEvents([
      { type: 'system', sessionId: 'session-existing', cwd },
      {
        type: 'text',
        delta:
          'Error during compaction: API Error: Connection closed mid-response. The response above may be incomplete.',
      },
      { type: 'done', sessionId: 'session-existing', terminationReason: 'normal' },
    ]);

    await expect(h.run('/compact keep market notes')).resolves.toBe(true);

    const rendered = JSON.stringify(h.channel.streams.at(-1)?.cardUpdates.at(-1));
    expect(rendered).toContain('出错');
    expect(rendered).toContain('agent 失败');
    expect(rendered).not.toContain('已完成');
  });
});

async function createHarness(agentKind: AgentKind = 'claude'): Promise<Harness> {
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
  const profileConfig = appConfig(workspaceRealpath, agentKind);
  await saveRootConfig(createRootConfig(agentKind, profileConfig), configPath);
  const controls = {
    profile: agentKind,
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

function appConfig(defaultWorkspace: string, agentKind: AgentKind): ProfileConfig {
  const config = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-admin'] },
    sandbox: { defaultMode: 'read-only', maxMode: 'workspace-write' },
    preferences: { maxConcurrentRuns: 2, effort: 'xhigh' },
    ...(agentKind === 'codex'
      ? {
          codex: {
            binaryPath: '/usr/local/bin/codex',
            inheritCodexHome: true,
            ignoreUserConfig: false,
            ignoreRules: false,
          },
        }
      : {}),
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
