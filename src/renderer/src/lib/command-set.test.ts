import { describe, it, expect, vi } from 'vitest';
import { buildCommands, CommandDeps } from './command-set';
import { Command, CommandContext } from './commands';
import { TERMINAL_ACCELERATORS } from '../../../shared/terminal-accelerators';
import en from '../i18n/locales/en.json';
import { POLICY_ORDER } from './presentation-policy';
import { LAYOUT_MODES } from './layout-mode';

function deps(): CommandDeps & { focusCard: ReturnType<typeof vi.fn> } {
  return {
    focusCard: vi.fn(),
    newSession: vi.fn(),
    closeCard: vi.fn(),
    toggleCardView: vi.fn(),
    popOutCard: vi.fn(),
    hideCard: vi.fn(),
    setLadder: vi.fn(),
    stepLadder: vi.fn(),
    setGlobalPolicy: vi.fn(),
    setSessionPolicy: vi.fn(),
    setGroupPolicy: vi.fn(),
    setGlobalFocusPolicy: vi.fn(),
    setSessionFocusPolicy: vi.fn(),
    setLayoutMode: vi.fn(),
    cycleLayoutMode: vi.fn(),
    toggleMaximize: vi.fn(),
    toggleRail: vi.fn(),
    openPalette: vi.fn(),
    toggleTabRows: vi.fn(),
    jumpToNextAttention: vi.fn(),
    openAbout: vi.fn(),
  } as CommandDeps & {
    focusCard: ReturnType<typeof vi.fn>;
    jumpToNextAttention: ReturnType<typeof vi.fn>;
    openAbout: ReturnType<typeof vi.fn>;
  };
}

const ctxWith = (
  ids: string[],
  active: string | null = null,
  attentionCount = 0,
  activeGroupId: string | null = null,
): CommandContext => ({
  sessions: ids.map((id) => ({ id, title: id })),
  activeCardId: active,
  activeGroupId,
  attentionCount,
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

  // ── §5.8's presentation ladder (E9-05) ──────────────────────────────────

  it('the two ladder bindings step the ACTIVE card, one rung per press', () => {
    const d = deps();
    const cmds = buildCommands(d);
    expect(byId(cmds, 'session.ladder.down').binding).toBe('Mod+Shift+ArrowDown');
    expect(byId(cmds, 'session.ladder.up').binding).toBe('Mod+Shift+ArrowUp');
    byId(cmds, 'session.ladder.down').run(ctxWith(['a'], 'a'));
    expect(d.stepLadder).toHaveBeenCalledWith('a', 'down');
    byId(cmds, 'session.ladder.up').run(ctxWith(['a'], 'a'));
    expect(d.stepLadder).toHaveBeenCalledWith('a', 'up');
  });

  it('each rung has its own palette entry, naming that rung', () => {
    // the invariant this item is written against: hiding chrome never removes
    // capability, so every rung is reachable by name and not only by counting
    // keystrokes
    const rungs: Array<[string, string]> = [
      ['session.expand', 'expanded'],
      ['session.collapse', 'collapsed'],
      ['session.tabbed', 'tabbed'],
    ];
    for (const [id, rung] of rungs) {
      const d = deps();
      byId(buildCommands(d), id).run(ctxWith(['a'], 'a'));
      expect(d.setLadder).toHaveBeenCalledWith('a', rung);
    }
    // and hide stays on its own dep — it is the one with a different history
    const d = deps();
    byId(buildCommands(d), 'session.hide').run(ctxWith(['a'], 'a'));
    expect(d.hideCard).toHaveBeenCalledWith('a');
  });

  it('every ladder command is disabled with no focused session, and never steals typing', () => {
    const cmds = buildCommands(deps());
    const empty = ctxWith(['a'], null);
    for (const id of [
      'session.ladder.down',
      'session.ladder.up',
      'session.expand',
      'session.collapse',
      'session.tabbed',
      'session.hide',
    ]) {
      expect(byId(cmds, id).enabled?.(empty), id).toBe(false);
      expect(byId(cmds, id).enabled?.(ctxWith(['a'], 'a')), id).toBe(true);
      // Ctrl+Shift+Arrow is a selection key in a text field and a real
      // keystroke in a terminal: 'app' scope is what keeps both of them
      expect(byId(cmds, id).scope, id).toBe('app');
    }
  });

  it('the tab-rows command routes to its dep (palette-only, no binding)', () => {
    const d = deps();
    const cmds = buildCommands(d);
    expect(byId(cmds, 'view.tabRows').binding).toBeUndefined();
    byId(cmds, 'view.tabRows').run(ctxWith([]));
    expect(d.toggleTabRows).toHaveBeenCalledOnce();
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

  it('the build identity is reachable from the palette, with no key of its own (E15-15)', () => {
    // §5.8: the palette is the map of what exists. "Which build is this?" is
    // looked up rarely and never in a hurry, so it earns a row and not a chord.
    const d = deps();
    const about = byId(buildCommands(d), 'help.about');
    expect(about.binding).toBeUndefined();
    expect(about.scope).toBe('app');
    about.run(ctxWith([]));
    expect(d.openAbout).toHaveBeenCalledOnce();
  });

  it('binds the attention jump to Ctrl+Space and runs the walk (E9-03)', () => {
    const d = deps();
    const cmds = buildCommands(d);
    const jump = byId(cmds, 'attention.next');
    expect(jump.binding).toBe('Mod+Space');
    jump.run(ctxWith(['a'], 'a', 2));
    expect(d.jumpToNextAttention).toHaveBeenCalledOnce();
  });

  it('the attention jump is unavailable — with a reason — when nothing is waiting', () => {
    const jump = byId(buildCommands(deps()), 'attention.next');
    expect(jump.enabled!(ctxWith(['a'], 'a', 0))).toBe(false);
    expect(jump.enabled!(ctxWith(['a'], 'a', 1))).toBe(true);
    // the palette greys it WITH the reason rather than hiding it (§5.8: the
    // palette is the map of what exists)
    expect(jump.disabledReasonKey).toBe('commands.disabled.emptyQueue');
  });

  it('the attention jump never fires while typing — scope stays app', () => {
    // Ctrl+Space is a real keystroke in a terminal (NUL), so scope 'app' is the
    // only correct answer here and a future edit to 'typing-ok' must fail. #90
    // did NOT change that: it claims the chord in the browser process instead,
    // above the renderer, where nothing competes with the PTY.
    expect(byId(buildCommands(deps()), 'attention.next').scope).toBe('app');
  });

  it('no two commands share a binding', () => {
    const bound = buildCommands(deps())
      .map((c) => c.binding)
      .filter(Boolean);
    expect(new Set(bound).size).toBe(bound.length);
  });

  // #90: the browser process matches these two chords itself, so its copy of
  // the accelerator has to BE the registry's. If someone rebinds the palette
  // and forgets the allowlist, the app would claim the old chord above the
  // renderer and run the command on the new one — a hotkey that works
  // everywhere except a terminal, which is the exact bug #90 fixed.
  it('every terminal accelerator names a real command, with the same binding', () => {
    const all = buildCommands(deps());
    expect(TERMINAL_ACCELERATORS.length).toBeGreaterThan(0);
    for (const a of TERMINAL_ACCELERATORS) {
      const cmd = all.find((c) => c.id === a.commandId);
      expect(cmd, `${a.commandId} is not a registered command`).toBeDefined();
      expect(cmd!.binding, `${a.commandId} binding drifted`).toBe(a.binding);
    }
  });

  // ── presentation policy (E9-06, §5.8) ─────────────────────────────────────
  describe('presentation policy', () => {
    it('names every policy at both levels — the global and the active session', () => {
      // generated from POLICY_ORDER, so a fourth policy cannot ship with two of
      // its three entries; this asserts the generation actually happened
      const cmds = buildCommands(deps());
      for (const p of POLICY_ORDER) {
        expect(byId(cmds, `presentation.policy.${p}`)).toBeDefined();
        expect(byId(cmds, `session.policy.${p}`)).toBeDefined();
      }
      expect(byId(cmds, 'session.policy.default')).toBeDefined();
    });

    it('the global entries set the global, with no session needed', () => {
      const d = deps();
      const cmds = buildCommands(d);
      byId(cmds, 'presentation.policy.auto-hide').run(ctxWith([], null));
      expect(d.setGlobalPolicy).toHaveBeenCalledWith('auto-hide');
      // a workspace-wide preference must not need a focused card
      expect(byId(cmds, 'presentation.policy.auto-hide').enabled).toBeUndefined();
    });

    it('the session entries override the ACTIVE card, and "follow the default" clears it', () => {
      const d = deps();
      const cmds = buildCommands(d);
      byId(cmds, 'session.policy.always-visible').run(ctxWith(['a', 'b'], 'b'));
      expect(d.setSessionPolicy).toHaveBeenCalledWith('b', 'always-visible');
      byId(cmds, 'session.policy.default').run(ctxWith(['a', 'b'], 'b'));
      // undefined, not "whatever the default is today" — the default can change
      expect(d.setSessionPolicy).toHaveBeenLastCalledWith('b', undefined);
    });

    it('the session entries are disabled with nothing focused', () => {
      const cmds = buildCommands(deps());
      for (const id of ['session.policy.auto-hide', 'session.policy.default']) {
        expect(byId(cmds, id).enabled?.(ctxWith(['a'], null))).toBe(false);
        expect(byId(cmds, id).disabledReasonKey).toBeTruthy();
      }
    });

    it('the GROUP level is reachable from the palette — Ctrl+B hides the only button', () => {
      // §5.8's invariant: hiding chrome never removes capability. The per-group
      // override lives on the rail's group header, and the rail toggles.
      const d = deps();
      const cmds = buildCommands(d);
      byId(cmds, 'group.policy.auto-hide').run(ctxWith(['a'], 'a', 0, 'g1'));
      expect(d.setGroupPolicy).toHaveBeenCalledWith('g1', 'auto-hide');
      byId(cmds, 'group.policy.default').run(ctxWith(['a'], 'a', 0, 'g1'));
      expect(d.setGroupPolicy).toHaveBeenLastCalledWith('g1', undefined);
    });

    it('the group entries are disabled for an ungrouped session, not silently dead', () => {
      const cmds = buildCommands(deps());
      for (const p of [...POLICY_ORDER, 'default']) {
        const c = byId(cmds, `group.policy.${p}`);
        expect(c.enabled?.(ctxWith(['a'], 'a', 0, null)), p).toBe(false);
        expect(c.enabled?.(ctxWith(['a'], 'a', 0, 'g1')), p).toBe(true);
        expect(c.disabledReasonKey, p).toBeTruthy();
      }
    });

    it('none of them claims a keybinding', () => {
      // a preference is not a per-minute action; the chip and the rail menus are
      // the everyday paths and the palette is the keyboard one
      const cmds = buildCommands(deps());
      for (const c of cmds.filter((c) => c.id.includes('policy'))) {
        expect(c.binding, `${c.id} took a binding`).toBeUndefined();
      }
    });
  });

  describe('layout modes (E9-07)', () => {
    it('names every mode in the palette, and none of the three takes a key', () => {
      const cmds = buildCommands(deps());
      for (const mode of LAYOUT_MODES) {
        const c = byId(cmds, `layout.mode.${mode}`);
        expect(c.binding, `${mode} took a binding`).toBeUndefined();
        expect(c.scope).toBe('app');
      }
    });

    it('each entry switches to the mode it names — never a cycle in disguise', () => {
      const d = deps();
      const cmds = buildCommands(d);
      for (const mode of LAYOUT_MODES) {
        byId(cmds, `layout.mode.${mode}`).run(ctxWith(['a'], 'a'));
      }
      expect((d.setLayoutMode as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
        ...LAYOUT_MODES,
      ]);
      expect(d.cycleLayoutMode).not.toHaveBeenCalled();
    });

    it('the CYCLE is the one that gets a binding, and it needs no session', () => {
      const d = deps();
      const c = byId(buildCommands(d), 'layout.cycleMode');
      expect(c.binding).toBe('Mod+Shift+L');
      expect(c.enabled?.(ctxWith([]))).not.toBe(false);
      c.run(ctxWith([]));
      expect(d.cycleLayoutMode).toHaveBeenCalled();
    });

    it('maximize has a keyboard equal to the double-click, on the ACTIVE card', () => {
      // §5.8: "double-click a session header (or one command)" — the invariant
      // is that hiding chrome never removes capability, and a mouse gesture
      // with no keyboard route would remove it outright
      const d = deps();
      const c = byId(buildCommands(d), 'session.maximize');
      expect(c.binding).toBe('Mod+Shift+M');
      c.run(ctxWith(['a', 'b'], 'b'));
      expect(d.toggleMaximize).toHaveBeenCalledWith('b');
    });

    it('maximize is disabled — with a reason — when nothing is focused', () => {
      const c = byId(buildCommands(deps()), 'session.maximize');
      expect(c.enabled?.(ctxWith(['a'], null))).toBe(false);
      expect(c.disabledReasonKey).toBeTruthy();
    });

    it('no layout command ever fires while the user is typing', () => {
      const cmds = buildCommands(deps()).filter(
        (c) => c.id.startsWith('layout.') || c.id === 'session.maximize'
      );
      expect(cmds.length).toBe(LAYOUT_MODES.length + 2);
      for (const c of cmds) expect(c.scope, c.id).toBe('app');
    });
  });
});
