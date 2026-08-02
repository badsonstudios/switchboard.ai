// Accelerator primitives — parse, format, match. SHARED, not renderer-only.
//
// These lived in renderer/lib/commands.ts until #90, which gave the browser
// process a reason to match a keystroke too: two accelerators are claimed above
// the renderer so they still work when focus is inside a session terminal (see
// terminal-accelerators.ts). A second matcher in main would be a second set of
// rules about what 'Mod+Space' means — the kind of drift that only shows up as
// "the hotkey works in the app but not in the terminal". So there is ONE
// matcher, here, and commands.ts re-exports it for its existing callers.
//
// Pure by construction: no DOM, no Electron, no React. `commands.ts` keeps
// everything that needs an Element (classifyTarget) or the registry.

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

/** The subset of KeyboardEvent the matcher needs — keeps tests DOM-free, and
 *  lets the browser process feed it an Electron `Input` instead. */
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
  // the spacebar reports key ' ' — a binding has to spell it 'Space' to be
  // readable, so the physical code is the only thing that can match it
  if (key === 'space') return 'Space';
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
