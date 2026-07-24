import { describe, expect, it } from 'vitest';
import {
  normalizeAgentEffortForAgent,
  normalizeAgentModelForAgent,
} from '../../../src/config/schema.js';

describe('agent-specific settings', () => {
  it('keeps native Codex max effort for GPT-5.6-capable models', () => {
    expect(normalizeAgentEffortForAgent('max', 'codex')).toBe('max');
  });

  it.each([
    ['5.6', 'gpt-5.6-sol'],
    ['gpt-5.6', 'gpt-5.6-sol'],
    ['gpt5.6', 'gpt-5.6-sol'],
    ['sol', 'gpt-5.6-sol'],
    ['terra', 'gpt-5.6-terra'],
    ['luna', 'gpt-5.6-luna'],
    ['GPT 5.6 Terra', 'gpt-5.6-terra'],
  ])('maps the Codex model shortcut %s to %s', (raw, expected) => {
    expect(normalizeAgentModelForAgent(raw, 'codex')).toBe(expected);
  });

  it('preserves unknown Codex model ids', () => {
    expect(normalizeAgentModelForAgent('my-private-model', 'codex')).toBe('my-private-model');
  });

  it('does not apply Codex shortcuts to Claude profiles', () => {
    expect(normalizeAgentModelForAgent('terra', 'claude')).toBe('terra');
  });

  it.each([
    ['opus5', 'claude-opus-5'],
    ['opus-5', 'claude-opus-5'],
    ['Claude Opus 5', 'claude-opus-5'],
    ['opus-5-1m', 'claude-opus-5'],
    ['opus48', 'claude-opus-4-8'],
    ['opus481m', 'claude-opus-4-8[1m]'],
  ])('maps the Claude model shortcut %s to %s', (raw, expected) => {
    expect(normalizeAgentModelForAgent(raw, 'claude')).toBe(expected);
  });
});
