// The MCP Manager (§5.17, #632) — PR 1: the read-only pane.
//
// WHAT IT ANSWERS: "what MCP servers does this session actually have, and is
// the CLI talking to them?" Today that question has no answer inside
// switchboard at all — `/mcp` opens a picker in the CLI's TUI, and a Direct
// session has no terminal for it to appear in (#633).
//
// The dialog shape — scrim, click-away, focus capture, Escape — is
// `QuietHoursDialog.tsx`'s, which is `PushSetupDialog.tsx`'s, which is
// `AboutPanel.tsx`'s. Two modals that behave differently is a bug report
// waiting to happen.
//
// THREE THINGS THIS DELIBERATELY DOES NOT DO, all PR 2 (#632's follow-up):
// add, remove, and the approval hand-off. A pane that lists what you have is
// most of the daily value and is reviewable on its own; the mutation surface
// carries the CLI-invocation questions and deserves its own read.
//
// AND ONE IT WILL NEVER DO: show a secret. `McpServerWire` carries `envKeys`
// and `headerKeys` — the NAMES — and has no field that can hold a value, so
// there is nothing here to reveal even by accident. See `shared/mcp.ts`.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../shared/ipc/refusal';
import type {
  McpHealth,
  McpInventoryWire,
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

export function McpManagerDialog(props: McpManagerDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const [inventory, setInventory] = React.useState<McpInventoryWire | null>(null);
  const [health, setHealth] = React.useState<Readonly<Record<string, McpHealth>>>({});
  const [loading, setLoading] = React.useState(false);
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
    setLoading(true);
    setHealth({}); // a previous session's verdicts must not paint this one
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
      const h = answered(await window.switchboard?.mcp?.health?.(folder));
      if (!live || !h || h.folder !== folder) return;
      setHealth(h.states);
    })();
    return () => {
      live = false;
    };
  }, [open, folder]);

  React.useEffect(() => {
    if (!props.open) return;
    // remembered BEFORE we take focus, or we would remember ourselves
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

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

  const row = (s: McpServerWire): React.JSX.Element => {
    const state = rowStatus(s, health[s.name] ?? 'unknown');
    // The KEY carries the scope: the same name may legitimately appear in two
    // scopes (`config.ts` does not deduplicate, on purpose — showing the
    // collision is what the manager is for), so a name-only key would collapse
    // two real rows into one.
    return (
      <div
        key={`${s.scope}:${s.name}`}
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
        </div>
        {/* the INK and not the hue (#221): this is a word */}
        <span style={{ fontSize: 10.5, color: TOKEN_INK[state.token], flexShrink: 0 }}>
          {t(state.labelKey)}
        </span>
      </div>
    );
  };

  const section = (scope: McpScope): React.JSX.Element | null => {
    const mine = servers.filter((s) => s.scope === scope);
    const broken = inventory?.unreadable.includes(scope);
    if (mine.length === 0 && !broken) return null;
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
        {/* A scope we could not READ is said out loud BESIDE the ones we could
            (P6): a `.mcp.json` with a trailing comma in it must not make the
            user's perfectly good user-scope servers vanish, and a silently
            empty section would read as "you have none" rather than "we could
            not look". */}
        {broken && (
          <div style={{ padding: '4px 14px 6px', fontSize: 11, color: 'var(--status-crashed-ink)' }}>
            {t('mcp.scopeUnreadable')}
          </div>
        )}
        {mine.map(row)}
      </div>
    );
  };

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

        {!props.folder ? (
          <p style={{ margin: 0, padding: '14px', fontSize: 11.5, color: 'var(--muted)' }}>
            {t('mcp.noSession')}
          </p>
        ) : loading ? (
          <p style={{ margin: 0, padding: '14px', fontSize: 11.5, color: 'var(--muted)' }}>
            {t('mcp.loading')}
          </p>
        ) : servers.length === 0 && (inventory?.unreadable.length ?? 0) === 0 ? (
          <p style={{ margin: 0, padding: '14px', fontSize: 11.5, color: 'var(--muted)' }}>
            {t('mcp.empty')}
          </p>
        ) : (
          SCOPE_ORDER.map(section)
        )}

        {/* THE HONEST LIMIT, said in the UI rather than left for the user to
            discover: this pane reads, and the CLI writes. PR 2 adds the
            mutation surface; until then, saying where the buttons are not is
            better than a pane that looks broken. */}
        <div
          style={{
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
            fontSize: 10.5,
            color: 'var(--faint)',
          }}
        >
          {t('mcp.readOnlyNote')}
        </div>
      </div>
    </div>
  );
}
