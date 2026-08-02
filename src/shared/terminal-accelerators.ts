// THE TERMINAL ACCELERATOR ALLOWLIST (#90, DESIGN §5.8, PHILOSOPHY P7).
//
// Everywhere else in this app, a key pressed inside an xterm surface belongs to
// the CLI, full stop — `dispatch` in renderer/lib/commands.ts bails on a
// terminal target before it ever looks at a command's scope, and that rule does
// not bend. The cost of it was that from inside a terminal — where an operator
// spends most of the day — NO accelerator fired, the command palette's
// included, so every command was mouse-only from there. §5.8 says hiding chrome
// must never remove capability; being unable to reach the palette or the
// attention queue by keyboard is exactly that, removed.
//
// So a tiny number of chords are claimed ABOVE the renderer instead: the
// browser process matches them in `before-input-event` and never lets them
// reach the page, so they don't compete with the PTY for a keystroke — the
// renderer's hard rule is untouched, because the key never gets there. The
// matched command is then run through the SAME registry as every other command
// (see dispatchAccelerator); this is a second doorway, not a second command
// path.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GROWTH RULE — read this before adding an entry.
//
// Every chord on this list is a keystroke the hosted CLI can NEVER receive from
// a first press again (auto-repeat is deliberately not claimed, so a HELD chord
// still reaches the PTY after the first one). That is a permanent tax on the
// thing we promised to host rather than reimplement (P7), paid by every
// provider we will ever adapt. So the list does not grow by habit or
// convenience. A chord may join it only if ALL FIVE hold:
//
//   1. THE CLI DOES NOT WANT IT. Verified against the provider's own key
//      handling — the reference implementations, not an assumption (see
//      docs/reference-implementations.md). Write the evidence next to the entry.
//   2. IT IS A CHORD, NOT A KEY. Modifier + key only. Never a bare key, an
//      arrow, Tab, Enter, Escape, Backspace, and never one of the control keys
//      a terminal line editor owns (Ctrl+A/B/C/D/E/F/K/L/N/P/R/U/W/Y/Z).
//   3. IT RESTORES CAPABILITY, IT DOES NOT ADD CONVENIENCE. The command must
//      otherwise be unreachable by keyboard from a terminal AND be something an
//      operator needs from there many times a day. "It would be handy" is a no.
//   4. THE PALETTE CANNOT ALREADY DO IT. The palette is on this list precisely
//      so that everything else does not have to be: one chord reaches every
//      registered command. A new entry has to justify why going through the
//      palette is not good enough.
//   5. IT IS A WORK ITEM, WITH THE REASON WRITTEN HERE. Not a drive-by edit.
//
// If any of the five is arguable, the answer is no. Two entries is not a
// starting point to build on; it is the intended size.
// ─────────────────────────────────────────────────────────────────────────────
import { KeyLike, matchesBinding, Platform } from './accelerators';

export interface TerminalAccelerator {
  /** id of a command in the renderer registry — never a second implementation */
  commandId: string;
  /** must equal that command's own `binding`; a unit test enforces it */
  binding: string;
}

export const TERMINAL_ACCELERATORS: readonly TerminalAccelerator[] = [
  // The palette. Rule 4 exists because of this entry: with the palette
  // reachable, no other command NEEDS a chord of its own from a terminal.
  //
  // Rule 1 evidence (claude 2.1.220, read off the shipped binary 2026-08-02 —
  // it embeds its complete default keybinding table, 15 contexts): no
  // `ctrl+shift+p` binding exists. The ctrl+shift chords it DOES bind are
  // ctrl+shift+b, ctrl+shift+c and ctrl+shift+-/_. Stronger still, the chord
  // cannot reach the CLI at all today: xterm.js only maps ctrl+letter to a
  // control byte when shift is NOT held, so Ctrl+Shift+P currently produces
  // nothing on the wire. Note ctrl+P alone IS bound — a different DOM event and
  // a different byte, unaffected by this claim.
  { commandId: 'palette.open', binding: 'Mod+Shift+P' },
  // The attention jump. §5.8 makes this the primary workflow at 7–8 sessions,
  // and the sessions you jump between are precisely the ones you are sitting
  // inside when you need it — so it earns rule 3 where nothing else does.
  //
  // Rule 1 evidence (same read): zero occurrences of `ctrl+space`. What the PTY
  // would have received is NUL (0x00), which the CLI's keypress parser
  // normalises to the name ``ctrl+` `` — also unbound, i.e. silently dropped.
  // Bare `space` IS bound (push-to-talk, confirm), but that is 0x20 and a
  // different keystroke; this claim does not touch it.
  { commandId: 'attention.next', binding: 'Mod+Space' },
];
// Residual risk, recorded rather than guessed at: Claude Code lets a user
// rebind keys in ~/.claude/keybindings.json, and neither chord is on its
// reserved list — so a user COULD bind one of these for themselves and we would
// then be shadowing it. No shipped interaction is being stolen, which is what
// P7 protects; if per-provider opt-out ever matters, this list is where it
// would be read from rather than hardcoded.

/**
 * The Electron `Input` fields we look at. Declared structurally rather than
 * imported from electron so this module stays usable (and testable) in the
 * renderer and in a plain vitest run.
 */
export interface AcceleratorInput {
  type: string;
  key: string;
  code?: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  isAutoRepeat?: boolean;
  isComposing?: boolean;
}

function asKeyLike(input: AcceleratorInput): KeyLike {
  return {
    key: input.key,
    code: input.code,
    ctrlKey: input.control,
    metaKey: input.meta,
    shiftKey: input.shift,
    altKey: input.alt,
  };
}

/**
 * The id of the allowlisted command this keystroke claims, or null — and null
 * is the answer for everything else the CLI might want, which is the property
 * that matters. Only keyDown is ever claimed: the matching keyUp is left alone
 * so a terminal's modifier tracking never sees a half-swallowed chord.
 */
export function matchTerminalAccelerator(
  input: AcceleratorInput,
  platform: Platform
): string | null {
  if (input.type !== 'keyDown') return null;
  if (input.isAutoRepeat) return null; // holding it must not queue N jumps
  if (input.isComposing) return null; // mid-IME, same rule as the dispatcher
  for (const a of TERMINAL_ACCELERATORS) {
    if (matchesBinding(asKeyLike(input), a.binding, platform)) return a.commandId;
  }
  return null;
}
