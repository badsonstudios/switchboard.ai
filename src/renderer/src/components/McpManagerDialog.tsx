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
// against a session spawned with our own flag list. That is #721's channel, and
// it is what should replace the file read here. Until then the footer says so
// out loud rather than letting a short list read as a complete one.
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
  McpScope,
  McpServerWire,
} from '../../../shared/mcp';

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

/** What the pane is doing right now, so two buttons cannot run at once and the
 *  one you pressed is the one that says "working". */
type Busy = null | { kind: 'add' | 'reset' | 'reconnect' } | { kind: 'remove'; key: string };

/** "this answer belongs to a sitting of the dialog that is over" — distinct
 *  from `null` (it worked) and from a string (it failed and here is why),
 *  because a stale call must produce NO user-visible outcome at all. */
const STALE = Symbol('stale');

export function McpManagerDialog(props: McpManagerDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const [inventory, setInventory] = React.useState<McpInventoryWire | null>(null);
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
      // The expensive half runs on the FIRST load of a folder only — see
      // `generation`. Three removals in a row must not mean three CLI spawns
      // that each connect to every configured server.
      if (!probe) return;
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
  }, [open, folder, generation]);

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
    // ...and reopening re-probes health, because the answer is minutes old at
    // best and the whole reason it is a separate call is that it goes stale.
    if (!props.open) probedFolder.current = null;
  }, [props.open]);

  // A folder switch is a new sitting too: a mutation aimed at the session the
  // user just left must not report against the one they are looking at now.
  React.useEffect(() => {
    epoch.current += 1;
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
    what: Busy,
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
  const nothingToShow = servers.length === 0 && unreadable.length === 0;

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
            {nothingToShow && (
              <p style={{ margin: 0, padding: '14px', fontSize: 11.5, color: 'var(--muted)' }}>
                {t('mcp.empty')}
              </p>
            )}
            {SCOPE_ORDER.map(section)}
          </>
        )}

        {/* The health check never ran — said ONCE rather than as a verdict on
            every row (#714). Only worth saying when there are rows it would
            have had an opinion about. */}
        {!healthRan && servers.length > 0 && !loading && (
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
            <Btn onClick={() => void doReconnect()} disabled={busy !== null}>
              {busy?.kind === 'reconnect' ? t('mcp.reconnecting') : t('mcp.reconnect.action')}
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
            rendered directly above it. Retire the whole block when #721 lets the
            pane source its inventory from `mcp_status`. */}
        {props.folder && !loading && (
          <div
            data-mcp-configured-only
            style={{
              padding: '10px 14px',
              borderBlockStart: '1px solid var(--border)',
              fontSize: 10.5,
              color: 'var(--faint)',
            }}
          >
            {t('mcp.configuredOnly')}
          </div>
        )}

        {/* THE HONEST LIMIT. Add and remove go through the real CLI; turning a
            server on and off does not exist as a subcommand, so this pane hands
            that question back to the CLI's own picker rather than inventing an
            answer. */}
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
