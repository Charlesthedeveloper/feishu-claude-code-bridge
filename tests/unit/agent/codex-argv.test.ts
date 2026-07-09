import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../../../src/agent/codex/argv.js';

describe('Codex argv contract', () => {
  it('builds the fresh exec argv without putting the prompt in argv', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'read-only' })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '-',
    ]);
  });

  it('puts global flags before resume and resume-local flags after resume', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        threadId: 'thread-123',
      }),
    ).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      'resume',
      '--json',
      'thread-123',
      '-',
    ]);
  });

  it('allows danger-full-access for Claude bridge parity', () => {
    expect(buildCodexArgs({ cwd: '/repo', sandbox: 'danger-full-access' })).toContain(
      'danger-full-access',
    );
  });

  it('separates image flags from stdin prompt for fresh exec', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        images: ['/tmp/image.png'],
      }),
    ).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '--image',
      '/tmp/image.png',
      '--',
      '-',
    ]);
  });

  it('passes resume image flags after the resume subcommand', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        threadId: 'thread-123',
        images: ['/tmp/image.png'],
      }),
    ).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      'resume',
      '--json',
      '--image',
      '/tmp/image.png',
      'thread-123',
      '-',
    ]);
  });

  it('can explicitly ignore the user config when profile isolation asks for it', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'read-only',
        ignoreUserConfig: true,
      }),
    ).toContain('--ignore-user-config');
  });

  it('passes model and native Codex reasoning effort through global flags', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'read-only',
        model: 'gpt-5.5',
        effort: 'minimal',
      }),
    ).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--model',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="minimal"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/repo',
      '-',
    ]);
  });

  it('passes native Codex max effort through for GPT-5.6 models', () => {
    expect(
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'read-only',
        effort: 'max',
      }),
    ).toContain('model_reasoning_effort="max"');
  });

  it('rejects unsupported Codex reasoning efforts before spawning', () => {
    expect(() =>
      buildCodexArgs({
        cwd: '/repo',
        sandbox: 'read-only',
        effort: 'ultra',
      }),
    ).toThrow(/unsupported Codex reasoning effort/);
  });

});
