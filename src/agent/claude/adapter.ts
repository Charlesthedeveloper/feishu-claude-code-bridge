import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  type AgentAdapter,
  type AgentBotIdentity,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
} from '../types';
import { translateEvent } from './stream-json';

export interface ClaudeAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  /**
   * Default `--effort` when an individual run does not pass one.
   * Usually the bridge supplies this per run from profile/session config.
   */
  defaultEffort?: string;
}

type ClaudeChild = SpawnedProcessByStdio<null, Readable, Readable>;

const CLAUDE_CODE_BG_WAIT_ENV = 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS';

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';

  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly defaultEffort: string | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.larkChannel = opts.larkChannel;
    this.defaultEffort = opts.defaultEffort;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'claude',
      agentName: 'Claude Code',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for ClaudeAdapter.run');
    }

    const effort = opts.effort ?? this.defaultEffort;
    const claudeEffort = effort === 'ultracode' ? 'xhigh' : effort;
    const args = [
      '-p',
      opts.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      opts.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE,
      '--append-system-prompt',
      buildBridgeSystemPrompt(this.botIdentity),
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);
    if (claudeEffort) args.push('--effort', claudeEffort);
    if (effort === 'ultracode') args.push('--settings', JSON.stringify({ ultracode: true }));

    // Local desktop automation for the user's Feishu bridge. Print mode does
    // not load Codex/Claude desktop plugins, so declare the GUI MCP server
    // explicitly and allow only the known GUI tools.
    args.push(
      '--mcp-config',
      '/Users/charlesli/code/feishu-claude-code-bridge/bridge-mcp.json',
    );
    for (const tool of [
      'request_access',
      'screenshot',
      'zoom',
      'left_click',
      'double_click',
      'triple_click',
      'right_click',
      'middle_click',
      'type',
      'key',
      'scroll',
      'left_click_drag',
      'mouse_move',
      'open_application',
      'switch_display',
      'list_granted_applications',
      'read_clipboard',
      'write_clipboard',
      'wait',
      'cursor_position',
      'hold_key',
      'left_mouse_down',
      'left_mouse_up',
      'computer_batch',
    ]) {
      args.push('--allowed-tools', `mcp__gui__${tool}`);
    }

    const env = mergeProcessEnv(process.env, {
      // Claude Code's print mode can terminate still-running background
      // tasks after 600s. Bridge runs should wait for those tasks and let the
      // bridge idle watchdog decide whether to stop the process.
      [CLAUDE_CODE_BG_WAIT_ENV]: process.env[CLAUDE_CODE_BG_WAIT_ENV] ?? '0',
      ...buildLarkChannelEnv(this.larkChannel),
    });

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ClaudeChild;

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      effort,
    });

    // Listeners MUST be attached synchronously here, before we return.
    // The 'error' and exit-related events can fire in the next tick; if we
    // defer attachment to the async-generator body, those events fire into
    // the void and the generator hangs.
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line });
        if (isWindowsCommandNotFoundLine(line)) {
          runtimeError = new Error(`failed to spawn claude: ${line.trim()}`);
          child.stdout.destroy();
          child.kill();
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', { pid: child.pid ?? null, code, signal });
    });

    // Default 5s if caller didn't specify — claude often has live
    // subprocesses (lark-cli waiting for OAuth, long Bash, etc.) and the
    // old 500ms was nowhere near enough for them to flush state before the
    // SIGKILL cascade. Callers (channel.ts, /doctor) override per-run with
    // a value derived from preferences.
    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, Boolean(opts.sessionId)),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: ClaudeChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  resumedSession: boolean,
): AsyncGenerator<AgentEvent> {
  // If fork itself failed synchronously, child.pid is undefined. The 'error'
  // event (ENOENT etc.) fires in the next tick, so also check getError().
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn claude: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let sawStdout = false;
  let sawAgentWork = false;
  let deferredEmptyDone: AgentEvent | undefined;
  let silentExitTimer: ReturnType<typeof setTimeout> | undefined;
  const closeSilentStdout = (): void => {
    silentExitTimer = setTimeout(() => {
      if (!sawStdout && !child.stdout.readableEnded) child.stdout.destroy();
    }, 50);
  };
  child.once('exit', closeSilentStdout);
  try {
    for await (const line of rl) {
      sawStdout = true;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const translated = [...translateEvent(parsed)];
      if (resumedSession && !sawAgentWork && isZeroTokenSuccessfulResult(parsed)) {
        deferredEmptyDone = translated.find((event) => event.type === 'done');
        log.warn('agent', 'deferred-empty-result', {
          reason: 'resumed-session-may-have-pending-input',
        });
        continue;
      }
      for (const event of translated) {
        if (
          event.type === 'text' ||
          event.type === 'thinking' ||
          event.type === 'tool_use' ||
          event.type === 'tool_result'
        ) {
          sawAgentWork = true;
        }
        if (event.type === 'done' || event.type === 'error') deferredEmptyDone = undefined;
        yield event;
      }
    }
  } finally {
    if (silentExitTimer) clearTimeout(silentExitTimer);
    child.removeListener('exit', closeSilentStdout);
    rl.close();
  }

  const earlyRuntimeError = getError();
  if (earlyRuntimeError && child.exitCode === null && child.signalCode === null) {
    yield {
      type: 'error',
      message: `claude runtime error: ${earlyRuntimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }

  // When the child is killed by a signal, exitCode stays null and signalCode
  // carries the name. Both must be checked or we'll attach an 'exit' listener
  // for an event that already fired and hang forever.
  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `claude exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `claude runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
  } else if (deferredEmptyDone) {
    // A genuinely empty resumed run may exit after the zero-token result.
    // Preserve the normal terminal event once stdout has actually closed.
    yield deferredEmptyDone;
  }
}

function isZeroTokenSuccessfulResult(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const event = raw as {
    type?: unknown;
    is_error?: unknown;
    total_cost_usd?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
  if (event.type !== 'result' || event.is_error === true || !event.usage) return false;
  const values = [
    event.usage.input_tokens,
    event.usage.output_tokens,
    event.usage.cache_read_input_tokens,
    event.usage.cache_creation_input_tokens,
  ];
  return values.every((value) => value === undefined || value === 0) &&
    (event.total_cost_usd === undefined || event.total_cost_usd === 0);
}

function isWindowsCommandNotFoundLine(line: string): boolean {
  return (
    process.platform === 'win32' &&
    /is not recognized as an internal or external command|operable program or batch file/i.test(line)
  );
}
