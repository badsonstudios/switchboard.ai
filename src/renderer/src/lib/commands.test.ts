// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  Command,
  CommandContext,
  classifyTarget,
  dispatch,
  formatBinding,
  matchesBinding,
  parseBinding,
} from './commands';

const key = (k: string, mods: Partial<Record<'ctrl' | 'meta' | 'shift' | 'alt', boolean>> = {}) => ({
  key: k,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

const ctx: CommandContext = { sessions: [], activeCardId: null };

function cmd(over: Partial<Command> = {}): Command {
  return {
    id: 'test.cmd',
    titleKey: 'commands.test',
    categoryKey: 'commands.category.session',
    binding: 'Mod+1',
    scope: 'app',
    run: vi.fn(),
    ...over,
  };
}

describe('parseBinding', () => {
  it('splits modifiers from the key, keeping the written form for display', () => {
    expect(parseBinding('Mod+Shift+P')).toEqual({
      mod: true,
      shift: true,
      alt: false,
      key: 'p',
      rawKey: 'P',
    });
    expect(parseBinding('Mod+PageDown')?.rawKey).toBe('PageDown');
  });

  it('rejects a modifier-only accelerator', () => {
    expect(parseBinding('Mod+Shift')).toBeNull();
    expect(parseBinding('')).toBeNull();
  });
});

describe('formatBinding', () => {
  it('spells Mod per platform', () => {
    expect(formatBinding('Mod+B', 'other')).toBe('Ctrl+B');
    expect(formatBinding('Mod+B', 'darwin')).toBe('⌘B');
    expect(formatBinding('Mod+Shift+O', 'other')).toBe('Ctrl+Shift+O');
    expect(formatBinding('Mod+Shift+O', 'darwin')).toBe('⇧⌘O'); // ⌘ last, per macOS
  });

  it('keeps multi-character key names readable', () => {
    expect(formatBinding('Mod+PageDown', 'other')).toBe('Ctrl+PageDown');
  });
});

describe('matchesBinding', () => {
  it('Mod is Ctrl off macOS and Meta on it', () => {
    expect(matchesBinding(key('1', { ctrl: true }), 'Mod+1', 'other')).toBe(true);
    expect(matchesBinding(key('1', { meta: true }), 'Mod+1', 'other')).toBe(false);
    expect(matchesBinding(key('1', { meta: true }), 'Mod+1', 'darwin')).toBe(true);
    expect(matchesBinding(key('1', { ctrl: true }), 'Mod+1', 'darwin')).toBe(false);
  });

  it('the other platform modifier must be off (Ctrl+Cmd+1 is not Mod+1)', () => {
    expect(matchesBinding(key('1', { ctrl: true, meta: true }), 'Mod+1', 'other')).toBe(false);
  });

  it('is shift- and alt-exact', () => {
    expect(matchesBinding(key('1', { ctrl: true, shift: true }), 'Mod+1', 'other')).toBe(false);
    expect(matchesBinding(key('1', { ctrl: true, alt: true }), 'Mod+1', 'other')).toBe(false);
    expect(matchesBinding(key('P', { ctrl: true, shift: true }), 'Mod+Shift+P', 'other')).toBe(true);
  });

  it('a bare key needs no modifier', () => {
    expect(matchesBinding(key('Escape'), 'Escape', 'other')).toBe(true);
    expect(matchesBinding(key('Escape', { ctrl: true }), 'Escape', 'other')).toBe(false);
  });
});

describe('classifyTarget', () => {
  const el = (html: string): Element => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.firstElementChild!;
  };

  it('text inputs, textareas and contenteditable own their keys', () => {
    expect(classifyTarget(el('<textarea></textarea>')).typing).toBe(true);
    expect(classifyTarget(el('<input type="text" />')).typing).toBe(true);
    expect(classifyTarget(el('<div contenteditable="true"></div>')).typing).toBe(true);
  });

  it('buttons and checkboxes do not', () => {
    expect(classifyTarget(el('<input type="checkbox" />')).typing).toBe(false);
    expect(classifyTarget(el('<button></button>')).typing).toBe(false);
    expect(classifyTarget(el('<div></div>')).typing).toBe(false);
  });

  it('anything inside an xterm surface is flagged terminal (and typing)', () => {
    const host = document.createElement('div');
    host.className = 'xterm';
    const inner = document.createElement('textarea');
    inner.className = 'xterm-helper-textarea';
    host.appendChild(inner);
    expect(classifyTarget(inner)).toEqual({ typing: true, terminal: true });
  });

  it('a null target is fair game', () => {
    expect(classifyTarget(null)).toEqual({ typing: false, terminal: false });
  });
});

describe('dispatch (E9-01 scope rule)', () => {
  it('runs the matching command and prevents the default', () => {
    const c = cmd();
    const preventDefault = vi.fn();
    const ran = dispatch({ ...key('1', { ctrl: true }), preventDefault }, [c], ctx, 'other');
    expect(ran).toBe(c);
    expect(c.run).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('leaves an unmatched key alone (no preventDefault)', () => {
    const preventDefault = vi.fn();
    expect(dispatch({ ...key('2', { ctrl: true }), preventDefault }, [cmd()], ctx, 'other')).toBeNull();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('never fires while focus is in a text input (scope app)', () => {
    const c = cmd();
    const target = document.createElement('textarea');
    expect(dispatch({ ...key('1', { ctrl: true }), target }, [c], ctx, 'other')).toBeNull();
    expect(c.run).not.toHaveBeenCalled();
  });

  it("a bare digit in a text input never jumps (the issue's done-when)", () => {
    const c = cmd();
    const target = document.createElement('textarea');
    expect(dispatch({ ...key('1'), target }, [c], ctx, 'other')).toBeNull();
    expect(c.run).not.toHaveBeenCalled();
  });

  it("'typing-ok' fires in our own inputs", () => {
    const c = cmd({ scope: 'typing-ok' });
    const target = document.createElement('textarea');
    expect(dispatch({ ...key('1', { ctrl: true }), target }, [c], ctx, 'other')).toBe(c);
  });

  it('NOTHING fires in a terminal — not even typing-ok (the CLI owns its keys)', () => {
    const host = document.createElement('div');
    host.className = 'xterm';
    const target = document.createElement('textarea');
    host.appendChild(target);
    const c = cmd({ scope: 'typing-ok' });
    const preventDefault = vi.fn();
    expect(dispatch({ ...key('1', { ctrl: true }), target, preventDefault }, [c], ctx, 'other')).toBeNull();
    expect(c.run).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled(); // the keystroke reaches the PTY
  });

  it('ignores keys mid-IME-composition', () => {
    const c = cmd();
    expect(dispatch({ ...key('1', { ctrl: true }), isComposing: true }, [c], ctx, 'other')).toBeNull();
  });

  it('a disabled command matches but does not run, and keeps its default', () => {
    const c = cmd({ enabled: () => false });
    const preventDefault = vi.fn();
    expect(dispatch({ ...key('1', { ctrl: true }), preventDefault }, [c], ctx, 'other')).toBeNull();
    expect(c.run).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('palette-only commands (no binding) are never key-dispatched', () => {
    const c = cmd({ binding: undefined });
    expect(dispatch({ ...key('1', { ctrl: true }) }, [c], ctx, 'other')).toBeNull();
  });

  it('ignores auto-repeat: holding Ctrl+N must not queue nine folder pickers', () => {
    const c = cmd();
    expect(dispatch({ ...key('1', { ctrl: true }), repeat: true }, [c], ctx, 'other')).toBeNull();
    expect(c.run).not.toHaveBeenCalled();
  });

  it('fails open: a throwing command is reported, never rethrown into the handler', () => {
    const boom = new Error('nope');
    const c = cmd({
      run: () => {
        throw boom;
      },
    });
    const onError = vi.fn();
    expect(() =>
      dispatch({ ...key('1', { ctrl: true }) }, [c], ctx, 'other', onError)
    ).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom, c.id);
  });

  it('fails open when enabled() itself throws', () => {
    const c = cmd({
      enabled: () => {
        throw new Error('nope');
      },
    });
    const onError = vi.fn();
    expect(dispatch({ ...key('1', { ctrl: true }) }, [c], ctx, 'other', onError)).toBeNull();
    expect(c.run).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('matches the PHYSICAL key too, so Ctrl+1 works on non-US layouts', () => {
    const c = cmd();
    // AZERTY: the '1' key unshifted reports key='&' but code='Digit1'
    expect(dispatch({ ...key('&', { ctrl: true }), code: 'Digit1' }, [c], ctx, 'other')).toBe(c);
  });

  it('runs at most one command per keystroke', () => {
    const a = cmd({ id: 'a' });
    const b = cmd({ id: 'b' });
    expect(dispatch({ ...key('1', { ctrl: true }) }, [a, b], ctx, 'other')).toBe(a);
    expect(b.run).not.toHaveBeenCalled();
  });
});
