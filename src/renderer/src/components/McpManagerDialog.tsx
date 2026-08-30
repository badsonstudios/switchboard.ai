// The MCP Manager (§5.17, #632 read, #714 write).
//
// WHAT IT ANSWERS: "what MCP servers has this session CONFIGURED, is the
// CLI talking to them, and can I change that from here?" The emphasis is load-
// bearing and was added late: this line said "actually have" until #723 proved
// that is a different and much larger set. See the #723 block below.
//
// Before #632 the first two had no answer inside switchboard at all — `/mcp`
// opens a picker in the CLI's TUI, and a Direct session has no terminal for it
// to appear in (#633).
// Before #714 the third was "no": the pane was read-only and pointed at the
// command line.
//
// The dialog shape — scrim, click-away, focus capture, Escape — is
// `QuietHoursDialog.tsx`'s, which is `PushSetupDialog.tsx`'s, which is
// `AboutPanel.tsx`'s. Two modals that behave differently is a bug report
// waiting to happen.
//
// ── WHAT IT STILL DOES NOT DO, AND WHY ───────────────────────────────────────
//
// ENABLE / DISABLE A SERVER. No `claude mcp` SUBCOMMAND does it — the full set
// is `add`, `add-from-claude-desktop`, `add-json`, `get`, `list`, `login`,
// `logout`, `remove`, `reset-project-choices`, `serve` (probed 2026-08-25,
// re-probed 2026-08-26). Approval lives in two lists — `enabledMcpjsonServers`
// and `disabledMcpjsonServers` — that only a session or a settings write moves,
// and writing them ourselves means owning a shape the CLI can change under us.
// Declined on P7. What is offered instead is honest: RECONNECT hands the
// question to the CLI's own picker, and RESET APPROVALS runs the one real
// subcommand.
//
// THIS COMMENT USED TO SAY "there is no CLI verb", FULL STOP, AND THAT WAS
// WRONG (#721, 2026-08-27). It was a claim about the whole CLI inferred from a
// probe of `claude mcp --help`. The stream-json control protocol has
// `mcp_toggle {serverName, enabled}`, `mcp_reconnect` and `mcp_status`, all
// present in the PATH CLI and used by Anthropic's own VS Code extension. We
// parse control requests INBOUND (stream permissions) and have never sent one
// OUTBOUND, which is the actual reason this pane hands off instead of toggling.
// Nothing here is broken — but do not repeat the "no verb exists" reasoning on
// another surface without checking the control protocol first.
//
// SHOW EVERY SERVER THE SESSION ACTUALLY HAS (#723). This pane lists what the
// CONFIG FILES hold, and that is a strict subset of what the CLI resolves at
// run time. Its scope vocabulary in 2.1.245 is `local` · `user` · `project` ·
// `enterprise` · `managed` · `builtin` · `dynamic` · `skills`, plus a separate
// claude.ai connector class; `dynamic` covers `--mcp-config`, plugins, the IDE
// bridge and chrome. `main/mcp/config.ts` reads three files and can therefore
// reach three of those. The two blocs that dominate a real machine — account
// connectors and plugin-contributed servers — live in NO file, so they are
// missing BY CONSTRUCTION rather than by a bug in the merge.
//
// DO NOT "FIX" THIS BY SHELLING HARDER. `claude mcp list` describes itself as
// "List CONFIGURED MCP servers" (read out of the PATH binary, 2026-08-28) — it
// is the same config surface, not an escape hatch from it. The runtime list is
// reachable exactly once, over the control protocol: `mcp_status` returns
// `{name, status, serverInfo, config, scope, tools[]}` per server, measured
// against a session spawned with our own flag list.
//
// DONE (#729). The pane now asks `mcp_status` whenever the card has a live
// stream session, and draws the config list only when it cannot — a suspended
// card or a Terminal-transport session, neither of which has a control channel.
// So the subset case still exists; it is just no longer the only case, and the
// footer now names WHICH of the three reasons applies instead of stating the
// limit unconditionally.
//
// ⚠️ THE RUNTIME ANSWER SETTLES. A freshly spawned session reports every server
// as `pending`, with no `serverInfo` and no `tools`, for several seconds before
// it reports `connected` (measured 2026-08-29 —
// `spike/probes/721/probe-mcp-settle.mjs`: pending at 0.9s, connected at 5.0s).
// §1.2.2's captured example is the WARM answer. Asking once on open is
// therefore a design that shows a healthy session as a wall of grey, which is
// why there is a bounded re-poll below.
//
// SHOW A SECRET. `McpServerWire` carries `envKeys` and `headerKeys` — the NAMES
// — and has no field that can hold a value, so there is nothing here to reveal
// even by accident. The add form is the one place a value exists, it is a
// password field, and it travels one way. See `shared/mcp.ts`.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../shared/ipc/refusal';
import { McpAddForm, McpDialogButton as Btn } from './McpAddForm';
import type {
  McpAddRequest,
  McpHealth,
  McpInventoryWire,
  McpMutationResult,
  McpRuntimeScope,
  McpRuntimeServer,
  McpRuntimeStatus,
  McpScope,
  McpServerWire,
  McpStatusWire,
} from '../../../shared/mcp';
import type { ControlVerdict } from '../../../shared/control';

export interface McpManagerDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * The folder whose servers to show — a session's, never a free path.
   *
   * `null` when no session is active, which is a real state (an empty
   * workspace, or the Changes tab focused) and gets its own line rather than an
   * empty list that looks like "you have no servers".
   */
  folder: string | null;
  /** the session's name, for the subtitle — the folder alone is not what the
   *  user calls it */
  sessionTitle?: string;
  /**
   * The LIVE session under the active card, if it has one (#714).
   *
   * Reconnect needs it, and its absence is a real and common state: a suspended
   * card has servers to list and no session to type into. The pane says so
   * rather than offering a button that cannot work.
   */
  liveId?: string | null;
}

/** Scopes in the order the CLI resolves them: most specific first. */
const SCOPE_ORDER: readonly McpScope[] = ['project', 'local', 'user'];

/**
 * The status word for one row, and the ramp position it paints on.
 *
 * TWO FACTS, ONE COLUMN, and the precedence is the interesting part. Approval
 * BEATS health, because an unapproved `.mcp.json` server is one the CLI has
 * deliberately not connected to — reporting "not connected" for it would be
 * true and useless, describing the symptom instead of the cause. Health only
 * gets to speak once approval has nothing to say.
 *
 * Exported and pure so the precedence is unit-tested rather than asserted
 * through a rendered tree.
 */
export function rowStatus(
  server: McpServerWire,
  health: McpHealth
): { labelKey: string; token: 'connected' | 'failed' | 'pending' | 'disabled' | 'unknown' } {
  if (server.approval === 'pending') return { labelKey: 'mcp.statePending', token: 'pending' };
  if (server.approval === 'disabled') return { labelKey: 'mcp.stateDisabled', token: 'disabled' };
  if (health === 'connected') return { labelKey: 'mcp.stateConnected', token: 'connected' };
  if (health === 'failed') return { labelKey: 'mcp.stateFailed', token: 'failed' };
  return { labelKey: 'mcp.stateUnknown', token: 'unknown' };
}

/**
 * The status word for one RUNTIME row (#729).
 *
 * SIMPLER THAN `rowStatus` BECAUSE THERE IS NOTHING TO RECONCILE. That function
 * has to arbitrate between an approval state read from one file and a health
 * verdict scraped from a CLI's prose; this one is handed a single word by the
 * session that owns the connection. The precedence problem does not exist here,
 * which is most of the argument for sourcing the list this way.
 *
 * `pending` GETS ITS OWN TOKEN and reuses the needs-input hue — it is a server
 * mid-handshake, which is a "wait" rather than a "wrong", and it is on screen
 * for about five seconds of every fresh session. Painting it in the failure hue
 * would make a healthy session look broken on open.
 *
 * Exported and pure so the mapping is unit-tested rather than asserted through a
 * rendered tree, same as `rowStatus`.
 */
export function runtimeStatus(server: McpRuntimeServer): {
  labelKey: string;
  token: 'connected' | 'failed' | 'pending' | 'disabled' | 'unknown';
  /**
   * Which switch the row should offer — and it is decided HERE, beside the
   * label, because the two must never disagree.
   *
   * ⚠️ **THERE ARE TWO INDEPENDENT OFF-SWITCHES AND THEY SHARE A WORD.**
   * `disabledMcpjsonServers` is APPROVAL — you declined a server a repo brought
   * with it, and the way back is Reset approvals or the CLI's picker.
   * `disabledMcpServers` is THIS PR'S TOGGLE, and the way back is Turn on. Both
   * render as "turned off".
   *
   * A draft read the label from `approval` and the button from `status`, so a
   * row that was off BY APPROVAL showed "turned off" beside a **Turn off**
   * button and never offered Turn on. Pressing it added a second, unrelated
   * lock; pressing again cleared only that one, whereupon the approval label
   * reasserted itself and the button flipped back to Turn off — **an infinite
   * loop with the server never coming back.** Exactly the "state it cannot get
   * you out of" `mcp:remove` refuses to create. Found in review.
   *
   * So: `none` whenever APPROVAL decided the row. The toggle is not that
   * mechanism and must not pretend to be.
   */
  toggle: 'off' | 'on' | 'none';
} {
  // APPROVAL STILL BEATS CONNECTION STATE, exactly as `rowStatus` argues: an
  // unapproved `.mcp.json` server is one the CLI has deliberately not connected
  // to, and reporting "not connecting" for it is true and useless — the symptom
  // instead of the cause. The state comes from the config entry `merge.ts`
  // folded in, because `mcp_status` has no field for it. Review caught the
  // version without this: it silently dropped "waiting for your approval" from
  // the path most sessions are on.
  if (server.approval === 'pending') {
    return { labelKey: 'mcp.statePending', token: 'pending', toggle: 'none' };
  }
  if (server.approval === 'disabled') {
    return { labelKey: 'mcp.stateDisabled', token: 'disabled', toggle: 'none' };
  }
  if (server.status === 'disabled') {
    return { labelKey: 'mcp.stateDisabled', token: 'disabled', toggle: 'on' };
  }
  return { ...connectionWord(server.status), toggle: 'off' };
}

/**
 * Which sign-in controls a runtime row may offer (#734).
 *
 * THE GAP THIS CLOSES: #729 PR 2 shipped a `needs-auth` row state with nothing
 * behind it, so a connector that wants signing in said so and offered no way to
 * do it. Invisible on the dev machine, which has no connectors; live on a
 * machine that does.
 *
 * ── WHY `transport` IS THE GATE ──────────────────────────────────────────────
 *
 * Measured 2026-08-30 (`spike/probes/721/probe-mcp-auth.mjs`): both verbs refuse
 * a stdio server BY TYPE — `Server type "stdio" does not support OAuth
 * authentication` and `Cannot clear auth for server type "stdio"`. So sign-in on
 * a stdio row is a button that cannot work, and hiding it there is the whole of
 * the transport check. Everything else — `http`, `sse` and `unknown` — may
 * legitimately want it. `unknown` IS INCLUDED ON PURPOSE: it is what an absent
 * `config` reports, which is exactly the connector case this exists for.
 *
 * ── WHY SIGN IN IS OFFERED WIDER THAN `needs-auth` ───────────────────────────
 *
 * Because **`needs-auth` is itself an unverified guess.** `status.ts` maps it
 * speculatively and says so: no connector on the build machine ever produced
 * that word, so we do not actually know the CLI spells it that way. Gating the
 * only fix for this ticket on a string we have never seen would ship a feature
 * that is invisible in precisely the situation it was written for — the same
 * class of miss as the one that produced the ticket. `failed` and `unknown` are
 * where a connector wanting authorisation would otherwise land, so they get the
 * button too. The cost of being wrong is one extra button on a broken row; the
 * cost of being right and silent is another release with nothing behind the
 * label.
 *
 * ── SIGN OUT IS A RECOVERY CONTROL, NOT A GENERAL ONE ────────────────────────
 *
 * It appears only where signing in is also on offer, and that narrowness is the
 * point. **We cannot tell an OAuth-backed server from a header-backed one.** A
 * plain `http` server authenticated by `-H "Authorization: Bearer …"` is
 * `connected` and holds no OAuth credential at all; so is a builtin, which
 * reports no `config` and therefore reads as `unknown`. An earlier draft offered
 * Sign out on every connected remote row, which on the sixteen-server machine
 * this feature exists for meant a Sign out button on nearly all of them — most
 * having nothing to sign out of. Found in review.
 *
 * What it IS for: the success path of `mcp_authenticate` **cannot be exercised
 * on the machine this was written on**, so the first real attempt happens on a
 * user's laptop. If it half-completes, sign-out-then-in is the only recovery
 * that does not involve the CLI's credential store by hand — and there is
 * nobody upstream of the user to discover that for them.
 *
 * ── WHO GETS NOTHING, AND WHY ────────────────────────────────────────────────
 *
 * `connected` is a server that WORKS. Whatever is or is not stored for it, the
 * user has no problem to solve, and a control whose only effect is to break a
 * working row — with a repair path we have never seen succeed — is not one to
 * offer unasked. `pending` is mid-handshake, a five-second window on every fresh
 * session. `disabled` is a server the user switched off; the way back is Turn
 * on, and offering a second unrelated control there is how `runtimeStatus`
 * describes building a loop nobody can escape. And a row whose word came from
 * APPROVAL is behind a different lock entirely — the same precedence the toggle
 * already respects, for the same reason.
 *
 * Exported and pure so the table is unit-tested rather than asserted through a
 * rendered tree, same as `runtimeStatus` and `rowStatus`.
 */
export function authControls(server: McpRuntimeServer): { signIn: boolean; signOut: boolean } {
  const none = { signIn: false, signOut: false };
  // REFUSED BY TYPE — measured. Not a policy of ours to soften.
  if (server.transport === 'stdio') return none;
  // Approval is a different lock and this is not its key. Same rule, same
  // reasoning, as `runtimeStatus`'s `toggle: 'none'`.
  if (server.approval === 'pending' || server.approval === 'disabled') return none;
  switch (server.status) {
    // The row this ticket is about. Sign out rides along as the recovery path
    // for a flow that half-completes — see the docblock.
    case 'needs-auth':
      return { signIn: true, signOut: true };
    // The two words a connector wanting authorisation lands on if the CLI does
    // not spell it `needs-auth`. Sign out here too: a stale or rejected
    // credential is one honest reading of a remote server that will not connect,
    // and clearing it is the only thing this pane can do about that.
    case 'failed':
    case 'unknown':
      return { signIn: true, signOut: true };
    // `connected` (it works — leave it alone), `pending` (mid-handshake) and
    // `disabled` (the user's own switch).
    default:
      return none;
  }
}

/** The status word once approval has had its say — split out so `runtimeStatus`
 *  reads as the precedence rule it is. */
function connectionWord(status: McpRuntimeStatus): {
  labelKey: string;
  token: 'connected' | 'failed' | 'pending' | 'disabled' | 'unknown';
} {
  switch (status) {
    case 'connected':
      return { labelKey: 'mcp.stateConnected', token: 'connected' };
    case 'pending':
      return { labelKey: 'mcp.stateConnecting', token: 'pending' };
    case 'failed':
      return { labelKey: 'mcp.stateFailed', token: 'failed' };
    // What the CLI reports after `mcp_toggle` turns one off — measured. The
    // muted token, not a status hue: "you switched this off" is a state the
    // user chose, and painting it red would report their own decision as a
    // fault.
    case 'disabled':
      return { labelKey: 'mcp.stateDisabled', token: 'disabled' };
    case 'needs-auth':
      return { labelKey: 'mcp.stateNeedsAuth', token: 'pending' };
    default:
      return { labelKey: 'mcp.stateUnknown', token: 'unknown' };
  }
}

/** How many tool names a row spells out before it stops counting. */
const TOOL_PREVIEW = 5;

/**
 * The first few tool names, with a count for the rest.
 *
 * Exported and pure because the bound is the point: a server with 40 tools must
 * not turn its row into a paragraph, and asserting that through a rendered tree
 * would test the CSS rather than the rule.
 */
export function toolPreview(tools: readonly string[], limit = TOOL_PREVIEW): string {
  if (tools.length <= limit) return tools.join(', ');
  return `${tools.slice(0, limit).join(', ')} +${tools.length - limit}`;
}

/**
 * The order runtime scopes are listed in — most specific first, the same
 * principle `SCOPE_ORDER` uses, extended over the five scopes the config files
 * cannot express.
 *
 * `unknown` LAST AND STILL PRESENT. A scope a newer CLI grew is a server the
 * session really has, and dropping it from the render would reintroduce exactly
 * the invisibility #723 was filed about — one layer further in.
 */
const RUNTIME_SCOPE_ORDER: readonly McpRuntimeScope[] = [
  'project',
  'local',
  'user',
  'enterprise',
  'managed',
  'dynamic',
  'skills',
  'builtin',
  'unknown',
];

/**
 * The message for a mutation that did not work — the CLI's own words wherever
 * there are any.
 *
 * Exported and pure because it is the join between main's verdict vocabulary
 * and the user's, and asserting it through a rendered dialog would test React
 * rather than the mapping.
 */
export function failureMessage(
  result: Extract<McpMutationResult, { ok: false }>,
  t: (key: string, vars?: Record<string, unknown>) => string
): string {
  switch (result.reason) {
    // "MCP server sentry already exists in .mcp.json" names the exact file and
    // stays correct when the CLI changes its mind. We would write something worse.
    case 'cli-failed':
      return result.detail;
    case 'no-cli':
      return t('mcp.error.noCli');
    case 'timeout':
      return t('mcp.error.timeout');
    case 'invalid':
      return t(`mcp.form.error.${result.error.code}`, { at: result.error.at ?? '' });
    default:
      return t('mcp.error.refused');
  }
}

/**
 * A control-channel refusal, in the user's words.
 *
 * THE SIBLING OF `failureMessage`, NOT A REPLACEMENT: that one translates the
 * CLI-subprocess vocabulary (`no-cli`, `cli-failed`, a field error), this one
 * the control channel's (`not-stream`, `timed-out`, `session-gone`). The two
 * vocabularies describe genuinely different failures and the sentences differ —
 * "Claude Code isn't installed" and "this session can't be asked" are not the
 * same problem.
 *
 * `refused` PASSES THE CLI'S OWN SENTENCE THROUGH, on the same reasoning
 * `mcp/cli.ts` and `control-channel.ts` both record: it is the CLI's
 * explanation of its own refusal, and ours would be a guess at what it meant.
 *
 * Exported and pure, so the mapping is unit-tested rather than asserted through
 * a rendered tree.
 */
export function controlFailure(
  verdict: Extract<ControlVerdict, { ok: false }>,
  t: (key: string, vars?: Record<string, unknown>) => string,
  /**
   * A verb-specific sentence for `timed-out` — and #734 is why the seam exists.
   *
   * ⚠️ **THE CONTROL CHANNEL ALLOWS TEN SECONDS (`control-channel.ts`) AND A
   * SIGN-IN IS A HUMAN WALKING TO A BROWSER.** If the CLI's `mcp_authenticate`
   * blocks until the flow completes — plausible, and completely UNMEASURED,
   * because no connector exists on the machine this was built on — then every
   * real sign-in times out, and the default sentence tells the user their
   * session "may be busy or stuck". That is alarming, wrong, and looks exactly
   * like the feature being broken, for a flow that is proceeding normally.
   *
   * Every other verb here answers in milliseconds, so they keep the default.
   */
  timedOutKey?: string
): string {
  switch (verdict.reason) {
    case 'refused':
      return verdict.message || t('mcp.error.refused');
    case 'not-stream':
      return t('mcp.control.notStream');
    case 'session-gone':
      return t('mcp.reconnect.no-session');
    case 'timed-out':
      return t(timedOutKey ?? 'mcp.control.timedOut');
    case 'invalid':
      // SHARES THE SENTENCE, DELIBERATELY — but not by falling through, because
      // `invalid` is the one verdict that means OUR OWN guard fired rather than
      // the CLI refusing. It is what a dropped `enabled` looks like from here
      // (see `mcpToggleRequest`), so it is the single most useful thing to
      // recognise in a bug report about a server that turned itself off. The
      // user-facing wording is the same because "we could not run that, nothing
      // changed" is true and specific enough; the breadcrumb is for us.
      return t('mcp.error.refused');
    default:
      return t('mcp.error.refused');
  }
}

/**
 * The status ramp, reusing the app's existing status hues rather than minting a
 * palette only this pane knows about (§5.20 — the theme is the authority).
 *
 * TWO MAPS, NOT ONE, and #221 is why: the HUE is for dots, rings, tints and
 * edges, and the `-ink` variant is the same status tuned to clear AA as TEXT on
 * the surface it lands on. Writing a word in the raw hue is the defect that
 * issue was filed about, and `tokens.drift.test.ts` enforces it per component —
 * it caught this file on the first run.
 *
 * `disabled` and `unknown` are not status colours at all: they are the app's
 * ordinary muted text, because "we do not know" is the absence of a status
 * rather than a sixth one, and giving it a hue would make it shout.
 */
const TOKEN_HUE: Record<ReturnType<typeof rowStatus>['token'], string> = {
  connected: 'var(--status-done)',
  failed: 'var(--status-crashed)',
  pending: 'var(--status-needs-input)',
  disabled: 'var(--faint)',
  unknown: 'var(--faint)',
};

const TOKEN_INK: Record<ReturnType<typeof rowStatus>['token'], string> = {
  connected: 'var(--status-done-ink)',
  failed: 'var(--status-crashed-ink)',
  pending: 'var(--status-needs-input-ink)',
  disabled: 'var(--faint)',
  unknown: 'var(--faint)',
};

/**
 * How often to re-ask `mcp_status` while a server is still connecting, and how
 * many times.
 *
 * BOTH NUMBERS COME FROM THE MEASUREMENT, not from taste: the observed
 * `pending` → `connected` transition was between 2.0s and 5.0s on a freshly
 * spawned session. A 2s period sees it within one tick of settling; eight asks
 * gives ~16s, comfortably past the measured window without turning a genuinely
 * stuck server into an endless poll. Running out is not a failure — the row
 * keeps saying `pending`, which by then is the truth.
 */
const STATUS_POLL_MS = 2000;
const STATUS_POLL_LIMIT = 8;

/**
 * How long the pane keeps watching after a sign-in was requested (#734).
 *
 * ⚠️ **THE ORDINARY POLL CANNOT COVER THIS, AND SAYING IT DID WAS A LIE ABOUT
 * OUR OWN BEHAVIOUR.** `tick` re-schedules only while some row reports
 * `pending`, for at most `STATUS_POLL_LIMIT` asks — a bound tuned to the
 * measured 5-second handshake. A sign-in leaves the row on `needs-auth` (or
 * `failed`, or `unknown`) and hands the user to a BROWSER, so under that rule
 * the list asks exactly once, before they have clicked anything, and then never
 * again. The success sentence promised the list would update; it could not.
 *
 * A HUMAN OAUTH ROUND TRIP IS THE UNIT HERE, not a handshake: switch to the
 * browser, choose an account, read a consent screen, come back. A minute is
 * generous for that and cheap to spend — each ask is a control round trip
 * measured in milliseconds, not the twenty-second CLI spawn `checkHealth` costs.
 * It is BOUNDED rather than open-ended because a flow the user abandoned must
 * not leave a panel polling for the rest of the session, and because the honest
 * fallback — reopen the panel — is one click.
 *
 * The window is deliberately stated in the sentence the user reads, so the
 * promise and the code agree. If that number changes, change the string.
 */
const AUTH_WATCH_MS = 60_000;
const AUTH_POLL_LIMIT = Math.ceil(AUTH_WATCH_MS / STATUS_POLL_MS);

/** What the pane is doing right now, so two buttons cannot run at once and the
 *  one you pressed is the one that says "working". */
type Busy =
  | null
  | { kind: 'add' | 'reset' }
  /** Reconnect-all carries its progress, because it is the one action that
   *  makes N round trips and can legitimately take minutes. */
  | { kind: 'reconnect'; done?: number; total?: number }
  /** the per-row actions, keyed so the row you pressed is the one that says
   *  "working" — `remove` since #714, toggle/reconnect since #729 PR 2, the two
   *  auth controls since #734 */
  | {
      kind: 'remove' | 'toggle' | 'reconnectServer' | 'authenticate' | 'clearAuth';
      key: string;
    };

/** "this answer belongs to a sitting of the dialog that is over" — distinct
 *  from `null` (it worked) and from a string (it failed and here is why),
 *  because a stale call must produce NO user-visible outcome at all. */
const STALE = Symbol('stale');

export function McpManagerDialog(props: McpManagerDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const [inventory, setInventory] = React.useState<McpInventoryWire | null>(null);
  /**
   * The servers the SESSION really has (#729), or `null` when we could not ask.
   *
   * WHEN THIS IS NON-NULL IT IS THE LIST. The config inventory stays loaded
   * underneath it — it is what makes rows removable, and it is the fallback the
   * moment the session goes away — but it is not what gets drawn.
   */
  const [runtime, setRuntime] = React.useState<readonly McpRuntimeServer[] | null>(null);
  /** config-file servers this session has not loaded — see `notLoaded` in
   *  `main/mcp/merge.ts`. `mcp_status` is frozen at spawn, so this is where a
   *  server you added a moment ago actually appears. */
  const [notLoaded, setNotLoaded] = React.useState<readonly McpServerWire[]>([]);
  /**
   * Why the runtime list is what it is — and `null` means WE HAVE NOT ASKED YET.
   *
   * ── IT CARRIES ITS OWN KEY, AND THAT IS NOT DECORATION ─────────────────────
   *
   * The health check below spawns a CLI process that connects to every server
   * and is allowed twenty seconds, and it must not fire in the gap between the
   * dialog opening and `mcp_status` answering — on a live session that answer is
   * milliseconds away, so the spawn is pure waste.
   *
   * A bare reason could not express that. React runs both effects in the SAME
   * passive-effect flush, so on a folder switch the health effect's closure
   * still held the PREVIOUS render's reason: switching from a suspended card
   * (`no-session`) to a folder with a live session spawned the CLI anyway, on a
   * result that was then thrown away. Pairing the reason with the folder+session
   * it describes makes the stale read unrepresentable rather than merely
   * unlikely. Found in review.
   */
  const [status, setStatus] = React.useState<{
    key: string;
    reason: McpStatusWire['reason'];
  } | null>(null);
  const [health, setHealth] = React.useState<Readonly<Record<string, McpHealth>>>({});
  const [healthRan, setHealthRan] = React.useState(true);
  const [loading, setLoading] = React.useState(false);
  const [formOpen, setFormOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<Busy>(null);
  /** a one-line result from the last action — an error, or a confirmation that
   *  something invisible happened (reconnect on a terminal changes nothing on
   *  THIS screen, so saying nothing would read as a dead button) */
  const [notice, setNotice] = React.useState<{ bad: boolean; text: string } | null>(null);
  /** the row whose Remove is asking "are you sure" — no second modal, because a
   *  dialog on top of a dialog is where focus management goes to die */
  const [confirmRemove, setConfirmRemove] = React.useState<string | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);
  /**
   * Where focus goes when this closes — the house rule six other overlays keep
   * (`AboutPanel`, `CommandPalette`, `EventsDrawer`, `FindBar`,
   * `PushSetupDialog`, `QuietHoursDialog`).
   *
   * It matters more here than in any of them, because `/mcp` means focus was in
   * the COMPOSER a second ago: without this, Escape drops the user on `<body>`
   * and they have to mouse back into the prompt box they were typing in.
   */
  const returnFocusTo = React.useRef<HTMLElement | null>(null);

  const { open, folder } = props;
  /**
   * Bumped by every mutation, to re-read the config.
   *
   * RE-LISTS BUT DOES NOT RE-PROBE. The listing is two local file reads; the
   * health check spawns the CLI, connects to every configured server, and is
   * allowed twenty seconds to do it. Re-running it after each of three
   * removals would make the pane unusable for a minute to answer a question
   * nothing asked. The status column keeps whatever verdicts it already has —
   * which stay true for every row that did not change — and a row that was just
   * added has no verdict yet, which is what `unknown` already means.
   */
  const [generation, setGeneration] = React.useState(0);
  /**
   * The folder whose health we have already probed.
   *
   * A REF RATHER THAN A FLAG, because "is this the first load" has to survive a
   * folder change and a close-and-reopen, and comparing what we probed against
   * what we are showing answers all three without an ordering dependency
   * between effects. Cleared on close, so reopening always re-probes.
   */
  const probedFolder = React.useRef<string | null>(null);
  /**
   * The folder whose HEALTH we have spawned a CLI for.
   *
   * SEPARATE FROM `probedFolder` since #729, because the two questions came
   * apart. The listing now loads unconditionally while the health check waits to
   * find out whether `mcp_status` made it unnecessary — so one ref gating both
   * would either re-spawn the CLI on every re-list or block a health check that
   * had never actually run.
   */
  const healthProbed = React.useRef<string | null>(null);
  /** the folder+session the runtime answer on screen belongs to — see the status
   *  effect for why the reset lives there and not in a `[folder]` effect */
  const statusKey = React.useRef<string | null>(null);
  /**
   * Which "sitting" of the dialog we are in — bumped on every open/close and
   * every folder change.
   *
   * A MUTATION OUTLIVES THE DIALOG. `runMcp`'s timeout is ten seconds and the
   * dialog is closable throughout, so a Remove started on one session can
   * resolve after the user has closed it and reopened it on ANOTHER — and
   * without this, its `setNotice` paints "Removed sentry." over a project that
   * has no sentry. Reproduced in review. Clearing state on open (below) only
   * covers the mutation that resolved BEFORE the reopen; this covers the one
   * that resolves after, which is the same shape as the list effect's `live`
   * flag and folder echo.
   */
  const epoch = React.useRef(0);
  /**
   * When the post-sign-in watch window closes (#734) — a timestamp, or 0.
   *
   * A REF RATHER THAN STATE, deliberately: the status effect reads it, and
   * making it state would put it in that effect's dependency list, so setting it
   * would restart the very poll it exists to extend. The `generation` bump
   * `controlMutate` already does is what re-enters the effect; this only changes
   * how long the loop it starts is allowed to run. See `AUTH_WATCH_MS`.
   */
  const authWatchUntil = React.useRef(0);

  // THE LISTING AND THE HEALTH CHECK ARE TWO AWAITS, NOT ONE, and this is the
  // whole reason they are separate channels. The listing is two local file
  // reads; the health check connects to every configured server and can take
  // seconds when a remote endpoint sits behind a VPN that is off. Awaiting both
  // before the first paint would make "open the manager" hang on the state of
  // the user's network, which is precisely the failure this pane exists to
  // diagnose.
  //
  // So: draw from the config immediately, then let the status column fill in.
  React.useEffect(() => {
    if (!open || !folder) return;
    let live = true;
    // A RE-LIST AFTER A MUTATION IS NOT A RELOAD. `setLoading(true)` here would
    // replace the whole list with "Reading your configuration…" for a moment
    // after every removal — a flash, on a pane the user is reading.
    const probe = probedFolder.current !== folder;
    probedFolder.current = folder;
    if (probe) {
      setLoading(true);
      // THE PREVIOUS FOLDER'S INVENTORY GOES TOO. Without this, the unreadable
      // banner renders above the loading line for a frame — attributing another
      // project's broken `.mcp.json` to the one being opened.
      setInventory(null);
      setHealth({}); // a previous session's verdicts must not paint this one
      // ...AND SO MUST ITS `ok`. Leaving this at a stale `true` while the states
      // are cleared regresses to exactly the ambiguity `ok` was added to remove:
      // if the health call is refused or the bridge is missing, the effect
      // returns early, every row reads "status unknown", and nothing says the
      // check never happened. Cleared here, set only by an answer that arrives.
      setHealthRan(true);
    }
    void (async () => {
      // OPTIONAL ALL THE WAY DOWN, like every other bridge call in the app
      // (`App.tsx`'s shim exists because "a broken preload bridge must degrade,
      // not blank the window"). A `TypeError` here would be an unhandled
      // rejection AND would strand the pane on its loading line.
      const inv = answered(await window.switchboard?.mcp?.list?.(folder));
      // `live` guards the unmount; the FOLDER echo guards the switch — a slow
      // answer for the session the user has already left must not land on the
      // one they are looking at now (#650's `answered` handles the refusal
      // case, which degrades to "no servers" rather than throwing behind a
      // modal).
      if (!live) return;
      // LOADING ENDS ON EVERY PATH, not just the happy one. Review caught this:
      // `setLoading(false)` sat after the guards, so a refusal, a stale echo or
      // a missing bridge left the dialog reading "Reading your configuration…"
      // for ever with no way out but close-and-reopen. A test that only
      // asserted "no rows" passed while doing exactly that.
      setLoading(false);
      if (!inv || inv.folder !== folder) return;
      setInventory(inv);
    })();
    return () => {
      live = false;
    };
  }, [open, folder, generation]);

  /**
   * The real inventory, over the session's control channel (#729).
   *
   * ── IT ASKS AGAIN WHILE ANYTHING IS `pending` ──────────────────────────────
   *
   * Because the answer SETTLES. Measured on a freshly spawned session
   * (`spike/probes/721/probe-mcp-settle.mjs`): `pending` with no tool list at
   * 0.9s, `connected` with `serverInfo` and three tools at 5.0s. Asking once, on
   * open, is therefore a design that shows the user a worse answer than the one
   * available two seconds later — every server greyed and toolless, on a session
   * that is perfectly healthy.
   *
   * BOUNDED, AND IT STOPS ON ITS OWN. A server that is genuinely stuck
   * connecting stays `pending` for ever, and a poll with no cap would sit there
   * re-asking until the user closed the dialog. `pending` is a state this pane
   * DRAWS (see `runtimeStatus`), so giving up on it costs nothing but the
   * refresh — the row keeps saying `pending`, which by then is the truth rather
   * than a stale first look.
   *
   * A warm session — which is nearly every session, since cards live for hours —
   * answers `connected` on the first ask and never enters this loop at all.
   */
  React.useEffect(() => {
    if (!open || !folder) return;
    const liveId = props.liveId;
    // THE PREVIOUS SESSION'S SERVERS GO FIRST, and this effect does it rather
    // than a `[folder]` effect beside it. React runs effects in declaration
    // order, so a separate reset declared LATER clears what this one has just
    // set — which is invisible for the async answer and fatal for the
    // synchronous `no-session` branch below. Caught by its own test.
    //
    // KEYED, so it does not fire on a `generation` bump: a re-list after a
    // removal must not blank sixteen rows and re-fetch them, which is the same
    // flash the list effect's `probe` flag exists to prevent.
    const key = `${folder}|${liveId ?? ''}`;
    if (statusKey.current !== key) {
      statusKey.current = key;
      setRuntime(null);
      setNotLoaded([]);
      setStatus(null);
    }
    if (!liveId) {
      // A suspended card. Not an error and not a gap: the config files are the
      // only source it has, and `no-session` is what makes the pane SAY so
      // rather than drawing a subset as though it were everything.
      setRuntime(null);
      setNotLoaded([]);
      setStatus({ key, reason: 'no-session' });
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // PER EFFECT RUN, not per sitting: a `generation` bump after a removal
    // re-enters here and refreshes the budget. Deliberate — a mutation is a
    // reason to look again, and the bound exists to stop an idle poll running
    // for ever, not to ration deliberate refreshes.
    let asked = 0;
    const tick = async (): Promise<void> => {
      // GUARDED, because `mutate` is and this was not. A bridge that throws
      // would otherwise leave `status` at `null` FOR EVER — which since the
      // restructure also permanently blocks the health fallback, so the pane
      // would sit with no runtime list and no status column and no explanation.
      let res: McpStatusWire | undefined;
      try {
        res = answered(await window.switchboard?.mcp?.status?.(folder, liveId));
      } catch {
        res = undefined;
      }
      if (!live) return;
      asked += 1;
      // The SESSION echo, for the same reason the list effect checks the folder:
      // an answer for the card the user has already left must not paint the one
      // they are looking at now.
      if (!res || res.sessionId !== liveId) {
        setStatus({ key, reason: 'unavailable' });
        return;
      }
      setStatus({ key, reason: res.reason });
      // A FAILURE LEAVES THE LIST ALONE — no `else`, on purpose. A single
      // timed-out poll (the channel gets ten seconds) would otherwise swap
      // sixteen rows the user is reading for the three-row config subset, put
      // the #723 footer back, and arm the health spawn, all for a blip. Nothing
      // was learned about the servers, so nothing about them changes; the
      // reason above still updates, so the pane can say it is out of touch.
      if (res.reason === 'ok') {
        setRuntime(res.servers);
        setNotLoaded(res.notLoaded);
      }
      // WATCHING FOR A SIGN-IN IS ITS OWN REASON TO KEEP ASKING (#734), and it
      // has to be, because the row a sign-in was requested for is NOT `pending`
      // — it sits on `needs-auth` while the user is off in a browser. Under the
      // handshake rule alone this loop stops after one ask, which made the
      // success sentence's promise that "this list updates" false. See
      // `AUTH_WATCH_MS`.
      const watching = Date.now() < authWatchUntil.current;
      if (res.reason !== 'ok' || asked >= (watching ? AUTH_POLL_LIMIT : STATUS_POLL_LIMIT)) return;
      if (!watching && !res.servers.some((s) => s.status === 'pending')) return;
      timer = setTimeout(() => void tick(), STATUS_POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [open, folder, props.liveId, generation]);

  /**
   * The health check — now the FALLBACK rather than the first move (#729).
   *
   * IT ONLY RUNS WHEN `mcp_status` COULD NOT. That is the whole saving: this
   * spawns a CLI, connects to every configured server and is allowed twenty
   * seconds to do it, and for a live Direct session the control channel has
   * already answered the same question in milliseconds — with a status per
   * server that did not have to be scraped out of prose and matched on glyphs.
   *
   * IT DID NOT GO AWAY, and #729's summary line saying `mcp_status` retires it
   * is true only for a live session. A SUSPENDED CARD has no control channel and
   * this is its only status source; deleting it would have cost those cards a
   * column they have today, which is a regression traded for a tidiness win.
   *
   * WAITS FOR A REAL REASON, AND FOR ONE ABOUT THIS FOLDER. A null `status` is
   * a call still in flight, and firing a twenty-second process spawn into that
   * gap is exactly the cost this restructuring exists to avoid. The KEY check
   * beside it is what makes that hold across a folder switch: both effects run
   * in one flush, so without it this one reads the previous render's reason and
   * spawns on a folder whose session was about to answer. See `status`.
   */
  React.useEffect(() => {
    if (!open || !folder) return;
    const key = `${folder}|${props.liveId ?? ''}`;
    if (!status || status.key !== key || status.reason === 'ok') return;
    // ⚠️ UNDER StrictMode IN DEV THIS RUNS ONCE, NOT TWICE, and the once it
    // skips is the real one: the ref is set BEFORE the await, so the
    // mount→cleanup→mount cycle finds it already claimed and returns early.
    // Inherited from `probedFolder`, not introduced here — but the health check
    // is now reachable ONLY through this effect, so under `npm run dev` a
    // suspended card's status column can look permanently broken when it is
    // fine in a packaged build. Worth knowing before hand-testing that case.
    if (healthProbed.current === key) return;
    healthProbed.current = key;
    let live = true;
    void (async () => {
      const h = answered(await window.switchboard?.mcp?.health?.(folder));
      if (!live) return;
      // A REFUSED OR ABSENT ANSWER IS `ok: false`, not silence. Without this the
      // early return leaves `healthRan` true and the pane claims a check it
      // never got.
      if (!h || h.folder !== folder) {
        setHealthRan(false);
        return;
      }
      setHealth(h.states);
      // `ok: false` means the check never ran (#714). Saying that ONCE at the
      // bottom is honest; stamping every row `status unknown` and staying quiet
      // about the reason is what this replaces.
      setHealthRan(h.ok);
    })();
    return () => {
      live = false;
    };
  }, [open, folder, props.liveId, status, generation]);

  React.useEffect(() => {
    if (!props.open) return;
    // remembered BEFORE we take focus, or we would remember ourselves
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

  // A DIALOG FORGETS ITS TRANSIENT STATE ON EVERY TRANSITION, not just on
  // close. Without this, reopening lands you back in a half-filled add form, or
  // on a "are you sure?" for a row that may not exist any more.
  //
  // ON OPEN AS WELL AS ON CLOSE, and the close-only version had a real hole: a
  // mutation resolving AFTER the user closed the dialog still ran its
  // `setNotice`, so reopening — possibly on a different session — greeted them
  // with "Removed sentry." about something they did elsewhere.
  React.useEffect(() => {
    epoch.current += 1; // anything still in flight belongs to the last sitting
    setFormOpen(false);
    setNotice(null);
    setConfirmRemove(null);
    setConfirmReset(false);
    setBusy(null);
    // ...and the sign-in watch is a sitting's business too (#734). A window left
    // open across a close would have the next sitting polling every two seconds
    // for the remainder, about a request the user has walked away from.
    authWatchUntil.current = 0;
    // ...and reopening re-probes health, because the answer is minutes old at
    // best and the whole reason it is a separate call is that it goes stale.
    if (!props.open) {
      probedFolder.current = null;
      healthProbed.current = null;
      statusKey.current = null; // so reopening re-asks rather than trusting the last sitting
      // AND THE RUNTIME ANSWER GOES TOO. It is the stalest of the three: a
      // session can gain a connector, lose a plugin or be restarted between two
      // sittings, and reopening onto the previous list would show servers this
      // session may no longer have. `null` means "not asked", which is what is
      // actually true at that moment.
      setRuntime(null);
      setNotLoaded([]);
      setStatus(null);
    }
  }, [props.open]);

  // A folder switch is a new sitting too: a mutation aimed at the session the
  // user just left must not report against the one they are looking at now.
  React.useEffect(() => {
    epoch.current += 1;
    // ...AND THE SPINNER STOPS. Every in-flight action bails on an epoch
    // mismatch WITHOUT clearing `busy` — correct, because the sitting that owns
    // the screen should own the spinner — but only the open/close effect above
    // was actually clearing it. A folder switch mid-action therefore stranded
    // `busy` forever, and every button in the pane is `disabled={busy !== null}`.
    //
    // Reconnect-all makes that a minutes-long window rather than a
    // milliseconds-long one: N servers × a 10s control timeout, with the dialog
    // closable and the active session changeable throughout. Found in review.
    setBusy(null);
    // The sign-in watch belonged to the folder we just left (#734).
    authWatchUntil.current = 0;
  }, [folder]);

  if (!props.open) return null;

  const close = (): void => {
    props.onClose();
    // ...on the NEXT frame, because this element is still mounted and still
    // holds focus until React has committed the unmount — the same shape the
    // other six overlays use.
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };
  const servers = inventory?.servers ?? [];
  const hasProject = servers.some((s) => s.scope === 'project');

  /**
   * Run one mutation and re-list.
   *
   * ALWAYS RE-LISTS, EVEN ON FAILURE, and that is deliberate: `mcp add` can
   * fail *because* the server is already there, and a pane that keeps showing
   * the stale list beside "already exists" is telling the user two things that
   * contradict each other. Re-reading the config is cheap (two file reads) and
   * is the only thing that can be trusted after a write we did not make
   * ourselves.
   */
  const mutate = async (
    what: NonNullable<Busy>,
    call: () => Promise<McpMutationResult | undefined> | undefined
  ): Promise<string | null | typeof STALE> => {
    const mine = epoch.current;
    setBusy(what);
    setNotice(null);
    try {
      const result = answered(await call());
      // EVERY WRITE BELOW IS GUARDED, not just the notice: a `setGeneration`
      // bump aimed at the folder the user has left would re-list the one they
      // are on now for a reason that has nothing to do with it.
      if (mine !== epoch.current) return STALE;
      setGeneration((g) => g + 1);
      if (result?.ok) return null;
      // A MISSING BRIDGE OR A REFUSAL IS NOT SILENCE. `answered` degrades a
      // refused channel to `undefined`, which without this line would look
      // exactly like success and leave the user staring at an unchanged list.
      return result ? failureMessage(result, t) : t('mcp.error.refused');
    } catch {
      // main resolves rather than rejecting, so this is the broken-preload
      // case — the same one `App.tsx`'s shim exists for.
      if (mine !== epoch.current) return STALE;
      setGeneration((g) => g + 1);
      return t('mcp.error.refused');
    } finally {
      // ...but the spinner always stops, even for a stale call: `setBusy` on an
      // unmounted or reset dialog is a no-op, and leaving it out would strand
      // the CURRENT sitting's buttons if the epochs happened to match.
      if (mine === epoch.current) setBusy(null);
    }
  };

  const doAdd = async (request: McpAddRequest): Promise<string | null> => {
    if (!folder) return t('mcp.error.refused');
    const problem = await mutate({ kind: 'add' }, () =>
      window.switchboard?.mcp?.add?.(folder, request)
    );
    // the dialog moved on under this call — say nothing, anywhere
    if (problem === STALE) return null;
    if (!problem) {
      setFormOpen(false);
      setNotice({ bad: false, text: t('mcp.added', { name: request.name }) });
    }
    return problem;
  };

  const doRemove = async (s: McpServerWire): Promise<void> => {
    if (!folder) return;
    setConfirmRemove(null);
    const problem = await mutate({ kind: 'remove', key: `${s.scope}:${s.name}` }, () =>
      // THE ROW'S OWN SCOPE, never inferred: the CLI's scopeless remove deletes
      // from "whichever scope has it", and this pane deliberately lists one
      // name twice when two scopes define it.
      window.switchboard?.mcp?.remove?.(folder, s.name, s.scope)
    );
    if (problem === STALE) return;
    setNotice(
      problem ? { bad: true, text: problem } : { bad: false, text: t('mcp.removed', { name: s.name }) }
    );
  };

  /**
   * Remove a RUNTIME row (#729).
   *
   * `removeScope`, NOT `s.scope`, AND THE TYPE IS WHAT ENFORCES IT. The runtime
   * scope vocabulary has eight values and `claude mcp remove -s` accepts three;
   * a row the CLI resolved as `dynamic` may be backed by a `user`-scope
   * definition, and `remove -s dynamic` is not a call that means anything. Main
   * carries the write-side scope across on the wire precisely so the renderer
   * never has to narrow one vocabulary into the other.
   *
   * ITS ABSENCE IS A BUG, NOT A CASE. `readOnly` false without a `removeScope`
   * cannot happen — `enrichRuntime` sets both from the same match — so this
   * returns rather than guessing at `local`, which would delete from a scope
   * nobody named.
   */
  const doRemoveRuntime = async (s: McpRuntimeServer): Promise<void> => {
    if (!folder || s.readOnly || !s.removeScope) return;
    setConfirmRemove(null);
    const scope = s.removeScope;
    const problem = await mutate({ kind: 'remove', key: `${s.scope}:${s.name}` }, () =>
      window.switchboard?.mcp?.remove?.(folder, s.name, scope)
    );
    if (problem === STALE) return;
    setNotice(
      problem ? { bad: true, text: problem } : { bad: false, text: t('mcp.removed', { name: s.name }) }
    );
  };

  /**
   * Run one control-channel mutation and re-ask for the list.
   *
   * SEPARATE FROM `mutate`, and not a duplicate of it: that one speaks
   * `McpMutationResult` (the CLI-subprocess vocabulary — `no-cli`,
   * `cli-failed`, a field error), these speak `ControlVerdict` (the
   * control-channel vocabulary — `not-stream`, `timed-out`, `session-gone`).
   * Collapsing them would mean one function with two result types and a
   * discriminator, which is more code than the shared five lines are worth.
   */
  const controlMutate = async (
    what: NonNullable<Busy>,
    call: () => Promise<ControlVerdict | undefined> | undefined,
    /** a verb-specific `timed-out` sentence — see `controlFailure` (#734) */
    timedOutKey?: string
  ): Promise<string | null | typeof STALE> => {
    const mine = epoch.current;
    setBusy(what);
    setNotice(null);
    try {
      const verdict = answered(await call());
      if (mine !== epoch.current) return STALE;
      // ALWAYS RE-ASKS, even on failure — the same argument `mutate` makes.
      // A toggle that half-worked must not leave the pane showing the state we
      // hoped for; `mcp_status` is the only thing that knows.
      setGeneration((g) => g + 1);
      if (verdict?.ok) return null;
      // The CLI's own sentence wherever there is one. `answered` degrades a
      // refused channel to `undefined`, which without this line looks exactly
      // like success.
      return verdict ? controlFailure(verdict, t, timedOutKey) : t('mcp.error.refused');
    } catch {
      if (mine !== epoch.current) return STALE;
      setGeneration((g) => g + 1);
      return t('mcp.error.refused');
    } finally {
      if (mine === epoch.current) setBusy(null);
    }
  };

  /**
   * Turn one server on or off.
   *
   * ⚠️ `enabled` IS PASSED EXPLICITLY, never derived by negating something
   * optional. The CLI reads an ABSENT `enabled` as "disable" and answers
   * success (measured), so anywhere a `boolean | undefined` could reach the
   * wire is a place a server gets silently switched off. The caller computes it
   * from the row's own status and passes a literal.
   */
  const doToggle = async (s: McpRuntimeServer, enabled: boolean): Promise<void> => {
    if (!folder || !props.liveId) {
      setNotice({ bad: true, text: t('mcp.reconnect.no-session') });
      return;
    }
    const liveId = props.liveId;
    const problem = await controlMutate({ kind: 'toggle', key: `${s.scope}:${s.name}` }, () =>
      window.switchboard?.mcp?.toggle?.(folder, liveId, s.name, enabled)
    );
    if (problem === STALE) return;
    setNotice(
      problem
        ? { bad: true, text: problem }
        : {
            bad: false,
            // NOT "for this session". Measured: the toggle writes
            // `disabledMcpServers` into `~/.claude.json` and survives a
            // restart, so saying otherwise would be a lie the user only finds
            // out about tomorrow.
            text: t(enabled ? 'mcp.toggledOn' : 'mcp.toggledOff', { name: s.name }),
          }
    );
  };

  /**
   * Reconnect ONE server over the control channel.
   *
   * Takes a bare name rather than a row, because it serves two different
   * lists: a runtime row that dropped, and a `notLoaded` row the session has
   * never seen. Measured to work for both — the second is the finding that
   * lets this replace "restart the session".
   */
  const doReconnectServer = async (name: string, key: string): Promise<void> => {
    if (!folder || !props.liveId) {
      setNotice({ bad: true, text: t('mcp.reconnect.no-session') });
      return;
    }
    const liveId = props.liveId;
    const problem = await controlMutate({ kind: 'reconnectServer', key }, () =>
      window.switchboard?.mcp?.reconnectServer?.(folder, liveId, name)
    );
    if (problem === STALE) return;
    setNotice(
      problem
        ? { bad: true, text: problem }
        : { bad: false, text: t('mcp.reconnectedServer', { name }) }
    );
  };

  /**
   * Start a server's OAuth sign-in (#734).
   *
   * ⚠️ **SUCCESS IS NOT REPORTED AS "SIGNED IN", AND THAT IS THE WHOLE CARE IN
   * THIS FUNCTION.** The success payload of `mcp_authenticate` has never been
   * observed — there is no claude.ai connector on the machine this was built on,
   * so only its refusals are measured. Saying "Signed in." on an `ok: true` we
   * do not understand would be the app inventing an outcome, which is the one
   * thing §4 rules out. The sentence says the request was accepted and tells the
   * user where to look, which is true whatever the CLI actually did.
   *
   * The status watch afterwards is what turns a real sign-in into a visible one:
   * if the row leaves `needs-auth`, the list says so on its own rather than
   * because we claimed it. **The window is opened BEFORE the call**, not after
   * it — `controlMutate` bumps `generation`, which re-enters the status effect,
   * and a ref set after the await would race that re-entry. Starting the clock a
   * few milliseconds early costs nothing against a sixty-second window.
   */
  const doAuthenticate = async (s: McpRuntimeServer): Promise<void> => {
    if (!folder || !props.liveId) {
      setNotice({ bad: true, text: t('mcp.reconnect.no-session') });
      return;
    }
    const liveId = props.liveId;
    authWatchUntil.current = Date.now() + AUTH_WATCH_MS;
    const problem = await controlMutate(
      { kind: 'authenticate', key: `${s.scope}:${s.name}` },
      () => window.switchboard?.mcp?.authenticate?.(folder, liveId, s.name),
      // The ten-second channel timeout against a human in a browser — see
      // `controlFailure`. A generic "busy or stuck" here would report a flow
      // that is going fine as a fault.
      'mcp.signInTimedOut'
    );
    if (problem === STALE) return;
    // A REFUSAL CLOSES THE WINDOW AGAIN — nothing was started, so there is
    // nothing to watch for, and leaving it open would spend a minute of round
    // trips re-asking about a request the CLI declined.
    //
    // ⚠️ **A TIMEOUT IS NOT A REFUSAL, AND IS THE CASE WATCHING EXISTS FOR.**
    // If the CLI blocks for the length of the browser flow, ten seconds elapse
    // and we hear nothing — while the sign-in is proceeding perfectly well.
    // Closing the watch there would abandon the one outcome we most want to
    // catch. Recognised by the sentence because `controlMutate` hands back
    // prose rather than the verdict; the alternative was widening its return
    // type for one caller.
    const timedOut = problem === t('mcp.signInTimedOut');
    if (problem && !timedOut) authWatchUntil.current = 0;
    setNotice(
      problem
        ? { bad: true, text: problem }
        : { bad: false, text: t('mcp.signInStarted', { name: s.name }) }
    );
  };

  /**
   * Forget a server's stored credentials.
   *
   * THE ESCAPE HATCH FOR A ROW THAT IS ALREADY NOT WORKING. `authControls`
   * keeps it off `connected` rows entirely, which is what makes a single
   * unconfirmed click safe enough: every row that offers it is one the user
   * already cannot use. That matters more here than it would elsewhere, because
   * the way BACK is `mcp_authenticate`, whose success path is precisely what
   * nobody has been able to verify — so an accidental sign-out of a working
   * connector could be unrecoverable from inside this pane. Review caught that
   * argument being made backwards.
   */
  const doClearAuth = async (s: McpRuntimeServer): Promise<void> => {
    if (!folder || !props.liveId) {
      setNotice({ bad: true, text: t('mcp.reconnect.no-session') });
      return;
    }
    const liveId = props.liveId;
    const problem = await controlMutate({ kind: 'clearAuth', key: `${s.scope}:${s.name}` }, () =>
      window.switchboard?.mcp?.clearAuth?.(folder, liveId, s.name)
    );
    if (problem === STALE) return;
    setNotice(
      problem
        ? { bad: true, text: problem }
        : { bad: false, text: t('mcp.signedOut', { name: s.name }) }
    );
  };

  const doReset = async (): Promise<void> => {
    if (!folder) return;
    setConfirmReset(false);
    const problem = await mutate({ kind: 'reset' }, () =>
      window.switchboard?.mcp?.resetApprovals?.(folder)
    );
    if (problem === STALE) return;
    setNotice(problem ? { bad: true, text: problem } : { bad: false, text: t('mcp.approvalsReset') });
  };

  /**
   * Reconnect — and the honest part is that MAIN decides what it means.
   *
   * §5.17 says it "injects `/mcp` into that session's input route — we type,
   * not fake". True on the Terminal transport, where the CLI's picker opens in
   * a terminal the user is looking at. On Direct there is no terminal, so the
   * same keystrokes would open a picker nobody can see and leave the session
   * sitting there — the exact dead end this dialog exists to remove. Main sends
   * NOTHING in that case and answers `restart-required`; the renderer must not
   * second-guess it, and must not route this through `sendSessionCommand`,
   * which is deliberately blind to transports.
   */
  const doReconnect = async (): Promise<void> => {
    // ── THE CONTROL-CHANNEL PATH FIRST (#729 PR 2) ────────────────────────────
    //
    // `runtime` being non-null means this session answered `mcp_status`, which
    // means it has a control channel, which means `restart-required` — the
    // answer #714 had to give — is no longer the truth for it. Reconnect every
    // server we know about instead: the runtime rows (a dropped one comes back)
    // and the not-loaded ones (measured to be pulled IN by the same verb).
    //
    // SEQUENTIAL, NOT `Promise.all`. Round trips are milliseconds, and each one
    // makes the CLI stand up a server process; firing sixteen at once to save
    // ~20ms would be a burst of subprocess spawns for no gain the user can see.
    if (runtime && folder && props.liveId) {
      const liveId = props.liveId;
      // ── WHAT IS *NOT* IN THIS LIST ────────────────────────────────────────
      //
      // SERVERS THE USER TURNED OFF, and that is measured rather than cautious:
      // `mcp_reconnect` against a disabled server RE-ENABLES it
      // (`probe-toggle-reconnect-interaction.mjs`, disabled → reconnect →
      // connected). Without this filter, one press of Reconnect all silently
      // undoes every toggle in the pane — the exact inverse of the persistence
      // this PR was built to honour. Approval-disabled rows go too: their lock
      // is a different one and this verb is not its key.
      //
      // DEDUPLICATED, because `config.ts` deliberately does not: one name in two
      // scopes is two rows, and reconnecting it twice would double the round
      // trips and the total the notice reports.
      const names = [
        ...new Set(
          [...runtime, ...notLoaded]
            .filter((s) => !('status' in s && s.status === 'disabled'))
            .filter((s) => s.approval !== 'disabled')
            .map((s) => s.name)
        ),
      ];
      if (names.length === 0) {
        setNotice({ bad: false, text: t('mcp.reconnectedNone') });
        return;
      }
      const mine = epoch.current;
      setNotice(null);
      let failed = 0;
      let done = 0;
      for (const name of names) {
        // PROGRESS IN THE LABEL. Sixteen servers with two dead endpoints is
        // over two minutes of a frozen dialog behind a static "Reconnecting…",
        // and this pane refuses that trade everywhere else (the list draws
        // before the status column; the settle poll is bounded). Cheap to say
        // "3 of 16" and it turns a hang into a wait.
        setBusy({ kind: 'reconnect', done, total: names.length });
        try {
          const verdict = answered(
            await window.switchboard?.mcp?.reconnectServer?.(folder, liveId, name)
          );
          if (!verdict?.ok) failed += 1;
        } catch {
          failed += 1;
        }
        done += 1;
        // ABANDON THE REST if the dialog moved on — sixteen round trips is long
        // enough for the user to have closed it or switched session. `busy` is
        // cleared by the open/close and folder effects, so bailing here cannot
        // strand the buttons.
        if (mine !== epoch.current) return;
      }
      setGeneration((g) => g + 1);
      setBusy(null);
      // THE COUNT IS THE MESSAGE, so it has to be the RIGHT count: `count` is
      // the number that CAME BACK, not the total. Review caught it reporting
      // the total — "Reconnected 16 servers, but 4 didn't come back" is a
      // sentence that argues with itself, and the all-failed case read
      // "Reconnected 3 servers, but 3 didn't come back".
      setNotice(
        failed === 0
          ? { bad: false, text: t('mcp.reconnectedAll', { count: names.length }) }
          : {
              bad: true,
              text: t('mcp.reconnectedSome', { failed, count: names.length - failed }),
            }
      );
      return;
    }
    if (!folder || !props.liveId) {
      // the SAME sentence main answers for a card whose session is not running
      // — there is one fact here and it should not have two wordings
      setNotice({ bad: true, text: t('mcp.reconnect.no-session') });
      return;
    }
    const mine = epoch.current;
    setBusy({ kind: 'reconnect' });
    setNotice(null);
    try {
      const result = answered(await window.switchboard?.mcp?.reconnect?.(folder, props.liveId));
      if (mine !== epoch.current) return; // a later sitting owns the screen now
      const outcome = result?.outcome ?? 'refused';
      setNotice({
        bad: outcome !== 'typed',
        text: t(`mcp.reconnect.${outcome}`),
      });
    } catch {
      if (mine !== epoch.current) return;
      setNotice({ bad: true, text: t('mcp.error.refused') });
    } finally {
      if (mine === epoch.current) setBusy(null);
    }
  };

  const row = (s: McpServerWire): React.JSX.Element => {
    const state = rowStatus(s, health[s.name] ?? 'unknown');
    const key = `${s.scope}:${s.name}`;
    const removing = busy?.kind === 'remove' && busy.key === key;
    // The KEY carries the scope: the same name may legitimately appear in two
    // scopes (`config.ts` does not deduplicate, on purpose — showing the
    // collision is what the manager is for), so a name-only key would collapse
    // two real rows into one.
    return (
      <div
        key={key}
        data-mcp-server={s.name}
        data-mcp-scope={s.scope}
        data-mcp-state={state.token}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '7px 14px',
          borderBlockStart: '1px solid var(--border)',
        }}
      >
        <span
          aria-hidden
          style={{
            inlineSize: 7,
            blockSize: 7,
            borderRadius: '50%',
            background: TOKEN_HUE[state.token],
            flexShrink: 0,
            alignSelf: 'center',
          }}
        />
        <div style={{ minInlineSize: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</div>
          {/* the command or the endpoint — never the credentials */}
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {/* `filter(Boolean)`: an empty target with args would otherwise
                render a leading space, and the `||` fallback only catches the
                both-empty case */}
            {[s.target, ...s.args].filter(Boolean).join(' ') || t('mcp.noCommand')}
          </div>
          {/* THE NAMES of what it carries, so "is my key configured?" is
              answerable without opening a config file — and without the value
              ever crossing the IPC boundary. */}
          {(s.envKeys.length > 0 || s.headerKeys.length > 0) && (
            <div style={{ fontSize: 10, color: 'var(--faint)', marginBlockStart: 2 }}>
              {t('mcp.carries', { keys: [...s.envKeys, ...s.headerKeys].join(', ') })}
            </div>
          )}
          {/* THE HAND-OFF, on the row it applies to. There is no approve verb;
              what there is, is the CLI's own picker, and Reconnect is how you
              get to it. Saying so here beats a state word the user cannot act on. */}
          {s.approval === 'pending' && (
            <div style={{ fontSize: 10, color: 'var(--status-needs-input-ink)', marginBlockStart: 2 }}>
              {t('mcp.approveHint')}
            </div>
          )}
        </div>
        {/* the INK and not the hue (#221): this is a word */}
        <span style={{ fontSize: 10.5, color: TOKEN_INK[state.token], flexShrink: 0 }}>
          {t(state.labelKey)}
        </span>
        {confirmRemove === key ? (
          <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            {/* GUARDED LIKE THE BUTTON THAT REVEALED IT. Without this, pressing
                Reconnect and then "Remove it" starts a second mutation whose
                `setBusy` clobbers the first one's spinner. */}
            <Btn
              onClick={() => void doRemove(s)}
              disabled={busy !== null}
              title={t('mcp.removeConfirmTitle')}
            >
              {t('mcp.removeConfirm')}
            </Btn>
            <Btn onClick={() => setConfirmRemove(null)}>{t('mcp.form.cancel')}</Btn>
          </span>
        ) : (
          <Btn
            onClick={() => setConfirmRemove(key)}
            disabled={busy !== null}
            title={t('mcp.removeTitle', { name: s.name })}
          >
            {removing ? t('mcp.removing') : t('mcp.remove')}
          </Btn>
        )}
      </div>
    );
  };

  /**
   * One row of the RUNTIME list (#729).
   *
   * Deliberately a sibling of `row` rather than a generalisation of it. The two
   * describe different things — a config row has an approval state, arguments
   * and a source file; a runtime row has a live status, a version and a tool
   * list — and the shape that covered both would be a union with six optional
   * fields whose combinations nothing enforces. They share the styling, which is
   * the part that actually has to match.
   */
  const runtimeRow = (s: McpRuntimeServer): React.JSX.Element => {
    const state = runtimeStatus(s);
    const auth = authControls(s);
    const key = `${s.scope}:${s.name}`;
    const removing = busy?.kind === 'remove' && busy.key === key;
    return (
      <div
        key={key}
        data-mcp-server={s.name}
        data-mcp-scope={s.scope}
        data-mcp-state={state.token}
        data-mcp-readonly={s.readOnly ? '' : undefined}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          padding: '7px 14px',
          borderBlockStart: '1px solid var(--border)',
        }}
      >
        <span
          aria-hidden
          style={{
            inlineSize: 7,
            blockSize: 7,
            borderRadius: '50%',
            background: TOKEN_HUE[state.token],
            flexShrink: 0,
            alignSelf: 'center',
          }}
        />
        <div style={{ minInlineSize: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {s.name}
            {/* The server's own version, once it has connected. Absent for the
                whole pending window — see `McpRuntimeStatus`. */}
            {s.version && (
              <span style={{ fontWeight: 400, color: 'var(--faint)', marginInlineStart: 6 }}>
                {s.version}
              </span>
            )}
          </div>
          <div
            style={{
              fontSize: 10.5,
              color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {s.target || t('mcp.noCommand')}
          </div>
          {/* THE FACT NO CONFIG FILE HOLDS, and the reason this list is worth a
              round trip: "which of my sixteen servers is actually giving me
              tools" was unanswerable from the files.

              BOUNDED, because the count is not small. The GitHub MCP server
              exposes 40+ tools, and joining them all into an unclipped div
              turns one row into a paragraph — on exactly the sixteen-server
              machine this item exists for. The full list is in the `title`. */}
          {s.tools.length > 0 && (
            <div
              title={s.tools.join(', ')}
              style={{
                fontSize: 10,
                color: 'var(--faint)',
                marginBlockStart: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {t('mcp.tools', { count: s.tools.length, names: toolPreview(s.tools) })}
            </div>
          )}
          {(s.envKeys.length > 0 || s.headerKeys.length > 0) && (
            <div style={{ fontSize: 10, color: 'var(--faint)', marginBlockStart: 2 }}>
              {t('mcp.carries', { keys: [...s.envKeys, ...s.headerKeys].join(', ') })}
            </div>
          )}
        </div>
        <span style={{ fontSize: 10.5, color: TOKEN_INK[state.token], flexShrink: 0 }}>
          {t(state.labelKey)}
        </span>
        {/* ── Sign in / Sign out (#734) ────────────────────────────────────────
            FIRST OF THE ROW ACTIONS, because on a row that says "needs sign-in"
            it is the only one that addresses what the row is complaining about.
            #729 PR 2 shipped that label with nothing behind it.

            REMOTE ROWS ONLY — both verbs are refused BY TYPE for stdio
            (measured), so the control is absent rather than present-and-failing.
            `authControls` owns the whole rule; see its docblock for why sign-in
            reaches wider than the `needs-auth` word alone, and why sign-out
            reaches no further. */}
        {auth.signIn && (
          <Btn
            onClick={() => void doAuthenticate(s)}
            disabled={busy !== null}
            title={t('mcp.signInTitle', { name: s.name })}
          >
            {busy?.kind === 'authenticate' && busy.key === key
              ? t('mcp.signingIn')
              : t('mcp.signIn')}
          </Btn>
        )}
        {auth.signOut && (
          <Btn
            onClick={() => void doClearAuth(s)}
            disabled={busy !== null}
            title={t('mcp.signOutTitle', { name: s.name })}
          >
            {busy?.kind === 'clearAuth' && busy.key === key
              ? t('mcp.signingOut')
              : t('mcp.signOut')}
          </Btn>
        )}
        {/* ── The two control-channel actions (#729 PR 2) ──────────────────────
            OFFERED ON EVERY RUNTIME ROW, INCLUDING READ-ONLY ONES, and that is
            deliberate rather than an oversight. `readOnly` is about REMOVE —
            whether a config file declares the server, so `claude mcp remove`
            has something to edit. Toggling is a different mechanism: it writes
            `disabledMcpServers` BY NAME, so there is no reason it should not
            reach a connector.

            UNMEASURED FOR CONNECTORS, though, because this machine has none to
            test with. So the button is offered and the CLI's own refusal is
            rendered if it says no — fail-open, and honest either way. Do not
            "fix" this by hiding the control until someone has actually seen it
            refuse.

            `state.toggle`, NEVER `s.status` — see `runtimeStatus`. A row whose
            word was decided by APPROVAL gets no switch at all, because approval
            is a different lock with a different key and offering this one built
            a loop the user could not escape. */}
        {state.toggle !== 'none' && (
          <Btn
            onClick={() => void doToggle(s, state.toggle === 'on')}
            disabled={busy !== null}
            title={t(state.toggle === 'on' ? 'mcp.turnOnTitle' : 'mcp.turnOffTitle', {
              name: s.name,
            })}
          >
            {busy?.kind === 'toggle' && busy.key === key
              ? t('mcp.toggling')
              : t(state.toggle === 'on' ? 'mcp.turnOn' : 'mcp.turnOff')}
          </Btn>
        )}
        {/* NO TERMINAL, NO RESTART — the thing #714 could not do. A Direct
            session used to be told to restart because there was nowhere for the
            CLI's picker to appear; `mcp_reconnect` does the real work over the
            control channel.

            NOT ON A ROW THE USER TURNED OFF, and that is measured rather than
            tidy: `mcp_reconnect` against a disabled server RE-ENABLES it
            (`probe-toggle-reconnect-interaction.mjs` — disabled → reconnect →
            connected). A Reconnect button there would silently undo the
            decision this PR works hard to persist. The way back on is Turn on,
            which says what it does. */}
        {s.status !== 'disabled' && (
          <Btn
            onClick={() => void doReconnectServer(s.name, key)}
            disabled={busy !== null}
            title={t('mcp.reconnectServerTitle', { name: s.name })}
          >
            {busy?.kind === 'reconnectServer' && busy.key === key
              ? t('mcp.reconnecting')
              : t('mcp.reconnect.action')}
          </Btn>
        )}
        {/* VISIBLY READ-ONLY, NOT A DISABLED BUTTON (#729's own criterion). You
            cannot `claude mcp remove` a claude.ai connector or a plugin's
            server — they are in no file, so there is nothing for the subcommand
            to edit. A greyed-out Remove would say "not right now"; a word says
            "not ever, and here is why". */}
        {s.readOnly ? (
          <span
            style={{ fontSize: 10, color: 'var(--faint)', flexShrink: 0 }}
            title={t('mcp.readOnlyWhy')}
          >
            {t('mcp.readOnly')}
          </span>
        ) : confirmRemove === key ? (
          <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <Btn
              onClick={() => void doRemoveRuntime(s)}
              disabled={busy !== null}
              title={t('mcp.removeConfirmTitle')}
            >
              {t('mcp.removeConfirm')}
            </Btn>
            <Btn onClick={() => setConfirmRemove(null)}>{t('mcp.form.cancel')}</Btn>
          </span>
        ) : (
          <Btn
            onClick={() => setConfirmRemove(key)}
            disabled={busy !== null}
            title={t('mcp.removeTitle', { name: s.name })}
          >
            {removing ? t('mcp.removing') : t('mcp.remove')}
          </Btn>
        )}
      </div>
    );
  };

  const runtimeSection = (scope: McpRuntimeScope): React.JSX.Element | null => {
    const mine = (runtime ?? []).filter((s) => s.scope === scope);
    if (mine.length === 0) return null;
    return (
      <div key={scope} data-mcp-section={scope}>
        <div
          style={{
            padding: '8px 14px 3px',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            color: 'var(--faint)',
          }}
        >
          {t(`mcp.scope.${scope}`)}
        </div>
        {mine.map(runtimeRow)}
      </div>
    );
  };

  const section = (scope: McpScope): React.JSX.Element | null => {
    const mine = servers.filter((s) => s.scope === scope);
    if (mine.length === 0) return null;
    return (
      <div key={scope} data-mcp-section={scope}>
        <div
          style={{
            padding: '8px 14px 3px',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            color: 'var(--faint)',
          }}
        >
          {t(`mcp.scope.${scope}`)}
        </div>
        {mine.map(row)}
      </div>
    );
  };

  const unreadable = inventory?.unreadable ?? [];
  /**
   * Is there genuinely nothing to draw?
   *
   * COUNTS THE RUNTIME LIST WHEN THERE IS ONE, because that is what is on
   * screen. Reading `servers.length` alone would print "no servers configured"
   * underneath sixteen rendered rows on exactly the machine this item exists
   * for — every one of whose servers is a connector that no config file holds.
   */
  const nothingToShow = runtime
    ? runtime.length === 0 && notLoaded.length === 0
    : servers.length === 0 && unreadable.length === 0;

  return (
    <div
      onMouseDown={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '10vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('mcp.title')}
        data-testid="mcp-manager"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        style={{
          inlineSize: 'min(560px, 94vw)',
          maxBlockSize: '80vh',
          overflowY: 'auto',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          outline: 'none',
        }}
      >
        <div
          style={{
            padding: '11px 14px',
            borderBlockEnd: '1px solid var(--border)',
            background: 'var(--panel2)',
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, minInlineSize: 0 }}>
            {t('mcp.title')}
            {props.sessionTitle && (
              <span style={{ fontWeight: 400, color: 'var(--muted)', marginInlineStart: 6 }}>
                {t('mcp.forSession', { title: props.sessionTitle })}
              </span>
            )}
          </span>
          {/* A VISIBLE WAY OUT, like `QuietHoursDialog` and `PushSetupDialog`.
              Escape and click-away are not enough on their own: they are the
              two exits nothing on screen advertises. */}
          <button
            type="button"
            onClick={close}
            aria-label={t('mcp.close')}
            title={t('mcp.close')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--faint)',
              cursor: 'pointer',
              fontSize: 12,
              lineHeight: 1,
              padding: 2,
            }}
          >
            {/* through the catalogue like every other glyph in the app — the
                JSX-literal rule is what keeps a hard-coded string out of a
                surface a translator has to be able to reach */}
            {t('mcp.closeIcon')}
          </button>
        </div>

        {/* A FILE WE COULD NOT READ IS SAID ONCE, AT THE TOP, AND NAMES ITSELF
            (#714). It used to be a line inside each affected section, which put
            two identical complaints on screen for one broken `~/.claude.json` —
            that file backs both the local and the user scope — and read as two
            problems. P6 is unchanged: this appears BESIDE the servers we could
            read, never instead of them. */}
        {unreadable.map((u) => (
          <div
            key={u.source}
            data-mcp-unreadable={u.source}
            style={{
              padding: '8px 14px',
              fontSize: 11,
              color: 'var(--status-crashed-ink)',
              borderBlockEnd: '1px solid var(--border)',
            }}
          >
            {t('mcp.scopeUnreadable', {
              file: u.source,
              scopes: u.scopes.map((s) => t(`mcp.scope.${s}`)).join(', '),
            })}
          </div>
        ))}

        {!props.folder ? (
          <p style={{ margin: 0, padding: '14px', fontSize: 11.5, color: 'var(--muted)' }}>
            {t('mcp.noSession')}
          </p>
        ) : loading ? (
          <p style={{ margin: 0, padding: '14px', fontSize: 11.5, color: 'var(--muted)' }}>
            {t('mcp.loading')}
          </p>
        ) : (
          <>
            {/* TWO SENTENCES, BECAUSE THE SOURCE DIFFERS. `mcp.empty` says "not
                configured in this session's FILES" — true on the config path,
                and a smaller version of the #723 mistake on the runtime one,
                where files are exactly what we did not read and no footer is
                rendered to correct it. Review caught it. */}
            {nothingToShow && (
              <p style={{ margin: 0, padding: '14px', fontSize: 11.5, color: 'var(--muted)' }}>
                {t(runtime ? 'mcp.emptyRuntime' : 'mcp.empty')}
              </p>
            )}
            {/* THE RUNTIME LIST WINS WHENEVER WE HAVE ONE (#729). It is a
                superset by construction for what the session LOADED — the
                session knows about connectors, plugin servers and builtins that
                appear in no file — so drawing the whole config list beside it
                would show the same servers twice and call the duplicates a
                collision. */}
            {runtime ? RUNTIME_SCOPE_ORDER.map(runtimeSection) : SCOPE_ORDER.map(section)}
            {/* ...EXCEPT THE ONES IT HAS NOT LOADED, which is not a corner case
                but the Add button. `mcp_status` is frozen at session start
                (measured), so a server added a moment ago is in the files and
                not in the session — and without this group the pane would say
                "Added github." over a list that did not change, and answer
                Remove by leaving the row on screen. Ordinary config rendering,
                because that is what these rows are. */}
            {runtime && notLoaded.length > 0 && (
              <div data-mcp-section="not-loaded">
                <div
                  style={{
                    padding: '8px 14px 3px',
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.6,
                    color: 'var(--faint)',
                  }}
                >
                  {t('mcp.scope.notLoaded')}
                </div>
                <div style={{ padding: '0 14px 4px', fontSize: 10, color: 'var(--faint)' }}>
                  {t('mcp.notLoadedHint')}
                </div>
                {/* WITH A BUTTON, not just advice (#729 PR 2). PR 1 could only
                    tell the user to restart, because nothing here could reach
                    into a running session. `mcp_reconnect` was then measured to
                    pull in a server the session had NEVER LOADED — so the row
                    that says "not loaded" can now fix itself. */}
                {notLoaded.map((s) => (
                  <div key={`notloaded:${s.scope}:${s.name}`}>
                    {row(s)}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0 14px 6px' }}>
                      <Btn
                        onClick={() => void doReconnectServer(s.name, `notloaded:${s.scope}:${s.name}`)}
                        disabled={busy !== null}
                        title={t('mcp.loadNowTitle', { name: s.name })}
                      >
                        {busy?.kind === 'reconnectServer' &&
                        busy.key === `notloaded:${s.scope}:${s.name}`
                          ? t('mcp.reconnecting')
                          : t('mcp.loadNow')}
                      </Btn>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* The health check never ran — said ONCE rather than as a verdict on
            every row (#714). Only worth saying when there are rows it would
            have had an opinion about. */}
        {/* `!runtime` because this is a fact about the CONFIG path only: when
            the session answered, status came with the list and there was no
            separate check to fail. `healthRan` would be true anyway (nothing
            ever set it false), but relying on that couples this block to the
            initial value of a flag two effects away. */}
        {!healthRan && !runtime && servers.length > 0 && !loading && (
          <div
            data-mcp-health-unavailable
            style={{
              padding: '10px 14px',
              fontSize: 10.5,
              color: 'var(--faint)',
              borderBlockStart: '1px solid var(--border)',
            }}
          >
            {t('mcp.healthUnavailable')}
          </div>
        )}

        {notice && (
          <div
            data-mcp-notice
            role="status"
            style={{
              padding: '8px 14px',
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              borderBlockStart: '1px solid var(--border)',
              color: notice.bad ? 'var(--status-crashed-ink)' : 'var(--muted)',
            }}
          >
            {notice.text}
          </div>
        )}

        {formOpen && props.folder && (
          <McpAddForm
            onSubmit={doAdd}
            onCancel={() => setFormOpen(false)}
            busy={busy?.kind === 'add'}
          />
        )}

        {/* The action bar. Everything here acts on the SESSION or the folder;
            per-server actions live on their rows. */}
        {props.folder && !formOpen && (
          <div
            style={{
              display: 'flex',
              gap: 6,
              flexWrap: 'wrap',
              alignItems: 'center',
              padding: '10px 14px',
              borderBlockStart: '1px solid var(--border)',
            }}
          >
            <Btn onClick={() => setFormOpen(true)} disabled={busy !== null}>
              {t('mcp.addServer')}
            </Btn>
            {/* "RECONNECT ALL" WHEN THE ROWS HAVE THEIR OWN BUTTON, and this
                is a real ambiguity rather than a naming preference: PR 2 gave
                every runtime row a Reconnect, so an action-bar button with the
                same word is two different scopes under one label. A test
                reaching for the global one clicked a row's instead — which is
                exactly the mistake a user makes with a mouse. On the config
                path there are no per-row buttons and no ambiguity, so the
                original word stands. */}
            <Btn onClick={() => void doReconnect()} disabled={busy !== null}>
              {busy?.kind === 'reconnect'
                ? busy.total
                  ? t('mcp.reconnectingProgress', { done: busy.done ?? 0, total: busy.total })
                  : t('mcp.reconnecting')
                : t(runtime ? 'mcp.reconnectAll' : 'mcp.reconnect.action')}
            </Btn>
            {/* Only when there is a project-scope server, because that is the
                only scope with anything to approve — and a reset button with
                nothing to reset is a button that invites a pointless question. */}
            {hasProject &&
              (confirmReset ? (
                <>
                  <span style={{ fontSize: 11, color: 'var(--status-needs-input-ink)' }}>
                    {t('mcp.resetConfirmPrompt')}
                  </span>
                  <Btn onClick={() => void doReset()} disabled={busy !== null}>
                    {t('mcp.resetConfirm')}
                  </Btn>
                  <Btn onClick={() => setConfirmReset(false)}>{t('mcp.form.cancel')}</Btn>
                </>
              ) : (
                <Btn onClick={() => setConfirmReset(true)} disabled={busy !== null}>
                  {busy?.kind === 'reset' ? t('mcp.resetting') : t('mcp.resetApprovals')}
                </Btn>
              ))}
          </div>
        )}

        {/* THE STANDING CAVEATS, said in the UI rather than left for the user
            to discover — and kept together at the bottom, BELOW the action bar,
            because they are permanent properties of this pane. The blocks above
            (`data-mcp-health-unavailable`, `data-mcp-notice`) are about this run
            and this click, so they stay next to the rows and buttons they
            describe. */}

        {/* WHAT THIS LIST IS NOT (#723). The pane reads three config files, so
            it can only ever show three of the CLI's eight scopes — and the two
            biggest blocs on a real machine, claude.ai connectors and
            plugin-contributed servers, live in NO file and are therefore
            invisible by construction, not by accident.

            Said whenever there is a session, INCLUDING the empty case, which is
            where the silence misleads most: "no servers are configured" read as
            "you have no servers" while the CLI's own picker showed eleven
            connectors is the report that opened #723. P4/P6 — our blind spot
            must never render as a fact about the user's setup.

            THE ESCAPE HATCH IS PHRASED FOR BOTH TRANSPORTS ON PURPOSE. A Direct
            session HAS NO TERMINAL (`mcp.reconnect.restart-required` says so a
            few lines up the same dialog), and Direct is the default for every
            new session — so "use the Terminal tab", which is what this said
            first, was false for most sessions and contradicted the notice
            rendered directly above it.

            RETIRED CONDITIONALLY (#729), which was the instruction this comment
            used to carry: "retire the whole block when #721 lets the pane source
            its inventory from `mcp_status`". It does now — but only for a
            session that HAS a control channel. A suspended card and a Terminal
            session still get the config list, and for them every word of this is
            still true, so deleting it outright would have swapped an honest
            caveat for a silent subset on exactly the cards least able to notice.
            The `reason` beneath it names WHICH of the three cases this is, which
            is the part #723 could not say at all. */}
        {props.folder && !loading && !runtime && (
          <div
            data-mcp-configured-only
            data-mcp-status-reason={status?.reason ?? undefined}
            style={{
              padding: '10px 14px',
              borderBlockStart: '1px solid var(--border)',
              fontSize: 10.5,
              color: 'var(--faint)',
            }}
          >
            {t('mcp.configuredOnly')}{' '}
            {status && status.reason !== 'ok' && t(`mcp.whyConfiguredOnly.${status.reason}`)}
          </div>
        )}

        {/* THE HONEST LIMIT — and it is a SMALLER limit than it was (#729).
            This used to say that turning a server on and off "does not exist as
            a subcommand", which was true of `claude mcp --help` and false of the
            CLI: `mcp_toggle` and `mcp_reconnect` are both real on the control
            protocol, measured 2026-08-29. That sentence is not repeated here.
            What remains true is that add and remove go through the real CLI, and
            that a row this pane cannot mutate is one no config file declares. */}
        <div
          style={{
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
            fontSize: 10.5,
            color: 'var(--faint)',
          }}
        >
          {t('mcp.cliNote')}
        </div>
      </div>
    </div>
  );
}
