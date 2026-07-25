import { describe, it, expect, vi } from 'vitest';
import { buildCommands, CommandDeps } from './command-set';
import { Command, CommandContext } from './commands';
import en from '../i18n/locales/en.json';

function deps(): CommandDeps & { focusCard: ReturnType<typeof vi.fn> } {
  return {
    focusCard: vi.fn(),
    newSession: vi.fn(),
    closeCard: vi.fn(),
    toggleCardView: vi.fn(),
    popOutCard: vi.fn(),
    toggleRail: vi.fn(),
    openPalette: vi.fn(),
  } as CommandDeps & { focusCard: ReturnType<typeof vi.fn> };
}

const ctxWith = (ids: string[], active: string | null = null): CommandContext => ({
  sessions: ids.map((id) => ({ id, title: id })),
  activeCardId: active,
});

const byId = (cmds: Command[], id: string): Command => cmds.find((c) => c.id === id)!;

describe('seed command set (E9-01)', () => {
  it('binds Ctrl+1..9 to the first nine sessions in rail order', () => {
    const d = deps();
    const cmds = buildCommands(d);
    const ctx = ctxWith(['a', 'b', 'c']);
    byId(cmds, 'session.jump.2').run(ctx);
    expect(d.focusCard).toHaveBeenCalledWith('b');
    expect(byId(cmds, 'session.jump.9').binding).toBe('Mod+9');
  });

  it('a jump past the end of the list is disabled, not a no-op crash', () => {
    const cmds = buildCommands(deps());
    const ctx = ctxWith(['a', 'b']);
    expect(byId(cmds, 'session.jump.2').enabled?.(ctx)).toBe(true);
    expect(byId(cmds, 'session.jump.3').enabled?.(ctx)).toBe(false);
    expect(byId(cmds, 'session.jump.3').disabledReasonKey).toBeTruthy();
  });

  it('next/previous wrap at both ends', () => {
    const d = deps();
    const cmds = buildCommands(d);
    byId(cmds, 'session.next').run(ctxWith(['a', 'b', 'c'], 'c'));
    expect(d.focusCard).toHaveBeenLastCalledWith('a');
    byId(cmds, 'session.prev').run(ctxWith(['a', 'b', 'c'], 'a'));
    expect(d.focusCard).toHaveBeenLastCalledWith('c');
  });

  it('next/previous with nothing focused enter the list from the matching end', () => {
    const d = deps();
    const cmds = buildCommands(d);
    byId(cmds, 'session.next').run(ctxWith(['a', 'b'], null));
    expect(d.focusCard).toHaveBeenLastCalledWith('a');
    byId(cmds, 'session.prev').run(ctxWith(['a', 'b'], null));
    expect(d.focusCard).toHaveBeenLastCalledWith('b');
  });

  it('card commands are disabled with no focused session', () => {
    const cmds = buildCommands(deps());
    const empty = ctxWith(['a'], null);
    for (const id of ['session.close', 'session.popOut', 'view.terminal']) {
      expect(byId(cmds, id).enabled?.(empty)).toBe(false);
    }
    expect(byId(cmds, 'session.close').enabled?.(ctxWith(['a'], 'a'))).toBe(true);
  });

  it('close routes through the card closer (which confirms) — never a bare close', () => {
    const d = deps();
    byId(buildCommands(d), 'session.close').run(ctxWith(['a'], 'a'));
    expect(d.closeCard).toHaveBeenCalledWith('a');
  });

  it('rail toggle and new session need no session at all', () => {
    const cmds = buildCommands(deps());
    expect(byId(cmds, 'view.rail').enabled).toBeUndefined();
    expect(byId(cmds, 'session.new').enabled).toBeUndefined();
  });

  it('the palette is the ONLY command allowed to fire while the user is typing', () => {
    // E9-02: Ctrl+Shift+P is the fail-open route to everything else and isn't a
    // text-editing key. Any OTHER typing-ok command is a bug — and no scope
    // whatsoever fires inside a terminal (proven in commands.test.ts).
    const typingOk = buildCommands(deps()).filter((c) => c.scope === 'typing-ok');
    expect(typingOk.map((c) => c.id)).toEqual(['palette.open']);
  });

  it('every i18n key a command carries resolves in en.json (the palette shows these)', () => {
    const lookup = (key: string): unknown =>
      key.split('.').reduce<unknown>((node, part) => {
        if (node && typeof node === 'object' && part in node) {
          return (node as Record<string, unknown>)[part];
        }
        return undefined;
      }, en);
    for (const c of buildCommands(deps())) {
      for (const key of [c.titleKey, c.categoryKey, c.disabledReasonKey]) {
        if (!key) continue;
        expect(typeof lookup(key), `missing i18n key: ${key} (command ${c.id})`).toBe('string');
      }
    }
  });

  it('no two commands share a binding', () => {
    const bound = buildCommands(deps())
      .map((c) => c.binding)
      .filter(Boolean);
    expect(new Set(bound).size).toBe(bound.length);
  });
});
