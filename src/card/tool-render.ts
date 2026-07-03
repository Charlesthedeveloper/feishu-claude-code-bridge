import type { ToolEntry } from './run-state';

const HEADER_SUMMARY_MAX = 80;
const BODY_FIELD_MAX = 600;
const OUTPUT_MAX = 1200;
/**
 * Cumulative cap on a tool's full body markdown (input + output + code fences
 * + headers). Even with per-field caps, pathological tools (many input
 * fields + maxed-out output) can stack to multi-KB bodies which, multiplied
 * across panels, push the card past Feishu's per-element size limit. This
 * is the last belt across the whole rendered body string.
 */
const BODY_TOTAL_MAX = 2500;
const WORKSPACE_PREFIX = '/Library/Mobile Documents/iCloud~md~obsidian/Documents/Workspace/';

export function toolHeaderText(tool: ToolEntry): string {
  const icon = tool.status === 'done' ? '✅' : tool.status === 'error' ? '❌' : '⏳';
  const summary = summarizeInput(tool.name, tool.input);
  return summary ? `${icon} **${tool.name}** — ${summary}` : `${icon} **${tool.name}**`;
}

export function toolBodyMd(tool: ToolEntry): string {
  const parts: string[] = [];
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);

  if (tool.output) {
    const truncated = truncate(tool.output, OUTPUT_MAX);
    if (tool.status === 'error') {
      parts.push(`**Error**\n\`\`\`\n${truncated}\n\`\`\``);
    } else if (tool.name === 'Bash') {
      parts.push(renderBashOutput(truncated));
    } else {
      parts.push(`**Output**\n\`\`\`\n${truncated}\n\`\`\``);
    }
  } else if (tool.status === 'running') {
    parts.push('_运行中…_');
  }

  const body = parts.join('\n\n');
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}…\n\n_（body 已截断,完整内容查 \`/doctor\` 或日志）_`;
}

function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const str = (key: string): string => {
    const v = rec[key];
    if (typeof v !== 'string') return '';
    return v;
  };
  const pick = (key: string, max = HEADER_SUMMARY_MAX): string => {
    return truncateOneLine(str(key), max);
  };
  switch (name) {
    case 'Bash':
      return summarizeCommand(str('command'));
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return shortenPath(str('file_path'));
    case 'Grep': {
      const pat = pick('pattern', 40);
      const path = shortenPath(str('path'), 40);
      return path ? `${pat} in ${path}` : pat;
    }
    case 'Glob':
      return pick('pattern');
    case 'WebFetch':
      return pick('url');
    case 'WebSearch':
      return pick('query', 60);
    case 'Agent':
    case 'Task':
      return pick('description') || pick('subagent_type');
    default:
      return summarizeCommand(str('command')) || shortenPath(str('file_path')) || shortenPath(str('path')) || pick('query');
  }
}

function renderInput(tool: ToolEntry): string {
  const input = tool.input;
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const str = (k: string): string => (typeof rec[k] === 'string' ? rec[k] as string : '');

  switch (tool.name) {
    case 'Bash': {
      const cmd = str('command');
      return cmd ? `**Command**\n\`\`\`bash\n${truncate(cmd, BODY_FIELD_MAX)}\n\`\`\`` : '';
    }
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const fp = str('file_path');
      return fp ? `**File** \`${fp}\`` : '';
    }
    case 'Grep': {
      const lines: string[] = [];
      if (str('pattern')) lines.push(`**Pattern** \`${str('pattern')}\``);
      if (str('path')) lines.push(`**Path** \`${str('path')}\``);
      return lines.join('\n');
    }
    case 'WebFetch':
      return str('url') ? `**URL** ${str('url')}` : '';
    case 'WebSearch':
      return str('query') ? `**Query** \`${truncate(str('query'), BODY_FIELD_MAX)}\`` : '';
    default:
      return '';
  }
}

function renderBashOutput(out: string): string {
  // Some agents wrap stdout/stderr in xml-like tags; keep simple and just dump.
  return `**Output**\n\`\`\`\n${out}\n\`\`\``;
}

function shortenPath(p: string, max = HEADER_SUMMARY_MAX): string {
  return compactPath(p, max);
}

function summarizeCommand(command: string): string {
  if (!command) return '';
  const compacted = compactPathsInCommand(command.replace(/\s+/g, ' ').trim());
  return middleTruncate(compacted, HEADER_SUMMARY_MAX);
}

function compactPathsInCommand(command: string): string {
  const quoted = command.replace(/(["'])(\/Users\/[^"']+)\1/g, (_match, quote: string, path: string) => {
    return `${quote}${compactPath(path, 52)}${quote}`;
  });
  return quoted.replace(/\/Users\/[^\s"'`]+/g, (path) => compactPath(path, 52));
}

function compactPath(raw: string, max: number): string {
  if (!raw) return '';
  let p = raw.trim();
  const workspaceAt = p.indexOf(WORKSPACE_PREFIX);
  if (workspaceAt >= 0) {
    const suffix = p.slice(workspaceAt + WORKSPACE_PREFIX.length);
    p = suffix ? `Workspace/${suffix}` : 'Workspace';
  } else {
    p = p.replace(/^\/Users\/[^/]+\//, '~/');
  }

  if (p.length <= max) return p;
  return pathMiddleTruncate(p, max);
}

function pathMiddleTruncate(path: string, max: number): string {
  if (path.length <= max) return path;
  const segments = path.split('/').filter(Boolean);
  if (segments.length < 3) return middleTruncate(path, max);

  const prefix = path.startsWith('~/') ? '~' : (segments[0] ?? '');
  if (!prefix) return middleTruncate(path, max);
  const tail: string[] = [];
  for (let i = segments.length - 1; i > 0; i -= 1) {
    const segment = segments[i];
    if (!segment) continue;
    tail.unshift(segment);
    const candidate = `${prefix}/…/${tail.join('/')}`;
    if (candidate.length > max) {
      tail.shift();
      break;
    }
  }
  const candidate = `${prefix}/…/${tail.join('/')}`;
  if (tail.length > 0 && candidate.length <= max) return candidate;
  return middleTruncate(path, max);
}

function truncateOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return middleTruncate(oneLine, max);
}

function middleTruncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  const left = Math.ceil((max - 1) / 2);
  const right = Math.floor((max - 1) / 2);
  return `${s.slice(0, left)}…${s.slice(-right)}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
