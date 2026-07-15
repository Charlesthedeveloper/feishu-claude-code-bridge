import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import {
  ExternalBotWatcher,
  type ExternalBotResult,
} from '../../../src/bot/external-bot-watcher.js';

const START = 1_760_000_000_000;

describe('ExternalBotWatcher', () => {
  it('recognizes a real external-bot mention and marks it as a silent delegation', async () => {
    const h = harness();
    const trigger = userMessage({
      // This is the shape observed in live Feishu events: bot app_id is
      // surfaced through MentionInfo.userId instead of openId.
      mentions: [{ key: '@_user_1', userId: 'cli_alpha', name: 'AlphaPai Work' }],
      mentionedBot: false,
    });

    const observation = await h.watcher.observeDelegation(trigger, 'oc_chat');

    expect(observation).toEqual({
      delegatedOnly: true,
      targets: [{ openId: 'ou_alpha', appId: 'cli_alpha', name: 'AlphaPai Work' }],
    });
    expect(trigger.mentions).toEqual([
      { key: '@_user_1', userId: 'cli_alpha', name: 'AlphaPai Work', isBot: true },
    ]);
    expect(h.memberRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        url: '/open-apis/im/v1/chats/oc_chat/members/list',
      }),
    );
  });

  it('delivers one stable batch with the original request, card, and attachment metadata', async () => {
    const h = harness();
    const trigger = userMessage({
      content: '@AlphaPai Work 分析中际旭创',
      mentions: [{ key: '@_user_1', openId: 'ou_alpha', name: 'AlphaPai Work' }],
      mentionedBot: false,
    });
    await h.watcher.observeDelegation(trigger, 'oc_chat');
    h.messageList.mockResolvedValue(messageResponse([
      apiMessage({
        messageId: 'om_own',
        senderAppId: 'cli_bridge',
        content: JSON.stringify({ text: 'bridge output must be ignored' }),
      }),
      apiMessage({
        messageId: 'om_card',
        senderAppId: 'cli_alpha',
        msgType: 'interactive',
        content: JSON.stringify({
          schema: '2.0',
          body: {
            elements: [{ tag: 'markdown', content: '研究结论已经完成\n✅ 已完成' }],
          },
        }),
      }),
      apiMessage({
        messageId: 'om_file',
        senderAppId: 'cli_alpha',
        msgType: 'file',
        content: JSON.stringify({
          file_key: 'file_v3_report',
          file_name: '中际旭创研究.docx',
        }),
      }),
    ]));

    await h.watcher.pollOnce();
    expect(h.results).toHaveLength(0);
    h.advance(6_000);
    await h.watcher.pollOnce();

    expect(h.results).toHaveLength(1);
    const result = h.results[0]!;
    expect(result.trigger).toBe(trigger);
    expect(result.messages.map((message) => message.messageId)).toEqual(['om_card', 'om_file']);
    expect(result.messages[0]).toMatchObject({
      senderId: 'cli_alpha',
      senderName: 'AlphaPai Work',
      content: expect.stringContaining('研究结论已经完成'),
      mentionedBot: true,
    });
    expect(result.messages[1]?.resources).toEqual([
      {
        type: 'file',
        fileKey: 'file_v3_report',
        fileName: '中际旭创研究.docx',
      },
    ]);

    h.advance(10_000);
    await h.watcher.pollOnce();
    expect(h.results).toHaveLength(1);
  });

  it('waits through an in-progress card update and forwards only the final version', async () => {
    const h = harness();
    await h.watcher.observeDelegation(userMessage({
      mentions: [{ key: '@_user_1', openId: 'ou_alpha', name: 'AlphaPai Work' }],
      mentionedBot: false,
    }), 'oc_chat');
    h.messageList.mockResolvedValue(messageResponse([
      apiMessage({
        messageId: 'om_stream',
        senderAppId: 'cli_alpha',
        content: JSON.stringify({ text: '正在调用工具…' }),
        updateTime: String(START + 1_000),
      }),
    ]));

    await h.watcher.pollOnce();
    h.advance(6_000);
    await h.watcher.pollOnce();
    expect(h.results).toHaveLength(0);

    h.messageList.mockResolvedValue(messageResponse([
      apiMessage({
        messageId: 'om_stream',
        senderAppId: 'cli_alpha',
        content: JSON.stringify({ text: '最终研究结果\n✅ 已完成' }),
        updateTime: String(START + 8_000),
      }),
    ]));
    await h.watcher.pollOnce();
    h.advance(6_000);
    await h.watcher.pollOnce();

    expect(h.results).toHaveLength(1);
    expect(h.results[0]?.messages[0]?.content).toContain('最终研究结果');
  });

  it('expires an unanswered delegation without polling forever', async () => {
    const h = harness({ watchTtlMs: 10_000 });
    await h.watcher.observeDelegation(userMessage({
      mentions: [{ key: '@_user_1', openId: 'ou_alpha', name: 'AlphaPai Work' }],
      mentionedBot: false,
    }), 'oc_chat');

    h.advance(10_000);
    await h.watcher.pollOnce();
    h.advance(10_000);
    await h.watcher.pollOnce();

    expect(h.results).toHaveLength(0);
    expect(h.messageList).not.toHaveBeenCalled();
  });
});

function harness(options: { watchTtlMs?: number } = {}) {
  let now = START;
  const results: ExternalBotResult[] = [];
  const memberRequest = vi.fn(async () => ({
    code: 0,
    data: {
      items: [
        { member_id: 'ou_bridge', app_id: 'cli_bridge', name: 'Claude Code' },
        { member_id: 'ou_alpha', app_id: 'cli_alpha', name: 'AlphaPai Work' },
      ],
      has_more: false,
    },
  }));
  const messageList = vi.fn(async () => messageResponse([]));
  const channel = {
    botIdentity: { openId: 'ou_bridge', name: 'Claude Code' },
    rawClient: {
      request: memberRequest,
      im: { v1: { message: { list: messageList } } },
    },
  } as unknown as LarkChannel;
  const watcher = new ExternalBotWatcher({
    channel,
    ownAppId: 'cli_bridge',
    onResult: (result) => {
      results.push(result);
    },
    now: () => now,
    settleMs: 6_000,
    watchTtlMs: options.watchTtlMs ?? 60_000,
  });
  return {
    watcher,
    results,
    memberRequest,
    messageList,
    advance(ms: number) {
      now += ms;
    },
  };
}

function userMessage(input: {
  content?: string;
  mentions: Array<{ key: string; openId?: string; userId?: string; name: string }>;
  mentionedBot: boolean;
}): NormalizedMessage {
  return {
    messageId: 'om_trigger',
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: 'ou_owner',
    senderName: 'Charles Li',
    content: input.content ?? '@AlphaPai Work 请研究',
    rawContentType: 'text',
    resources: [],
    mentions: input.mentions,
    mentionAll: false,
    mentionedBot: input.mentionedBot,
    createTime: START,
    raw: {
      sender: {
        sender_id: { open_id: 'ou_owner' },
        sender_type: 'user',
      },
    },
  };
}

function apiMessage(input: {
  messageId: string;
  senderAppId: string;
  content: string;
  msgType?: string;
  updateTime?: string;
}) {
  return {
    message_id: input.messageId,
    chat_id: 'oc_chat',
    msg_type: input.msgType ?? 'text',
    create_time: String(START + 1_000),
    update_time: input.updateTime ?? String(START + 1_000),
    deleted: false,
    sender: {
      id: input.senderAppId,
      id_type: 'app_id',
      sender_type: 'app',
    },
    body: { content: input.content },
  };
}

function messageResponse(items: ReturnType<typeof apiMessage>[]) {
  return {
    code: 0,
    data: {
      has_more: false,
      items,
    },
  };
}
