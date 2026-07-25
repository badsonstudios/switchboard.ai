// Command registry + keybinding dispatcher (P2-E9-01, DESIGN §5.8 + §8).
//
// Every keyboard-reachable action is a Command with a stable id, an i18n title
// key, an optional accelerator and a scope. The registry is the single source
// of truth: the palette (E9-02) renders it, the dispatcher runs it, and nothing
// else in the app binds keys globally.
//
// THE HARD RULE (host-don't-reimplement): a binding NEVER steals a keystroke
// that the CLI — or one of our own text inputs — should get. Focus inside an
// xterm surface means zero commands fire, full stop; the terminal is the real
// CLI and owns every key it sees. Our own inputs (composer, rename fields) are
// protected too, which is why every seed binding is scope 'app'.
//
// Pure by construction (no React, no DOM globals beyond the event/element it is
// handed) so the whole thing is unit-testable.

export type CommandScope =
  /** never fires while focus is in a text input or a terminal (the default) */
  | 'app'
  /** may fire in OUR text inputs — still never in a terminal. Reserved for
   *  E9-02's palette hotkey; no seed command uses it yet. */
  | 'typing-ok';

export interface CommandContext {
  /** sessions in RAIL ORDER — what "jump to session N" counts against */
  sessions: Array<{ id: string; title: string }>;
  /** card id of the currently focused session card, if any */
  activeCardId: string | null;
}

export interface Command<Ctx extends CommandContext = CommandContext> {
  id: string;
  /** i18n key, resolved at render time by the palette (no hardcoded strings) */
  titleKey: string;
  /** interpolation for titleKey, e.g. the N in "Jump to session N" */
  titleParams?: Record<string, unknown>;
  /** i18n key for the palette's grouping header */
  categoryKey: string;
  /** accelerator, e.g. 'Mod+1'. Commands without one are palette-only. */
  binding?: string;
  scope: CommandScope;
  /** preconditions; the palette greys unmet ones out with disabledReasonKey */
  enabled?: (ctx: Ctx) => boolean;
  disabledReasonKey?: string;
  run: (ctx: Ctx) => void;
}

export type Platform = 'darwin' | 'other';

/** Parsed accelerator. `key` is compared case-insensitively against
 *  KeyboardEvent.key, so 'Mod+Shift+P' matches the 'P' a shifted p produces. */
export interface ParsedBinding {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** lowercased, for matching */
  key: string;
  /** as written ('PageDown'), for display */
  rawKey: string;
}

/**
 * 'Mod+Shift+P' -> {mod, shift, key:'p'}. `Mod` is Ctrl everywhere except
 * macOS, where it is Meta — one accelerator string, correct on all three OSes.
 */
export function parseBinding(binding: string): ParsedBinding | null {
  const parts = binding
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const out: ParsedBinding = {
    mod: false,
    shift: false,
    alt: false,
    key: '',
    rawKey: '',
  };
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === 'mod' || low === 'ctrl' || low === 'cmd') out.mod = true;
    else if (low === 'shift') out.shift = true;
    else if (low === 'alt') out.alt = true;
    else {
      if (out.key) return null; // two non-modifier tokens: a typo, not a binding
      out.key = low;
      out.rawKey = p;
    }
  }
  return out.key ? out : null;
}

/**
 * Human label for an accelerator: 'Mod+Shift+P' -> 'Ctrl+Shift+P', or
 * '⌘⇧P' on macOS. Used by tooltips today and by the palette's binding
 * column (E9-02) — never store this, always derive it from the binding.
 */
export function formatBinding(binding: string, platform: Platform): string {
  const b = parseBinding(binding);
  if (!b) return '';
  const key = b.rawKey.length === 1 ? b.rawKey.toUpperCase() : b.rawKey;
  // macOS convention orders the modifiers ⌃⌥⇧⌘, Command LAST: ⇧⌘P
  if (platform === 'darwin') {
    return `${b.alt ? '⌥' : ''}${b.shift ? '⇧' : ''}${b.mod ? '⌘' : ''}${key}`;
  }
  const parts = [b.mod && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', key].filter(Boolean);
  return parts.join('+');
}

/** The subset of KeyboardEvent the matcher needs — keeps tests DOM-free. */
export interface KeyLike {
  key: string;
  /** physical key ('Digit1', 'Backquote') — layout-independent */
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Physical-key equivalent for the accelerators where `key` is layout-dependent.
 * On AZERTY the top row's unshifted `key` is '&', 'é'…, and the backquote sits
 * elsewhere entirely — matching `code` too keeps Ctrl+1..9 and Ctrl+` working
 * on non-US layouts.
 */
function codeFor(key: string): string | null {
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === '`') return 'Backquote';
  return null;
}

export function matchesBinding(e: KeyLike, binding: string, platform: Platform): boolean {
  const b = parseBinding(binding);
  if (!b) return false;
  const mod = platform === 'darwin' ? e.metaKey : e.ctrlKey;
  // the non-Mod modifier must be OFF, else Ctrl+1 would also match Cmd+Ctrl+1
  const otherMod = platform === 'darwin' ? e.ctrlKey : e.metaKey;
  if (b.mod !== mod || otherMod) return false;
  if (b.shift !== e.shiftKey) return false;
  if (b.alt !== e.altKey) return false;
  if (e.key.toLowerCase() === b.key) return true;
  const code = codeFor(b.key);
  return !!code && e.code === code;
}

/**
 * Is this element one that owns its own keys? Text inputs (composer, rename
 * fields), contenteditable surfaces, and — absolutely — anything inside a
 * terminal. `terminal` is reported separately because NO scope may override it.
 */
export function classifyTarget(el: Element | null): {
  typing: boolean;
  terminal: boolean;
} {
  if (!el) return { typing: false, terminal: false };
  const terminal = !!el.closest?.('.xterm');
  if (terminal) return { typing: true, terminal: true };
  const tag = el.tagName?.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return { typing: true, terminal: false };
  if (tag === 'input') {
    // buttons/checkboxes aren't text entry — a key there is fair game
    const type = (el as HTMLInputElement).type?.toLowerCase() ?? 'text';
    const nonText = ['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'];
    return { typing: !nonText.includes(type), terminal: false };
  }
  // attribute-based (not isContentEditable): catches nodes NESTED inside an
  // editable region, and jsdom doesn't implement the property at all
  const editable =
    (el as HTMLElement).isContentEditable ||
    !!el.closest?.('[contenteditable=""], [contenteditable="true"]');
  return { typing: editable, terminal: false };
}

export interface DispatchEvent extends KeyLike {
  isComposing?: boolean;
  /** auto-repeat from a held key — never runs a command */
  repeat?: boolean;
  target?: Element | null;
  preventDefault?: () => void;
}

/**
 * Run the first command whose binding matches. Returns the command that ran, or
 * null. preventDefault() is called ONLY when a command actually ran — an
 * unmatched key must reach whatever would have got it anyway.
 *
 * A matched-but-disabled command stops the scan rather than letting a later
 * command claim the same accelerator as a fallback: one key, one meaning.
 *
 * Fail-open (a hard constraint): a throwing command must never escape into the
 * keydown handler, where an uncaught error could wedge the renderer.
 */
export function dispatch<Ctx extends CommandContext>(
  e: DispatchEvent,
  commands: Array<Command<Ctx>>,
  ctx: Ctx,
  platform: Platform,
  onError?: (err: unknown, commandId: string) => void,
): Command<Ctx> | null {
  if (e.isComposing) return null; // mid-IME composition (same rule as the composer)
  if (e.repeat) return null; // holding Ctrl+N must not queue nine folder pickers
  const { typing, terminal } = classifyTarget(e.target ?? null);
  if (terminal) return null; // the CLI owns every key it can see
  for (const cmd of commands) {
    if (!cmd.binding) continue;
    if (typing && cmd.scope !== 'typing-ok') continue;
    if (!matchesBinding(e, cmd.binding, platform)) continue;
    try {
      if (cmd.enabled && !cmd.enabled(ctx)) return null; // matched but unavailable
    } catch (err) {
      onError?.(err, cmd.id);
      return null;
    }
    e.preventDefault?.();
    try {
      cmd.run(ctx);
    } catch (err) {
      onError?.(err, cmd.id);
    }
    return cmd;
  }
  return null;
}

/** the accelerator bound to a command id, or '' — for tooltips and the palette */
export function bindingFor<Ctx extends CommandContext>(
  commands: Array<Command<Ctx>>,
  id: string,
): string {
  return commands.find((c) => c.id === id)?.binding ?? '';
}
