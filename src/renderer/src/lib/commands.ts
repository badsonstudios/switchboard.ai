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
// THE ONE EXCEPTION, and it is not an exception to the rule above: #90 claims
// two chords in the BROWSER process (shared/terminal-accelerators.ts), where
// they never compete with the PTY for a keystroke. Those keys never reach this
// dispatcher — they arrive as a command id instead, through
// `dispatchAccelerator` below, which runs the same registered command.
//
// Pure by construction (no React, no DOM globals beyond the event/element it is
// handed) so the whole thing is unit-testable.

// Parsing/formatting/matching an accelerator is shared with the browser process
// now (#90) and lives in shared/accelerators.ts. Re-exported here because this
// module is where the rest of the renderer looks for them, and because ONE
// matcher for both processes is the whole point.
export * from '../../../shared/accelerators';
import { KeyLike, matchesBinding, Platform } from '../../../shared/accelerators';

export type CommandScope =
  /** never fires while focus is in a text input or a terminal (the default) */
  | 'app'
  /** may fire in OUR text inputs — still never from a keystroke a terminal
   *  saw. The palette (E9-02) is the one command that uses it. */
  | 'typing-ok';

export interface CommandContext {
  /** sessions in RAIL ORDER — what "jump to session N" counts against */
  sessions: Array<{ id: string; title: string }>;
  /** card id of the currently focused session card, if any */
  activeCardId: string | null;
  /**
   * How many sessions are waiting on a human right now (lib/queue). Required
   * rather than optional so every dispatch site has to pass the LIVE depth —
   * a stale or omitted count would grey out the jump hotkey while sessions
   * are actually blocked, which is the one failure this command cannot have.
   */
  attentionCount: number;
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
    if (!isAvailable(cmd, ctx, onError)) return null; // matched but unavailable
    e.preventDefault?.();
    return runCommand(cmd, ctx, onError);
  }
  return null;
}

/**
 * `enabled`, evaluated fail-open-ish: a predicate that THROWS is treated as
 * "not available" rather than being allowed to escape into a key handler.
 */
function isAvailable<Ctx extends CommandContext>(
  cmd: Command<Ctx>,
  ctx: Ctx,
  onError?: (err: unknown, commandId: string) => void,
): boolean {
  try {
    return !cmd.enabled || cmd.enabled(ctx);
  } catch (err) {
    onError?.(err, cmd.id);
    return false;
  }
}

/** Run a command, swallowing its throw. The ONE place a command is invoked. */
function runCommand<Ctx extends CommandContext>(
  cmd: Command<Ctx>,
  ctx: Ctx,
  onError?: (err: unknown, commandId: string) => void,
): Command<Ctx> {
  try {
    cmd.run(ctx);
  } catch (err) {
    onError?.(err, cmd.id);
  }
  return cmd;
}

/**
 * Run a command claimed ABOVE the renderer (#90): the browser process matched
 * one of the two allowlisted chords in `before-input-event` and sends us its
 * id, because the keystroke itself was stopped before the page — and therefore
 * before the PTY — could see it.
 *
 * NOT a second command path: it runs the same registered command, through the
 * same enabled-check and the same fail-open guard as `dispatch`. What it does
 * differently is the one thing the mechanism exists for — a TERMINAL target
 * does not veto it. That is not a hole in the hard rule: the key was taken
 * before the terminal ever had a claim on it, and only the two chords on the
 * allowlist can arrive here at all.
 *
 * Everything else still applies. `target` is the element that had focus when
 * the chord was pressed, and outside a terminal the ordinary scope rule holds —
 * so a command that must not fire while you are typing still doesn't.
 */
export function dispatchAccelerator<Ctx extends CommandContext>(
  commandId: string,
  commands: Array<Command<Ctx>>,
  ctx: Ctx,
  target: Element | null,
  onError?: (err: unknown, commandId: string) => void,
): Command<Ctx> | null {
  const cmd = commands.find((c) => c.id === commandId);
  if (!cmd) return null; // an id we no longer register: nothing to run, never a throw
  const { typing, terminal } = classifyTarget(target);
  if (typing && !terminal && cmd.scope !== 'typing-ok') return null;
  if (!isAvailable(cmd, ctx, onError)) return null;
  return runCommand(cmd, ctx, onError);
}

/** the accelerator bound to a command id, or '' — for tooltips and the palette */
export function bindingFor<Ctx extends CommandContext>(
  commands: Array<Command<Ctx>>,
  id: string,
): string {
  return commands.find((c) => c.id === id)?.binding ?? '';
}
