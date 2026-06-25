import type { SandboxMode } from '../../config/profile-schema';

export interface BuildCodexArgsInput {
  cwd: string;
  sandbox: SandboxMode;
  threadId?: string;
  model?: string;
  effort?: string;
  images?: readonly string[];
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
}

const CODEX_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export function buildCodexArgs(input: BuildCodexArgsInput): string[] {
  if (
    input.sandbox !== 'read-only' &&
    input.sandbox !== 'workspace-write' &&
    input.sandbox !== 'danger-full-access'
  ) {
    throw new Error(`unsafe sandbox mode: ${input.sandbox}`);
  }

  const model = input.model?.trim();
  const effort = normalizeCodexReasoningEffort(input.effort);
  const globalFlags = [
    '--sandbox',
    input.sandbox,
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
    ...(input.ignoreUserConfig === true ? ['--ignore-user-config'] : []),
    ...(input.ignoreRules === false ? [] : ['--ignore-rules']),
    '--skip-git-repo-check',
    '-C',
    input.cwd,
  ];

  const imageFlags = (input.images ?? []).flatMap((path) => ['--image', path]);

  if (input.threadId) {
    return [
      'exec',
      ...globalFlags,
      'resume',
      '--json',
      ...imageFlags,
      input.threadId,
      '-',
    ];
  }

  return [
    'exec',
    '--json',
    ...globalFlags,
    ...imageFlags,
    ...(imageFlags.length > 0 ? ['--'] : []),
    '-',
  ];
}

function normalizeCodexReasoningEffort(effort: string | undefined): string | undefined {
  const normalized = effort?.trim().toLowerCase();
  if (!normalized) return undefined;
  const mapped = normalized === 'max' ? 'xhigh' : normalized;
  if (!CODEX_REASONING_EFFORTS.has(mapped)) {
    throw new Error(`unsupported Codex reasoning effort: ${effort}`);
  }
  return mapped;
}
