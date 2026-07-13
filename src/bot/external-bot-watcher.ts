import {
  normalize,
  type LarkChannel,
  type NormalizedMessage,
  type RawMessageEvent,
} from '@larksuite/channel';
import { log, reportMetric } from '../core/logger';

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_SETTLE_MS = 6_000;
const DEFAULT_WATCH_TTL_MS = 6 * 60 * 60 * 1_000;
const BOT_MEMBER_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_MEMBER_PAGES = 10;
const MAX_MESSAGE_PAGES = 10;

interface ExternalBotTarget {
  openId: string;
  appId: string;
  name?: string;
}

interface BotMember {
  member_id?: string;
  app_id?: string;
  name?: string;
}

interface BotMemberResponse {
  code?: number;
  msg?: string;
  data?: {
    items?: BotMember[];
    has_more?: boolean;
    page_token?: string;
  };
}

interface ApiMessageItem {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type?: string;
  create_time?: string;
  update_time?: string;
  deleted?: boolean;
  chat_id?: string;
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
    tenant_key?: string;
    sender_name?: string;
  };
  body?: { content?: string };
  mentions?: Array<{
    key?: string;
    id?: string;
    id_type?: string;
    name?: string;
    tenant_key?: string;
  }>;
  message_position?: string;
}

interface Candidate {
  item: ApiMessageItem;
  fingerprint: string;
  stableSince: number;
}

interface DelegationWatch {
  scope: string;
  chatId: string;
  threadId?: string;
  trigger: NormalizedMessage;
  startedAt: number;
  expiresAt: number;
  targetsByAppId: Map<string, ExternalBotTarget>;
  targetOpenIds: Set<string>;
  candidates: Map<string, Candidate>;
}

interface BotMemberCacheEntry {
  expiresAt: number;
  byOpenId: Map<string, ExternalBotTarget>;
}

export interface DelegationObservation {
  delegatedOnly: boolean;
  targets: ExternalBotTarget[];
}

export interface ExternalBotResult {
  scope: string;
  trigger: NormalizedMessage;
  messages: NormalizedMessage[];
}

export interface ExternalBotWatcherOptions {
  channel: LarkChannel;
  ownAppId: string;
  onResult(result: ExternalBotResult): Promise<void> | void;
  now?: () => number;
  pollIntervalMs?: number;
  settleMs?: number;
  watchTtlMs?: number;
}

/**
 * Feishu does not push unmentioned bot-authored group messages to another
 * bot's WebSocket. This watcher closes that gap only after an authorized user
 * explicitly delegates work by @-mentioning another bot. It polls while that
 * handoff is outstanding, then forwards one stable result batch and stops.
 */
export class ExternalBotWatcher {
  private readonly channel: LarkChannel;
  private readonly ownAppId: string;
  private readonly onResult: ExternalBotWatcherOptions['onResult'];
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly settleMs: number;
  private readonly watchTtlMs: number;
  private readonly watches = new Map<string, DelegationWatch>();
  private readonly botMembers = new Map<string, BotMemberCacheEntry>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private stopped = false;

  constructor(options: ExternalBotWatcherOptions) {
    this.channel = options.channel;
    this.ownAppId = options.ownAppId;
    this.onResult = options.onResult;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? envMs(
      'LARK_CHANNEL_EXTERNAL_BOT_POLL_INTERVAL_MS',
      DEFAULT_POLL_INTERVAL_MS,
    );
    this.settleMs = options.settleMs ?? envMs(
      'LARK_CHANNEL_EXTERNAL_BOT_SETTLE_MS',
      DEFAULT_SETTLE_MS,
    );
    this.watchTtlMs = options.watchTtlMs ?? envMs(
      'LARK_CHANNEL_EXTERNAL_BOT_WATCH_TTL_MS',
      DEFAULT_WATCH_TTL_MS,
    );
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.watches.clear();
  }

  /**
   * Detect @mentions that resolve to other bot members in the current chat.
   * A message addressed only to those bots becomes a silent handoff; a message
   * that also @mentions this bridge is both processed normally and watched.
   */
  async observeDelegation(
    msg: NormalizedMessage,
    scope: string,
  ): Promise<DelegationObservation | undefined> {
    if (msg.chatType === 'p2p' || senderTypeOf(msg) !== 'user') return undefined;
    const mentionedOpenIds = new Set(
      (msg.mentions ?? [])
        .map((mention) => mention.openId)
        .filter((openId): openId is string => Boolean(openId)),
    );
    if (mentionedOpenIds.size === 0) return undefined;

    const observedAt = this.now();
    const triggerAt = msg.createTime > 0 ? Math.min(msg.createTime, observedAt) : observedAt;
    const botMembers = await this.fetchBotMembers(msg.chatId);
    const ownOpenId = this.channel.botIdentity?.openId;
    const targets = [...mentionedOpenIds]
      .filter((openId) => openId !== ownOpenId)
      .map((openId) => botMembers.get(openId))
      .filter((target): target is ExternalBotTarget => Boolean(target?.appId));
    if (targets.length === 0) return undefined;

    const targetOpenIds = new Set(targets.map((target) => target.openId));
    msg.mentions = (msg.mentions ?? []).map((mention) =>
      mention.openId && targetOpenIds.has(mention.openId)
        ? { ...mention, isBot: true }
        : mention,
    );

    const replaced = this.watches.has(scope);
    this.watches.set(scope, {
      scope,
      chatId: msg.chatId,
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
      trigger: msg,
      startedAt: triggerAt,
      expiresAt: observedAt + this.watchTtlMs,
      targetsByAppId: new Map(targets.map((target) => [target.appId, target])),
      targetOpenIds,
      candidates: new Map(),
    });
    log.info('bot-watch', replaced ? 'replaced' : 'started', {
      scope,
      targets: targets.map((target) => target.name ?? target.appId).join(','),
      ttlMs: this.watchTtlMs,
    });
    reportWatchMetric('started');

    return {
      delegatedOnly: !msg.mentionedBot,
      targets,
    };
  }

  /** Exposed for deterministic tests; production uses the interval above. */
  async pollOnce(): Promise<void> {
    if (this.stopped || this.polling || this.watches.size === 0) return;
    this.polling = true;
    try {
      for (const watch of [...this.watches.values()]) {
        await this.pollWatch(watch);
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollWatch(watch: DelegationWatch): Promise<void> {
    const now = this.now();
    if (now >= watch.expiresAt) {
      this.watches.delete(watch.scope);
      log.info('bot-watch', 'expired', { scope: watch.scope });
      reportWatchMetric('expired');
      return;
    }

    let items: ApiMessageItem[];
    try {
      items = await this.fetchMessages(watch);
    } catch (err) {
      log.warn('bot-watch', 'poll-failed', {
        scope: watch.scope,
        err: err instanceof Error ? err.message : String(err),
      });
      reportWatchMetric('poll-failed');
      return;
    }

    for (const item of items) {
      if (!this.matches(watch, item)) continue;
      const messageId = item.message_id!;
      const fingerprint = itemFingerprint(item);
      const current = watch.candidates.get(messageId);
      if (!current || current.fingerprint !== fingerprint) {
        watch.candidates.set(messageId, {
          item,
          fingerprint,
          stableSince: now,
        });
      } else {
        current.item = item;
      }
    }

    const candidates = [...watch.candidates.values()];
    if (candidates.length === 0) return;
    if (candidates.some((candidate) => now - candidate.stableSince < this.settleMs)) return;
    if (candidates.some((candidate) => looksInProgress(candidate.item))) return;

    const selected = candidates
      .map((candidate) => candidate.item)
      .sort(compareMessages);
    if (selected.length === 0) return;

    const normalized: NormalizedMessage[] = [];
    for (const item of selected) {
      try {
        const message = await this.normalizeItem(watch, item);
        if (message) normalized.push(message);
      } catch (err) {
        log.warn('bot-watch', 'normalize-failed', {
          scope: watch.scope,
          messageId: item.message_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (normalized.length === 0) return;
    if (this.stopped) return;

    // One explicit delegation produces one result batch. Removing the watch
    // before delivery is the loop breaker if the other bot reacts to us.
    this.watches.delete(watch.scope);
    try {
      await this.onResult({
        scope: watch.scope,
        trigger: watch.trigger,
        messages: normalized,
      });
      log.info('bot-watch', 'delivered', {
        scope: watch.scope,
        messages: normalized.length,
      });
      reportWatchMetric('delivered');
    } catch (err) {
      log.warn('bot-watch', 'delivery-failed', {
        scope: watch.scope,
        err: err instanceof Error ? err.message : String(err),
      });
      reportWatchMetric('delivery-failed');
    }
  }

  private matches(watch: DelegationWatch, item: ApiMessageItem): boolean {
    if (!item.message_id || item.deleted) return false;
    if (item.chat_id && item.chat_id !== watch.chatId) return false;
    if (item.sender?.sender_type !== 'app' && item.sender?.sender_type !== 'bot') return false;
    const senderAppId = item.sender?.id;
    if (!senderAppId || senderAppId === this.ownAppId) return false;
    if (!watch.targetsByAppId.has(senderAppId)) return false;
    if (watch.threadId && item.thread_id !== watch.threadId) return false;
    return epochMs(item.create_time) >= watch.startedAt - 1_000;
  }

  private async fetchMessages(watch: DelegationWatch): Promise<ApiMessageItem[]> {
    const items: ApiMessageItem[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
      const response = await this.channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: watch.chatId,
          start_time: String(Math.max(0, Math.floor((watch.startedAt - 2_000) / 1_000))),
          sort_type: 'ByCreateTimeAsc',
          page_size: 50,
          card_msg_content_type: 'user_card_content',
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      items.push(...((response.data?.items ?? []) as ApiMessageItem[]));
      if (!response.data?.has_more || !response.data.page_token) break;
      pageToken = response.data.page_token;
    }
    return items;
  }

  private async fetchBotMembers(chatId: string): Promise<Map<string, ExternalBotTarget>> {
    const now = this.now();
    const cached = this.botMembers.get(chatId);
    if (cached && cached.expiresAt > now) return cached.byOpenId;

    const byOpenId = new Map<string, ExternalBotTarget>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_MEMBER_PAGES; page += 1) {
      const response = await this.channel.rawClient.request<BotMemberResponse>({
        method: 'GET',
        url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/list`,
        params: {
          member_id_type: 'open_id',
          member_types: 'bot',
          page_size: 100,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      if (response.code && response.code !== 0) {
        throw new Error(response.msg || `bot member lookup failed (${response.code})`);
      }
      for (const item of response.data?.items ?? []) {
        if (!item.member_id || !item.app_id) continue;
        byOpenId.set(item.member_id, {
          openId: item.member_id,
          appId: item.app_id,
          ...(item.name ? { name: item.name } : {}),
        });
      }
      if (!response.data?.has_more || !response.data.page_token) break;
      pageToken = response.data.page_token;
    }
    this.botMembers.set(chatId, {
      expiresAt: now + BOT_MEMBER_CACHE_TTL_MS,
      byOpenId,
    });
    return byOpenId;
  }

  private async normalizeItem(
    watch: DelegationWatch,
    item: ApiMessageItem,
  ): Promise<NormalizedMessage | undefined> {
    const botIdentity = this.channel.botIdentity;
    const messageId = item.message_id;
    const senderAppId = item.sender?.id;
    if (!botIdentity || !messageId || !senderAppId) return undefined;
    const target = watch.targetsByAppId.get(senderAppId);
    const raw: RawMessageEvent = {
      sender: {
        sender_id: { open_id: senderAppId },
        sender_type: item.sender?.sender_type,
        tenant_key: item.sender?.tenant_key,
      },
      message: {
        message_id: messageId,
        ...(item.root_id ? { root_id: item.root_id } : {}),
        ...(item.parent_id ? { parent_id: item.parent_id } : {}),
        ...(item.thread_id ? { thread_id: item.thread_id } : {}),
        ...(item.create_time ? { create_time: item.create_time } : {}),
        ...(item.update_time ? { update_time: item.update_time } : {}),
        chat_id: watch.chatId,
        chat_type: 'group',
        message_type: item.msg_type ?? 'text',
        content: item.body?.content ?? '{}',
        mentions: (item.mentions ?? []).map((mention) => ({
          key: mention.key ?? '',
          id: mentionId(mention.id, mention.id_type),
          ...(mention.name ? { name: mention.name } : {}),
          ...(mention.tenant_key ? { tenant_key: mention.tenant_key } : {}),
        })),
      },
    };
    const normalized = await normalize(raw, {
      botIdentity,
      stripBotMentions: true,
      includeRaw: true,
      resolveSenderName: (id) => watch.targetsByAppId.get(id)?.name,
    });
    return {
      ...normalized,
      ...(target?.name ? { senderName: target.name } : {}),
      // The user explicitly authorized this wake-up when creating the watch.
      // Mark it targeted so strict mention mode does not discard the result.
      mentionedBot: true,
      mentions: normalized.mentions.map((mention) =>
        mention.openId && watch.targetOpenIds.has(mention.openId)
          ? { ...mention, isBot: true }
          : mention,
      ),
    };
  }
}

function senderTypeOf(msg: NormalizedMessage): string | undefined {
  return (msg.raw as { sender?: { sender_type?: string } } | undefined)?.sender?.sender_type;
}

function mentionId(
  id: string | undefined,
  idType: string | undefined,
): RawMessageEvent['sender']['sender_id'] {
  if (!id) return {};
  if (idType === 'user_id') return { user_id: id };
  if (idType === 'union_id') return { union_id: id };
  return { open_id: id };
}

function itemFingerprint(item: ApiMessageItem): string {
  return [
    item.update_time ?? item.create_time ?? '',
    item.msg_type ?? '',
    item.body?.content ?? '',
  ].join('\u0000');
}

function looksInProgress(item: ApiMessageItem): boolean {
  const content = item.body?.content ?? '';
  if (/(?:✅|☑)[^\n]{0,24}(?:已完成|完成)|\bcompleted\b/i.test(content)) return false;
  return /正在(?:思考|调用工具|输出|处理|生成|运行)|thinking\.{0,3}|calling tools?|working on|in progress/i.test(
    content,
  );
}

function compareMessages(a: ApiMessageItem, b: ApiMessageItem): number {
  const byTime = epochMs(a.create_time) - epochMs(b.create_time);
  if (byTime !== 0) return byTime;
  return Number(a.message_position ?? 0) - Number(b.message_position ?? 0);
}

function epochMs(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
}

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function reportWatchMetric(event: string): void {
  reportMetric('external_bot_watch', 1, { event });
}
