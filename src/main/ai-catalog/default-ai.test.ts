// The default AI (#1291): chosen when registered, else the first registered.
import { describe, expect, it, vi } from 'vitest';
import { defaultAiResolver, resolveDefaultAi } from './default-ai';

describe('resolveDefaultAi', () => {
  it('never chosen: the first registered (Claude in production)', () => {
    expect(resolveDefaultAi(undefined, ['claude-code', 'custom:x'])).toEqual({ id: 'claude-code', fellBack: false });
  });

  it('never chosen keeps the e2e order: the fake ACP agent registered first is the default', () => {
    expect(resolveDefaultAi(undefined, ['fake-acp', 'claude-code']).id).toBe('fake-acp');
  });

  it('chosen and registered: the choice', () => {
    expect(resolveDefaultAi('custom:x', ['claude-code', 'custom:x'])).toEqual({ id: 'custom:x', chosen: 'custom:x', fellBack: false });
  });

  it('chosen but not registered: falls back, and says so', () => {
    expect(resolveDefaultAi('codex', ['claude-code'])).toEqual({ id: 'claude-code', chosen: 'codex', fellBack: true });
  });

  it('nothing registered is a bootstrap bug, said loudly', () => {
    expect(() => resolveDefaultAi(undefined, [])).toThrow(/bootstrap did not run/);
  });
});

describe('defaultAiResolver', () => {
  it('logs a fallback once per distinct choice, not on every read', () => {
    const warn = vi.fn();
    let chosen: string | undefined = 'codex';
    let registered = ['claude-code'];
    const r = defaultAiResolver(() => chosen, () => registered, warn);
    r();
    r();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not available/), { chosen: 'codex', using: 'claude-code' });
    chosen = 'custom:gone';
    r();
    expect(warn).toHaveBeenCalledTimes(2);
    registered = ['claude-code', 'custom:gone'];
    expect(r()).toEqual({ id: 'custom:gone', chosen: 'custom:gone', fellBack: false });
  });
});
