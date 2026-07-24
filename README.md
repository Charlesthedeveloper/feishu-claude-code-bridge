# lark-channel-bridge

A lightweight bot that bridges Feishu / Lark messenger with your local Claude Code or Codex CLI. Run one command, scan a QR code to bind a PersonalAgent app, and talk to your local coding agent from chat.

[中文 README](./README.zh.md)

For a product walkthrough, see the [Feishu document](https://larkcommunity.feishu.cn/docx/OaRIdFIRFoLM3xxTmKwcetHqn5e).

## What it does

- Forwards Feishu / Lark messages to local Claude Code or Codex CLI. Send a DM directly, or `@bot` in a group.
- **Streaming card**: text replies and tool calls update on one Lark card in real time; long or failed card streams fall back to chunked final markdown so the run still lands with a clear completion marker.
- **Session continuity**: each chat, topic, or document comment thread keeps its own session.
- **Queueing and batching**: messages sent in quick succession are handled together; messages sent during a run are queued for the next turn, while commands like `/new`, `/cd`, `/ws use`, and `/stop` can interrupt the current task.
- **Multiple workspaces**: use `/cd` to switch the current project, and `/ws` to save and reuse common project directories.
- **Images and files**: send them to the bot directly, and the bridge downloads them locally for the agent.
- **Delegated bot handoffs**: when you @ another bot in a group, the bridge stays quiet, watches that bot's result through chat history, then feeds the stable card/file/text result back into the same local agent session. Watches are one-shot and expire automatically to prevent bot loops.
- **Interactive cards**: `/help`, `/ws list`, and `/status` return cards with clickable buttons.
- **Local customizations in this branch**: agent-aware model/effort controls, `/compact`, GUI MCP tools for desktop automation, and PAC-friendly Feishu/Lark direct-connect handling.

## Prerequisites

- Node.js **>= 20.12.0**
- At least one local agent installed and logged in:
  - Claude Code: `claude`, see https://docs.anthropic.com/en/docs/claude-code/quickstart
  - Codex CLI: `codex`, see https://developers.openai.com/codex/cli
- A Feishu / Lark **PersonalAgent** app. The first-run QR wizard can create and bind one for you.

## Install

```bash
npm i -g lark-channel-bridge
# or
pnpm add -g lark-channel-bridge
```

## First run

```bash
lark-channel-bridge run
```

The first run opens a QR-code wizard:

1. A QR code renders in your terminal.
2. Scan it with the Feishu / Lark app.
3. Pick or create a PersonalAgent app.
4. If prompted, choose which agent to initialize.
5. Config is written to `~/.lark-channel/config.json`.

You do not need to choose a project directory up front. The bridge creates a profile-managed default working directory; after startup, send `/cd <path>` in Feishu / Lark to switch to a real project.

If you already have a PersonalAgent app, pass `--app-id` during initialization to skip app creation. The command prompts for the App Secret.

```bash
lark-channel-bridge run --app-id cli_xxx
# or initialize and start the background service directly
lark-channel-bridge start --app-id cli_xxx
```

For Lark global apps, add `--tenant lark`.

## Background service

Use `run` for first-run setup and foreground debugging. After the bot can send and receive messages, stop the foreground process with `Ctrl-C`, then use an OS-managed service for background operation:

```bash
lark-channel-bridge start
lark-channel-bridge status
lark-channel-bridge stop
```

Install globally before using service commands. The daemon's launchd plist / systemd unit / Windows task records the bridge CLI path; if that path comes from an npm temp cache through `npx`, the daemon can break when the cache is cleaned. `run` is fine through `npx` as a one-shot foreground process.

Service commands install a per-profile service:

```bash
lark-channel-bridge start [--profile <name>]
lark-channel-bridge stop [--profile <name>]
lark-channel-bridge restart [--profile <name>]
lark-channel-bridge status [--profile <name>]
lark-channel-bridge unregister [--profile <name>]
```

Platform mapping:
- **macOS**: launchd user agent `ai.lark-channel-bridge.bot.<profile>`
- **Linux**: systemd user unit `lark-channel-bridge.bot.<profile>.service`
- **Windows**: Task Scheduler task `LarkChannelBridge.Bot.<profile>`, launched through a `.cmd` wrapper

Daemon logs are under `~/.lark-channel/profiles/<profile>/logs/daemon/`.

### Multiple profiles: Claude and Codex

By default, the bridge starts with the currently selected profile. Use `profile use <name>` to change it. Each profile keeps its own app credentials, sessions, working directories, and logs. Create multiple profiles only when you need to connect multiple PersonalAgent apps, or run Claude and Codex as separate bots:

```bash
lark-channel-bridge start --profile claude --agent claude
lark-channel-bridge start --profile codex --agent codex
```

For example, to restart only the Codex bot:

```bash
lark-channel-bridge restart --profile codex
lark-channel-bridge status --profile codex
```

## Commands

### Host CLI

```text
lark-channel-bridge run [--profile <name>] [--agent claude|codex] [--workspace <path>] [-c <config>]
lark-channel-bridge migrate [--profile <name>] [--agent claude|codex]
lark-channel-bridge ps
lark-channel-bridge kill <id|#>
lark-channel-bridge --help
```

`profile use <name>` changes the profile used by later default starts. Use these profile management commands when running separate Claude / Codex bots, connecting multiple PersonalAgent apps, or doing scripted deployment:

```bash
lark-channel-bridge profile create claude --agent claude
lark-channel-bridge profile create codex --agent codex
lark-channel-bridge profile list
lark-channel-bridge profile use <name>
lark-channel-bridge profile remove <name>
lark-channel-bridge profile remove <name> --purge --yes
lark-channel-bridge profile export <name> [--output ./profile.json] [--force]
lark-channel-bridge profile export <name> --include-secrets --yes
```

`profile remove` archives local state by default, including the active profile. If other profiles remain, the bridge switches to the next one; if it was the last profile, the root config is cleared so the same name can be created again. `--purge --yes` permanently deletes local state. `profile export` redacts app secrets by default; `--include-secrets --yes` includes sensitive config.

If a profile was created with the wrong agent kind, stop or unregister any matching background service first, then run `profile remove <name>` and recreate it with the intended `--agent`.

### Slash commands inside Feishu / Lark

| Command | Effect |
|---|---|
| `/new [effort]`, `/reset [effort]` | Clear the current session; `/new low` starts fresh with low reasoning |
| `/compact` | Compact the current session/thread without starting a new chat; Claude also accepts optional instructions |
| `/cd <path>` | Switch working directory and reset the session |
| `/ws list` | List named workspaces |
| `/ws save <name>` | Save the current working directory as a named workspace |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Delete a named workspace |
| `/resume`, `/resume use <session-id>` | Resume compatible history for the same agent, working directory, and permission mode; Claude session ids from `claude --resume ...` can be bound directly when they exist under the current cwd |
| `/status` | Show profile, agent, working directory, session, lark-cli identity, and run state |
| `/config` | Adjust presentation preferences, access settings, and lark-cli identity policy |
| `/effort [level\|auto\|default]` | Set or clear the current session's reasoning effort override. Claude supports `low|medium|high|xhigh|max` plus session-only `ultracode`; Codex supports `none|minimal|low|medium|high|xhigh|max` (`max` requires a compatible model such as GPT-5.6) |
| `/model [default\|<model-id>]` | Set or clear the current session's model override. Claude supports aliases such as `best`, `opus`, `opus5`, `sonnet`, `sonnet5`, `haiku`, `fable`, and `fable5` plus full IDs; Codex supports full IDs plus `sol`, `terra`, and `luna` GPT-5.6 shortcuts |
| `/invite user @name` | Allow a user to use the bot in DMs |
| `/invite admin @name` | Add an access-control admin |
| `/invite group` | Allow the current group to use the bot |
| `/invite all group` | Allow all groups the bot has joined |
| `/remove user @name`, `/remove admin @name`, `/remove group` | Remove access entries |
| `/stop` | Stop the current run, including the card stop button |
| `/timeout [N\|off\|default]` | Set or clear the current session idle watchdog |
| `/ps` | List local bridge processes |
| `/exit <id\|#>` | Stop a bridge process |
| `/reconnect` | Force a WebSocket reconnect |
| `/doctor [description]` | Run low-sensitive diagnostics |
| `/help` | Help card |

DMs do not require an @ mention. Groups and topic groups require `@bot` by default; `@all` is ignored. Cloud-doc comments in supported document types run when the bot is mentioned.

### Local agent controls

This fork keeps upstream 0.2.2's profile/Codex architecture and adds a few local controls that are useful for a personal Feishu bridge:

- `/effort low|medium|high|xhigh|max|ultracode|auto`: in a Claude profile, changes the current chat/topic's Claude Code effort for future runs. `max` is Claude Code's deepest session-only reasoning setting. `ultracode` is sent as `--effort xhigh` plus Claude Code session settings for dynamic workflows, and is also session-only. `/effort auto` or `/effort default` removes the override and falls back to `/config` / the model default.
- `/effort none|minimal|low|medium|high|xhigh|max`: in a Codex profile, changes the current chat/topic's Codex `model_reasoning_effort` for future runs. GPT-5.6 supports native `max`; older models may reject that level, so use `xhigh` when model compatibility is uncertain.
- `/model best|opus|opus5|sonnet|sonnet5|haiku|fable|fable5|default|<model-id>`: in a Claude profile, changes only the current chat/topic's Claude Code `--model` override. The bridge preserves Claude Code's native aliases (`best`, `opus`, `sonnet`, `haiku`, `fable`) and maps explicit shortcuts such as `opus5` to `claude-opus-5`, `sonnet5` to `claude-sonnet-5`, and `fable5` to `claude-fable-5`. Opus 5, Sonnet 5, and Fable 5 all have native 1M context. Use a full model ID or the numbered shortcut to pin a generation; the unnumbered aliases follow Claude Code's latest model. `default` removes the current session override so it falls back to `/config`.
- `/model default|<model-id>`: in a Codex profile, changes only the current chat/topic's Codex `--model` override. GPT-5.6 shortcuts are supported: `/model gpt-5.6` and `/model sol` both resolve to the full `gpt-5.6-sol` id; `/model terra` and `/model luna` resolve to `gpt-5.6-terra` and `gpt-5.6-luna`. The bridge intentionally canonicalizes the documented `gpt-5.6` alias because the ChatGPT-subscription Codex backend currently accepts the full Sol id while rejecting that alias.
- `/model global <model-id|default>`: explicitly changes the profile-wide default model used by chats without a session override. Use this sparingly; for most per-topic work, prefer plain `/model <id>`.
- `/new low`: clears the current session and immediately pins the new session to low effort. This does **not** create a new Feishu group; `/new chat [name]` is still the group-creation command.
- `/compact [instructions]`: compacts the current resumable session/thread. Claude Code receives the native slash command and optional instructions. Codex must use bare `/compact`; the bridge calls `thread/compact/start` and reports success only after Codex emits a real compaction-completed event.
- GUI MCP: Claude runs include `bridge-mcp.json` and the `mcp__gui__*` allowlist so the agent can control local desktop GUI when macOS screen/session state allows it.
- External-bot delegation: a real @mention of another bot starts a six-hour one-shot watcher. Because Feishu does not push unmentioned bot-authored messages to this bot's WebSocket, the watcher polls only that chat and only for the mentioned bot. It waits for card updates to settle, batches the original request with the result and attachments, resumes the current session, then stops before the bots can loop.
- PAC/proxy split: macOS launchd does not inherit your terminal proxy settings. `start` and `restart` capture the current shell's `http_proxy` / `https_proxy` / `all_proxy` and `NO_PROXY` / `no_proxy` into the LaunchAgent plist for Claude/Codex child processes. The Feishu/Lark channel itself explicitly ignores those proxy variables and connects directly; this avoids persistent-WebSocket ping timeouts on proxy stacks that do not reliably honor `NO_PROXY`. After changing PAC/global/proxy settings, run `./bin/lark-channel-bridge.mjs restart --profile <name>` from a shell that has the desired agent proxy env.

The local Claude profile defaults to `claude-opus-5` at `high` effort. Anthropic positions Opus 5 as the starting model for complex agentic coding and enterprise work, while Fable 5 remains the highest-capability tier. For quick personal chats like fitness logs or naming brainstorms, use `low` or `medium`; start coding and agentic work at `xhigh`; reserve `max` or `ultracode` for the hardest long-horizon work where unconstrained token spend is justified. Existing per-chat model and effort overrides continue to take precedence over the profile default.

## lark-cli identity policy

Each profile uses a profile-local lark-cli directory at `~/.lark-channel/profiles/<profile>/lark-cli`. The agent process receives `LARKSUITE_CLI_CONFIG_DIR` for that directory, so personal authorization in one profile is not shared with another profile.

The default policy is `bot-only`: lark-cli uses the app/bot identity and does not access personal resources. When a user authorizes personal resources such as calendar, mail, or drive, the current profile can switch to `user-default`, which keeps app identity available and also allows the authorized user identity. Owner/admin users can inspect or change this policy in `/config`; `/status` shows the current summary as `lark-cli: app` or `lark-cli: user-ready`.

## Working directories

Each profile may define a default working directory through `workspaces.default`. New profiles may be created with `--workspace <path>`; if omitted, the bridge creates a profile-managed default working directory.

This is a profile-field snippet. Do not replace the whole `config.json` with it; edit the matching profile's `workspaces` field.

```json
{
  "workspaces": {
    "default": "/Users/me/.lark-channel-workspaces/claude/default"
  }
}
```

The bridge checks that a selected directory exists, is a directory, and is not an overly broad location such as `/`, the home root, a system directory, or a temp root. The working directory is only the current directory for an agent run. It is not a filesystem sandbox; actual file access still depends on the local agent process and its permission mode.

## Permission modes

The recommended user-facing profile config is `permissions.defaultAccess` and `permissions.maxAccess`. New profiles default to `full` for both values so the bridge can keep local tools, authorization flows, file writes, and other agent features fully usable. To tighten a profile, set one or both values to `workspace` or `read-only`; stricter modes can limit local tool execution, login/authorization flows, file writes, and similar capabilities.

This is a profile-field snippet. Do not replace the whole `config.json` with it; edit the matching profile's `permissions` field.

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

Mode mapping:

| Bridge access | Claude permission mode | Codex mode |
|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` |
| `workspace` | `acceptEdits` | `workspace-write` |
| `read-only` | `plan` | `read-only` |

The legacy `sandbox` field is still readable for old configs. After the bridge saves the profile, it migrates that setting to canonical `permissions`.

## Data directories

| Path | Content |
|---|---|
| `~/.lark-channel/config.json` | Root config with profiles and active profile |
| `~/.lark-channel/active-profile` | Last selected profile |
| `~/.lark-channel/profiles/<profile>/sessions.json` | Session state |
| `~/.lark-channel/profiles/<profile>/sessions.json.catalog.json` | Agent-aware session catalog |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | Current and named workspace bindings |
| `~/.lark-channel/profiles/<profile>/secrets.enc` | Profile-local encrypted secrets |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | Profile-local lark-cli directory |
| `~/.lark-channel/profiles/<profile>/media/` | Attachment cache |
| `~/.lark-channel/profiles/<profile>/logs/` | Structured run logs |
| `~/.lark-channel/registry/processes.json` | Local process registry |
| `~/.lark-channel/registry/locks/` | Profile and app locks |

Set `LARK_CHANNEL_HOME=/path/to/state` to move all local bridge state. `LARK_CHANNEL_LOG_DAYS` overrides log retention.

## Access control

**Chat access is private by default: out of the box, only *you* can use the bot in DMs and groups.** "You" = whoever created / owns the Feishu app (the person who scanned the QR to set it up). The bot figures out who the app owner is automatically from Feishu, so **solo chat use needs zero configuration** — you can DM it and `@`-mention it in any group, and everyone else's chat messages are silently ignored (no "permission denied" reply, which would only confirm the bot exists). Cloud-doc comments are document-scoped; see below.

To let other people or groups in, add them to one of three lists:

| List | Controls | Add | Remove |
|------|----------|-----|--------|
| **Allowed users** | who can DM the bot | `/invite user @them` | `/remove user @them` |
| **Allowed chats** | which groups the bot answers in (for **everyone** in them) | `/invite group` (current group) / `/invite all group` (every group the bot is in) | `/remove group` (current group) |
| **Admins** | who can change settings, and use the bot in any group | `/invite admin @them` | `/remove admin @them` |

> `/invite` and `/remove` can only be run by **you (the creator) and admins**. The `@` in the command points at the *target person* (not the bot) — the bot resolves the mention to their identity, so you never deal with raw IDs.

### Two identities that bypass everything

- **You (the creator)**: subject to no list at all — DMs, any group, every command. You **can never lock yourself out**: even if the lists get messed up, DM the bot and send `/config` to get back in. Transfer the app's ownership in the Feishu console and the bot follows the new owner automatically.
- **Admins**: can DM, run management commands like `/config`, and **bypass the allowed-chats list** — the bot answers them in any group, listed or not. Good for teammates who co-maintain the bot.

### Common setups

- **Just me** → nothing to do; this is the default.
- **Let a teammate DM the bot** → `/invite user @them`
- **Open a work group to everyone in it** → send `/invite group` inside that group
- **First-time setup, onboard every group the bot is already in** → `/invite all group` pulls them all into the list at once; trim with `/remove group` afterwards
- **Add a co-admin** → `/invite admin @them`

### Worth knowing

- Changes take effect on the **next message** — no restart needed.
- **In groups you must `@` the bot first** (DMs don't need it). That's a separate toggle (`/config` → "require @ in groups"), independent of the lists above.
- Strangers get pure silence — no reply at all. The one exception: if someone `@`-mentions the bot in a group that hasn't been opened up, the bot posts a friendly one-liner telling them an admin can run `/invite group` to enable it.
- Cloud-doc comments are document-scoped: anyone who can comment in a supported document and mention the bot can trigger a reply.

### Advanced: editing the config file directly

If you'd rather not do it inside Feishu, `/invite` and `/config` write the matching profile's `access` field in `~/.lark-channel/config.json`. Empty lists mean nobody from that list, not open access. This is a profile-field snippet; do not replace the whole `config.json` with it:

```json
{
  "schemaVersion": 2,
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "access": {
        "allowedUsers": ["ou_xxxxxxxxxxxxx"],
        "allowedChats": ["oc_xxxxxxxxxxxxx"],
        "admins": ["ou_xxxxxxxxxxxxx"],
        "requireMentionInGroup": true
      }
    }
  }
}
```

`allowedUsers` / `admins` take user `open_id`s; `allowedChats` takes group `chat_id`s. The easiest way to find an ID by hand: have the person message the bot (or `@` it in the group), then check the active profile's log:

```bash
grep '"event":"enter"' ~/.lark-channel/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

Each line carries `chatId` (group / DM id) and `senderId` (user `open_id`). After a manual edit, **restart the bridge** or send `/reconnect` from an allowed admin context to apply it. For day-to-day tweaks `/invite` / `/config` are easier; direct edits are mainly for deployment scripts that pre-seed access.

## Cloud-doc comments

Cloud-doc comments do not need a separate workspace binding or document allowlist. In supported document comments, mention the bot and the bridge replies in the same thread. Comment runs reuse the document session key and fall back to the user home directory when no document cwd was previously recorded.

## FAQ

**The bot stays silent or the local CLI never replies.** Usually the local `claude` or `codex` CLI is not logged in, the current session points to a working directory that no longer exists, or the resumed session has grown unstable. Send `/status` to inspect; try `/compact` first if you want to keep context, and `/new` when you want a clean session.

**The agent subprocess looks frozen (card stuck on the last frame).** The bridge now treats the interactive card as a live preview, not the only delivery path. If a card update fails or the final answer is long, the agent keeps running and the bridge posts a `完整输出` markdown transcript afterward; the SDK splits that markdown into multiple messages when needed, and terminal states include a visible `✅ 已完成` / error / timeout marker. Separately, the bridge supports an idle watchdog: if the agent emits nothing for N minutes, the process is killed and the card is annotated with the auto-termination reason. Disabled by default. Enable with `/config` globally, or `/timeout 10` for the current session; `/timeout off` disables it for the session; `/timeout default` clears the session override.

**The agent says it cannot see an image I sent.** Upgrade to the latest version. Releases before 0.1.0 had a filename-dedup bug.

**I @mentioned another bot, but Claude/Codex did not see its result.** The bridge now creates an on-demand handoff watcher when the original @mention is a real structured mention and both bots are members of the same group. Plain text such as `@AlphaPai` is not a real mention and cannot start a watch. The watch expires after six hours and stops after forwarding the first stable result batch.

## Testing and CI

Local checks:

```bash
pnpm test
pnpm typecheck
pnpm build
```

`pnpm test` includes unit, integration, and process-level adapter tests. CI runs on macOS, Ubuntu, and Windows with `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.

This local branch also keeps targeted coverage for the customizations:

- `tests/integration/commands/local-customizations.test.ts`
- `tests/unit/session/session-store-effort.test.ts`
- `tests/process/claude-adapter.test.ts`
- `tests/process/codex-adapter.test.ts`
- `tests/unit/agent/codex-argv.test.ts`

## Optional telemetry

By default the bridge reports **nothing**: no metrics, no logs leave your machine, and it pulls in zero telemetry dependencies. The hook below is inert unless you opt in.

To wire up your own monitoring, point an environment variable at a module that default-exports (or exports `createAdapter`) an `AdapterFactory`:

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package lark-channel-bridge start
```

That module receives every `log.*` event plus error/metric hooks and forwards them wherever you like. The interface is exported from the package root:

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from 'lark-channel-bridge';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* ship event */},
  recordError(err, ctx) {/* ship exception */},
  recordMetric(name, value, tags) {/* ship metric */},
  flush(timeoutMs) {/* drain buffered events */},
});
export default createAdapter;
```

A missing module, a bad factory, or a throwing adapter all degrade to noop — telemetry can never stop the bridge from starting or break logging.

## License

[MIT](./LICENSE)

<img src="./assets/feedback-group-qr.png" alt="Feedback group QR code" width="360">
