// "Something else" (#1291): the id scheme and what a draft may contain.
import { describe, expect, it } from 'vitest';
import { checkDraft, customIdFor, slugOf, validCustomAi } from './custom-ais';

describe('the custom: id scheme', () => {
  it('slugs the name', () => {
    expect(slugOf('My local Qwen')).toBe('my-local-qwen');
    expect(slugOf('  Gemini (work) ++ ')).toBe('gemini-work');
    expect(slugOf('☃☃☃')).toBe('ai');
    expect(slugOf('a'.repeat(80)).length).toBe(40);
  });

  it('is prefixed, and numbered on a collision', () => {
    const taken = new Set(['custom:qwen', 'custom:qwen-2']);
    expect(customIdFor('Qwen', (id) => taken.has(id))).toBe('custom:qwen-3');
    expect(customIdFor('Other', (id) => taken.has(id))).toBe('custom:other');
  });
});

describe('checkDraft', () => {
  it('takes a name, a command and arguments, trimmed, with blank arguments dropped', () => {
    expect(checkDraft({ name: ' My local Qwen ', command: ' opencode ', args: ['acp', ' ', '--model', 'ollama/qwen3-coder'] })).toEqual({
      ok: true,
      draft: { name: 'My local Qwen', command: 'opencode', args: ['acp', '--model', 'ollama/qwen3-coder'] },
    });
  });

  it('takes a program name or a FULL path; refuses a relative one (it would resolve inside the project)', () => {
    expect(checkDraft({ name: 'x', command: 'C:/Program Files/agent/agent.exe' }).ok).toBe(true);
    expect(checkDraft({ name: 'x', command: '/usr/local/bin/agent' }).ok).toBe(true);
    for (const rel of ['./agent', 'bin/agent', '.' + String.fromCharCode(92) + 'agent.exe']) {
      const r = checkDraft({ name: 'x', command: rel });
      expect(r.ok, rel).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/full path/);
    }
  });

  it('refuses parentheses in the command (cmd /c drops the quotes round such a path)', () => {
    expect(checkDraft({ name: 'x', command: 'C:/Program Files (x86)/agent/agent.exe' }).ok).toBe(false);
  });

  it('refuses an argument with a space in it, and says to split it', () => {
    const r = checkDraft({ name: 'x', command: 'x', args: ['--model ollama/qwen3'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/its own argument/);
  });

  it.each([
    [{ command: 'x' }, /name/],
    [{ name: 'x' }, /program/],
    [{ name: 'x', command: 'x', args: 'acp' }, /list/],
    [{ name: 'x', command: 'x', args: [1] }, /text/],
    [{ name: 'x', command: 'x', args: ['a&calc'] }, /may not contain/],
    [{ name: 'x', command: 'x', args: ['%PATH%'] }, /may not contain/],
    [{ name: 'x', command: 'x', args: ['a"b'] }, /may not contain/],
    [{ name: 'x', command: 'x|calc' }, /may not contain/],
    [{ name: 'x', command: 'x', env: { 'BAD NAME': 'v' } }, /environment variable/],
    [{ name: 'x', command: 'x', env: [] }, /name = value/],
  ])('refuses %j', (raw, why) => {
    const r = checkDraft(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(why);
  });

  it('refuses a control character anywhere', () => {
    const nl = String.fromCharCode(10);
    expect(checkDraft({ name: 'x', command: 'x', args: [`a${nl}b`] }).ok).toBe(false);
    expect(checkDraft({ name: `x${nl}y`, command: 'x' }).ok).toBe(false);
  });
});

describe('validCustomAi', () => {
  it('needs the custom: prefix and a usable draft', () => {
    const ok = { id: 'custom:x', name: 'x', command: 'x', args: [], addedAt: 5 };
    expect(validCustomAi(ok)).toEqual(ok);
    expect(validCustomAi({ ...ok, id: 'x' })).toBeNull();
    expect(validCustomAi({ ...ok, id: 'custom:' })).toBeNull();
    expect(validCustomAi({ ...ok, addedAt: 'yesterday' })).toEqual({ ...ok, addedAt: 0 });
  });
});
