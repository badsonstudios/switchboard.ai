// Claude's permission modes <-> the host's autonomy vocabulary (§5.9).
//
// Both directions in one place: `claude.ts` writes the mode into
// `--permission-mode` at spawn, and the translator (`claude-events.ts`) reads
// the CLI's own `system:status.permissionMode` back into a neutral `mode`
// event (#1072; behind the adapter since E40 item 04, #1287). A module of its
// own because `claude.ts` imports the translator, and the translator must not
// import `claude.ts` back.
import { AUTONOMY_MODES, type AutonomyMode } from '../../shared/sessions';

/**
 * §5.9 autonomy profile -> the CLI's `--permission-mode` value.
 *
 * **Every profile names its mode. Nothing is left to the CLI's built-in
 * default** (#587) — because that default moved under us. From CLI **v2.1.228**
 * (macOS/Linux/WSL) and **v2.1.233** on native Windows, the built-in starting
 * mode on Pro/Max/Team plans is `auto` — a classifier reviews each action
 * instead of a person. `ask` used to pass no flag at all and inherit that, so
 * on a current CLI the profile named "ask" no longer asked: everything our
 * PreToolUse hook does not gate (fail-open when the listener is down, tool
 * names outside `PRETOOL_MATCHER`) went to the classifier rather than to Dan.
 * Naming the mode is the whole fix — we still let the CLI enforce it.
 *
 * `default` is Manual mode's config value: "stops and asks you before most
 * actions that edit files, run shell commands, or reach the network". The CLI
 * renamed the *label* to Manual in v2.1.200 and `--help` on 2.1.233 advertises
 * only the `manual` alias — but `default` is the canonical value the SDK,
 * hooks and `permissions.defaultMode` use, it is what `manual` is normalized
 * to, and it is the one that also works on pre-2.1.200 CLIs. So: `default`.
 *
 * Passing the flag is enough; we deliberately do NOT also write
 * `permissions.defaultMode` into the per-session settings file, because
 * `--permission-mode` outranks every settings file in the CLI's own precedence
 * order. One lever, not two.
 *
 * This does not take a mode away from the user: `auto` is in the Shift+Tab
 * cycle whenever the account is eligible, regardless of the start flag.
 *
 * CONTRACT NOTE — semantics last verified **2026-08-19 against `claude`
 * 2.1.233 on PATH** (values probed with `--permission-mode <v> --version`, no
 * token spend: `default`, `manual`, `auto`, `dontAsk`, `acceptEdits`, `plan`,
 * `bypassPermissions` all accepted; a bogus value is rejected, so acceptance
 * is a real signal) and against the SDK enum embedded in the VS Code extension
 * 2.1.226 (`["acceptEdits","auto","bypassPermissions","default","dontAsk",
 * "plan"]` plus a `manual -> default` alias) and the settings schema's
 * `permissions.defaultMode` description. Re-verify on a CLI major bump.
 */
export const AUTONOMY_PERMISSION_MODE: Record<AutonomyMode, string> = {
  plan: 'plan',
  ask: 'default',
  'auto-edit': 'acceptEdits',
  'full-auto': 'bypassPermissions',
};

/**
 * The CLI's `permissionMode` value → our profile, or `null` for one we have no
 * name for.
 *
 * Derived from `AUTONOMY_PERMISSION_MODE` rather than written out a second
 * time, so the two directions cannot disagree. The CLI has modes we do not
 * offer (`auto`, `dontAsk`); for those the honest answer is "unknown", and the
 * caller keeps showing what it had rather than a profile that is merely close.
 */
export function autonomyFromPermissionMode(value: unknown): AutonomyMode | null {
  if (typeof value !== 'string') return null;
  for (const mode of AUTONOMY_MODES) {
    if (AUTONOMY_PERMISSION_MODE[mode] === value) return mode;
  }
  return null;
}
