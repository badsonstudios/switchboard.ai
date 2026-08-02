// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import {
  Command,
  CommandContext,
  classifyTarget,
  dispatch,
  dispatchAccelerator,
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

const ctx: CommandContext = { sessions: [], activeCardId: null, attentionCount: 0 };

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
    expect(formatBinding('Mod+Space', 'other')).toBe('Ctrl+Space');
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

  it('Mod+Space matches the spacebar, whose key is a literal space (E9-03)', () => {
    // the ONLY thing that can match here is the physical code: the accelerator
    // spells 'Space' for readability, the event reports key ' '
    const space = { ...key(' ', { ctrl: true }), code: 'Space' };
    expect(matchesBinding(space, 'Mod+Space', 'other')).toBe(true);
    // without the code there is nothing to match on — proves the code path is
    // load-bearing rather than incidentally passing via the key comparison
    expect(matchesBinding(key(' ', { ctrl: true }), 'Mod+Space', 'other')).toBe(false);
    // and a bare spacebar is still just a space
    expect(matchesBinding({ ...key(' '), code: 'Space' }, 'Mod+Space', 'other')).toBe(false);
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

describe('dispatchAccelerator (#90 — claimed above the renderer)', () => {
  /** an element inside an xterm surface, i.e. the case the whole item exists for */
  const inTerminal = (): Element => {
    const host = document.createElement('div');
    host.className = 'xterm';
    const el = document.createElement('textarea');
    el.className = 'xterm-helper-textarea';
    host.appendChild(el);
    return el;
  };

  it('RUNS from inside a terminal — the key never reached the PTY to be stolen', () => {
    const c = cmd({ id: 'palette.open', scope: 'typing-ok' });
    expect(dispatchAccelerator('palette.open', [c], ctx, inTerminal())).toBe(c);
    expect(c.run).toHaveBeenCalledOnce();
  });

  it("runs an 'app'-scope command in a terminal too (the attention jump)", () => {
    const c = cmd({ id: 'attention.next', scope: 'app' });
    expect(dispatchAccelerator('attention.next', [c], ctx, inTerminal())).toBe(c);
  });

  it('still stands down while you type in OUR OWN inputs (scope survives)', () => {
    const c = cmd({ id: 'attention.next', scope: 'app' });
    expect(dispatchAccelerator('attention.next', [c], ctx, document.createElement('textarea'))).toBeNull();
    expect(c.run).not.toHaveBeenCalled();
  });

  it("...unless the command is 'typing-ok', like the palette", () => {
    const c = cmd({ id: 'palette.open', scope: 'typing-ok' });
    expect(dispatchAccelerator('palette.open', [c], ctx, document.createElement('textarea'))).toBe(c);
  });

  it('runs with no focused element at all', () => {
    const c = cmd({ id: 'palette.open', scope: 'typing-ok' });
    expect(dispatchAccelerator('palette.open', [c], ctx, null)).toBe(c);
  });

  it('runs the REGISTERED command — an id we do not register does nothing', () => {
    const c = cmd({ id: 'palette.open' });
    expect(dispatchAccelerator('something.else', [c], ctx, null)).toBeNull();
    expect(c.run).not.toHaveBeenCalled();
  });

  it('respects enabled(): an empty queue is still a no-op', () => {
    const c = cmd({ id: 'attention.next', enabled: (x) => x.attentionCount > 0 });
    expect(dispatchAccelerator('attention.next', [c], ctx, inTerminal())).toBeNull();
    expect(c.run).not.toHaveBeenCalled();
    const withQueue = { ...ctx, attentionCount: 1 };
    expect(dispatchAccelerator('attention.next', [c], withQueue, inTerminal())).toBe(c);
  });

  it('fails open: a throwing command is reported, never rethrown', () => {
    const boom = new Error('nope');
    const c = cmd({
      id: 'palette.open',
      run: () => {
        throw boom;
      },
    });
    const onError = vi.fn();
    expect(() => dispatchAccelerator('palette.open', [c], ctx, null, onError)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom, c.id);
  });

  it('fails open when enabled() itself throws', () => {
    const c = cmd({
      id: 'palette.open',
      enabled: () => {
        throw new Error('nope');
      },
    });
    const onError = vi.fn();
    expect(dispatchAccelerator('palette.open', [c], ctx, null, onError)).toBeNull();
    expect(c.run).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});
