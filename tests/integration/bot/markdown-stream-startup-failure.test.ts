import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.LARK_CHANNEL_FALLBACK_SEND_RETRY_DELAYS_MS;
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown stream startup failures', () => {
  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    const markdown = markdownMessages(h.channel).join('\n');
    expect(markdown).toContain('agent 失败');
    expect(markdown).toContain('codex exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 2500);

    expect(markdownMessages(h.channel).join('\n')).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);

  it('does not post a duplicate markdown fallback when stream updates succeeded', async () => {
    const streamDone = deferred<void>();
    const streamed: string[] = [];
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          void producer({
            setContent: vi.fn(async (markdown: string) => {
              streamed.push(markdown);
            }),
          });
        }
        await streamDone.promise;
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: 'single streamed output' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_duplicate', 'task'));
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    expect(streamed.join('\n')).toContain('single streamed output');
    expect(markdownMessages(h.channel)).toEqual([]);
    streamDone.resolve();
  }, 10_000);

  it('waits briefly for a late stream producer before posting a fallback', async () => {
    const streamed: string[] = [];
    const h = await createHarness({
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (!producer) throw new Error('expected markdown producer');
        await new Promise((resolve) => setTimeout(resolve, 50));
        await producer({
          setContent: vi.fn(async (markdown: string) => {
            streamed.push(markdown);
          }),
        });
      },
    });
    h.agent.setEvents([{ type: 'done', terminationReason: 'normal' }]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_late_producer', 'task'));
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    expect(streamed.join('\n')).toContain('没有返回正文或工具操作');
    expect(markdownMessages(h.channel)).toEqual([]);
  }, 10_000);

  it('keeps draining the agent and sends a final transcript when card updates fail', async () => {
    const h = await createHarness({
      messageReply: 'card',
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(card: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        if (!producer) throw new Error('expected card producer');
        await producer({
          update: vi.fn(async () => {
            throw new Error('card payload too large');
          }),
        });
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: 'part one' },
      { type: 'text', delta: ' and part two' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card', 'long task'));
    await waitFor(() => markdownMessages(h.channel).some((m) => m.includes('完整输出')));

    const markdown = markdownMessages(h.channel).join('\n');
    expect(markdown).toContain('实时卡片更新失败');
    expect(markdown).toContain('part one and part two');
    expect(markdown).toContain('✅ 已完成');
  });

  it('sends a final transcript for long card-mode output even when streaming succeeds', async () => {
    const h = await createHarness({
      messageReply: 'card',
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(card: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        if (!producer) throw new Error('expected card producer');
        await producer({ update: vi.fn(async () => {}) });
      },
    });
    const longAnswer = 'A'.repeat(6500);
    h.agent.setEvents([
      { type: 'text', delta: longAnswer },
      { type: 'done', terminationReason: 'normal' },
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_long_card', 'long task'));
    await waitFor(() => markdownMessages(h.channel).some((m) => m.includes('长内容自动分段输出')));

    const markdown = markdownMessages(h.channel).join('\n');
    expect(markdown).toContain('完整输出');
    expect(markdown).toContain(longAnswer.slice(0, 200));
    expect(markdown).toContain('✅ 已完成');
  });

  it('retries transient send failures when posting a markdown fallback', async () => {
    process.env.LARK_CHANNEL_FALLBACK_SEND_RETRY_DELAYS_MS = '1,1';
    const transient = Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), {
      code: 'ENOTFOUND',
    });
    const h = await createHarness({
      messageReply: 'markdown',
      sendFailures: [transient],
      stream: async () => {
        throw transient;
      },
    });
    h.agent.setEvents([
      { type: 'text', delta: 'network recovered output' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_retry', 'task'));
    await waitFor(() =>
      markdownMessages(h.channel).some((m) => m.includes('network recovered output')),
    );

    const markdown = markdownMessages(h.channel).join('\n');
    expect(markdown).toContain('network recovered output');
    expect(markdown).toContain('✅ 已完成');
  });
});

async function createHarness(options: {
  messageReply?: 'card' | 'markdown' | 'text';
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  sendFailures?: unknown[];
  stream?: StreamFn;
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    preferences: options.messageReply ? { messageReply: options.messageReply } : undefined,
    access: {
      allowedUsers: ['ou_user'],
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  sendFailures?: unknown[];
  stream?: StreamFn;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
          },
          messageReaction: {
            create: vi.fn(options.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, sendOptions) {
      const failure = options.sendFailures?.shift();
      if (failure) throw failure;
      sent.push({ chatId, content, options: sendOptions });
    },
    stream: options.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function markdownMessages(channel: FakeLarkChannel): string[] {
  return channel.sent
    .map((msg) => (msg.content as { markdown?: string } | undefined)?.markdown)
    .filter((markdown): markdown is string => typeof markdown === 'string');
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
