// Session grid (P1-E3-01): Dockview-powered card grid. Cards are placeholders
// until E3-02 wires terminals in. Layout serializes to the workspace store on
// every change and restores on boot.
import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DockviewReact,
  DockviewReadyEvent,
  DockviewApi,
  IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { TerminalPane } from './TerminalPane';
import { IdentityChip } from './IdentityChip';
import { DiffPane } from './DiffPane';
import { FeedView } from './FeedView';
import { UsageStrip } from './UsageStrip';
import { GitContext, GitStatusDto } from './GitContext';
import { Usage, ZERO_USAGE } from '../lib/usage';
import { sanitizePopoutLayout } from '../lib/layout';
import { pickAdoptedGroupId } from '../lib/groups';

// The DURABLE unit is the card (cardId + folder). The live claude session
// under it is ephemeral: spawned — or --resumed — lazily the first time the
// card is visible (resume-on-focus, §5.25). Params carry only stable data so
// they survive Dockview layout serialization across restarts.
export interface CardParams {
  cardId: string;
  folder: string;
  title?: string;
  /** persistent-group membership at creation (E12); undefined = ungrouped */
  groupId?: string;
}

interface Live {
  id: string;
  accent?: string;
  badge?: string;
  autonomy?: string;
}

function IdentityTab(props: IDockviewPanelProps<CardParams>): React.JSX.Element {
  return (
    <div style={{ paddingInline: 8, display: 'flex', alignItems: 'center', blockSize: '100%' }}>
      <IdentityChip title={props.api.title ?? props.params?.title ?? ''} compact />
    </div>
  );
}

function SessionCardPanel(props: IDockviewPanelProps<CardParams>): React.JSX.Element {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState<boolean>(props.api.isVisible);
  const [live, setLive] = React.useState<Live | null>(null);
  const [exited, setExited] = React.useState<{ code: number; crashed: boolean } | null>(null);
  const [usage, setUsage] = React.useState<{ usage: Usage; model?: string } | null>(null);
  const [plan, setPlan] = React.useState<{ total: number; completed: number; inProgress: number } | null>(null);
  const [taskLabel, setTaskLabel] = React.useState<string>('');
  const [editingLabel, setEditingLabel] = React.useState(false);
  const [status, setStatus] = React.useState<string>('starting');
  const [view, setView] = React.useState<'feed' | 'terminal' | 'diff'>('terminal');
  const [poppedOut, setPoppedOut] = React.useState<boolean>(props.api.location.type === 'popout');
  const [suspended, setSuspended] = React.useState(false);
  const spawning = React.useRef(false);
  const cardId = props.params?.cardId;
  const folder = props.params?.folder;

  React.useEffect(() => {
    const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [props.api]);

  // resume-on-focus: spawn (or --resume) the session when the card first
  // becomes visible. Background restored cards stay suspended until touched.
  React.useEffect(() => {
    if (!visible || live || exited || suspended || spawning.current || !cardId || !folder) return;
    spawning.current = true;
    // titlebar autonomy chip applies to NEW cards; main keeps a card's own
    // autonomy across resumes
    const stored = localStorage.getItem('switchboard.autonomy');
    const autonomy =
      stored === 'plan' || stored === 'auto-edit' || stored === 'full-auto' ? stored : 'ask';
    void window.switchboard.sessions
      .create({ cardId, folder, title: props.api.title ?? folder, autonomy, groupId: props.params?.groupId })
      .then((record) => {
        if (cardId) liveToCard.set(record.id, cardId);
        setLive({
          id: record.id,
          accent: record.identity.accentColor,
          badge: record.identity.langBadge,
          autonomy: record.autonomy,
        });
        // show the usage strip from the start (zeros until the first prompt),
        // so it's visibly present rather than appearing only after activity
        setUsage({ usage: record.priorUsage ?? ZERO_USAGE, model: record.priorModel });
        if (record.taskLabel) setTaskLabel(record.taskLabel);
      })
      .catch(() => {
        setExited({ code: -1, crashed: true }); // spawn failed — show the overlay
      })
      .finally(() => {
        spawning.current = false;
      });
  }, [visible, live, exited, suspended, cardId, folder, props.api.title]);

  // a dead session's card must be dismissable, not a stuck blank terminal
  React.useEffect(() => {
    if (!live) return;
    return window.switchboard.sessions.onExited((e) => {
      if (e.sessionId === live.id) setExited({ code: e.code, crashed: e.crashed });
    });
  }, [live]);

  // live token usage for this session (P2-E7-01)
  React.useEffect(() => {
    if (!live) return;
    return window.switchboard.sessions.onUsage((snap) => {
      const s = snap as {
        sessionId: string;
        usage: Usage;
        model?: string;
        plan?: { total: number; completed: number; inProgress: number };
      };
      if (s.sessionId !== live.id) return;
      setUsage({ usage: s.usage, model: s.model });
      setPlan(s.plan && s.plan.total > 0 ? s.plan : null);
    });
  }, [live]);

  // git context (P2-E7-02): refresh when the card is shown and after each
  // turn ends (Stop -> done), since that's when files have changed
  const [git, setGit] = React.useState<GitStatusDto | null>(null);
  React.useEffect(() => {
    if (!live || !visible || !folder) return;
    let cancelled = false;
    const refresh = () => {
      void window.switchboard.git.status(folder).then((s) => {
        if (!cancelled) setGit(s as GitStatusDto);
      });
    };
    refresh();
    const off = window.switchboard.sessions.onStatus((c) => {
      const change = c as { sessionId: string; to: string };
      if (change.sessionId === live.id && change.to === 'done') refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [live, visible, folder]);

  // live status for the header pill (E8-05). Backend emits { sessionId, to }.
  React.useEffect(() => {
    if (!live) return;
    setStatus('working');
    return window.switchboard.sessions.onStatus((c) => {
      const s = c as { sessionId: string; to?: string };
      if (s.sessionId === live.id && s.to) setStatus(s.to);
    });
  }, [live]);

  // membership follows the panel when the user drags it between dockview
  // groups in the grid (E12-04)
  React.useEffect(() => {
    const d = props.api.onDidGroupChange(() => {
      if (tearingDown || restoringLayout) return;
      void adoptMembershipFromDockGroup(props);
    });
    return () => d.dispose();
    // props.api is stable for the panel's lifetime
  }, [props.api]);

  // Track popout location + implement the two dock-back semantics (E8-04):
  // the pop-out BUTTON toggling in keeps the session alive; the user closing
  // the OS window suspends it (keep the card + record, resume on reopen).
  React.useEffect(() => {
    const prev = { type: props.api.location.type as string };
    const d = props.api.onDidLocationChange(() => {
      const now = props.api.location.type as string;
      const wasPopout = prev.type === 'popout';
      prev.type = now;
      setPoppedOut(now === 'popout');
      // App quit tears popouts down — not a user close. If this ever loses the
      // race with beforeunload the only effect is the session ending a few ms
      // early: dropLive keeps the persisted record, so the card still resumes
      // next launch. Harmless either way (E8-04 review).
      if (tearingDown) return;
      if (wasPopout && now !== 'popout' && cardId) {
        if (dockingBackByButton.has(cardId)) {
          dockingBackByButton.delete(cardId); // button toggle: stay alive
        } else {
          void window.switchboard.sessions.dropLive(cardId); // window closed: suspend
          forgetCardLiveIds(cardId);
          setLive(null);
          setSuspended(true);
        }
      }
    });
    return () => d.dispose();
  }, [props.api, cardId]);

  const closeSelf = (): void => {
    const panel = props.containerApi.getPanel(props.api.id);
    if (panel) props.containerApi.removePanel(panel); // onDidRemovePanel -> closeCard
  };
  // Pop-out TOGGLE: docked -> tear into its own OS window; popped -> dock back
  // in (close its window, flagged so it stays alive rather than suspending).
  const popOutToggle = (): void => {
    const loc = props.api.location;
    if (loc.type === 'popout') {
      const w = loc.getWindow();
      // only arm the "stay alive" flag when a window actually exists to close —
      // else a stale flag would later mis-classify a genuine user close as a
      // toggle and skip the suspend (E8-04 review).
      if (w && cardId) dockingBackByButton.add(cardId);
      w?.close();
      return;
    }
    const panel = props.containerApi.getPanel(props.api.id);
    if (!panel) return;
    if (cardId) dockingBackByButton.delete(cardId); // drop any stale toggle flag
    // same-origin popout.html; the terminal keeps running because its JS stays
    // in this window while its DOM is adopted into the new OS window (E8)
    const popoutUrl = new URL('popout.html', window.location.href).toString();
    void props.containerApi.addPopoutGroup(panel, { popoutUrl });
  };
  const resumeSelf = (): void => {
    // clear the suspended gate; the lazy-spawn effect re-fires while visible
    setSuspended(false);
    setExited(null);
    spawning.current = false;
  };
  const restartSelf = (): void => {
    // drop the dead live session (keep the card record), then re-arm the lazy
    // spawn so the card respawns/resumes
    if (cardId) void window.switchboard.sessions.dropLive(cardId);
    if (live) forgetCardLiveIds(cardId ?? '');
    setExited(null);
    setLive(null);
    spawning.current = false;
  };
  const exitedOverlay = exited ? (
    <div>
      <div style={{ color: 'var(--text)', fontSize: 13, marginBlockEnd: 4 }}>
        {t('grid.sessionEnded')}
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginBlockEnd: 12 }}>
        {exited.crashed ? t('grid.exitCrashed', { code: exited.code }) : t('grid.exitClean')}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button onClick={restartSelf} style={overlayBtn(true)}>
          {t('grid.restart')}
        </button>
        <button onClick={closeSelf} style={overlayBtn(false)}>
          {t('grid.close')}
        </button>
      </div>
    </div>
  ) : null;
  const suspendedOverlay = suspended ? (
    <div>
      <div style={{ color: 'var(--text)', fontSize: 13, marginBlockEnd: 4 }}>
        {t('grid.suspended')}
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 11, marginBlockEnd: 12, maxInlineSize: 260 }}>
        {t('grid.suspendedHint')}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <button onClick={resumeSelf} style={overlayBtn(true)}>
          {t('grid.resume')}
        </button>
        <button onClick={closeSelf} style={overlayBtn(false)}>
          {t('grid.close')}
        </button>
      </div>
    </div>
  ) : null;
  const changed = git?.files.length ?? 0;
  return (
    <div
      style={{
        blockSize: '100%',
        background: 'var(--card-bg)',
        color: 'var(--muted)',
        fontSize: 11,
        position: 'relative',
        display: 'flex',
      }}
    >
      {live ? (
        <div style={{ flex: 1, minInlineSize: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {/* card header (.chead) — accent border, identity, status, window controls */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              paddingInline: 10,
              paddingBlock: 7,
              borderBlockEnd: '1px solid var(--border)',
              borderInlineStart: `3px solid ${live.accent ?? 'var(--faint)'}`,
              background: 'var(--panel2)',
            }}
          >
            {live.badge && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  fontWeight: 700,
                  color: live.accent ?? 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  paddingInline: 4,
                  paddingBlock: 1,
                }}
              >
                {live.badge}
              </span>
            )}
            <span
              style={{
                fontWeight: 650,
                fontSize: 13,
                color: 'var(--text)',
                fontFamily: 'var(--font-ui)',
                whiteSpace: 'nowrap',
              }}
            >
              {props.api.title ?? folder}
            </span>
            {editingLabel ? (
              <input
                autoFocus
                defaultValue={taskLabel}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  setTaskLabel(v);
                  if (cardId) void window.switchboard.sessions.setTaskLabel(cardId, v);
                  setEditingLabel(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditingLabel(false);
                }}
                style={{
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily: 'var(--font-ui)',
                  minInlineSize: 140,
                }}
              />
            ) : (
              <span
                onClick={() => setEditingLabel(true)}
                title={t('grid.taskLabelHint')}
                style={{
                  cursor: 'text',
                  fontSize: 11,
                  color: taskLabel ? 'var(--muted)' : 'var(--faint)',
                  fontFamily: 'var(--font-ui)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {taskLabel || t('grid.taskLabelEmpty')}
              </span>
            )}
            <span style={{ flex: 1, minInlineSize: 8 }} />
            {live.autonomy && live.autonomy !== 'ask' && (
              <span
                title={t('autonomy.title')}
                style={{
                  fontSize: 9.5,
                  fontFamily: 'var(--font-mono)',
                  color: live.autonomy === 'full-auto' ? 'var(--status-crashed)' : 'var(--muted)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  paddingInline: 5,
                  paddingBlock: 1,
                }}
              >
                {t(`autonomy.${live.autonomy}`)}
              </span>
            )}
            <span style={statusPillStyle(status)}>{t(`status.${status}`)}</span>
            <button onClick={popOutToggle} title={poppedOut ? t('grid.dockIn') : t('grid.popOut')} style={cheadBtn}>
              {poppedOut ? t('grid.dockInIcon') : t('grid.popOutIcon')}
            </button>
            <span title={t('grid.menu')} style={{ ...cheadBtn, cursor: 'default', color: 'var(--faint)' }}>
              {t('grid.menuIcon')}
            </span>
          </div>
          {/* view tabs (.vtabs). Order/default per DESIGN §5.10: Feed is the
              first tab and the eventual default view — it's a "soon" placeholder
              until the Feed renderer lands (E12), so Terminal is the interim
              default. Terminal + Diff are live today. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 3,
              paddingInline: 8,
              paddingBlock: 0,
              paddingBlockStart: 5,
              borderBlockEnd: '1px solid var(--border)',
              background: 'var(--panel2)',
            }}
          >
            <button style={vtabStyle(view === 'feed', false, live.accent)} onClick={() => setView('feed')}>
              {t('grid.viewFeed')}
            </button>
            <button style={vtabStyle(view === 'terminal', false, live.accent)} onClick={() => setView('terminal')}>
              {t('grid.viewTerminal')}
            </button>
            <button style={vtabStyle(view === 'diff', false, live.accent)} onClick={() => setView('diff')}>
              {t('grid.viewDiff')}
              {changed > 0 && <span style={{ color: 'var(--status-needs-input)', marginInlineStart: 4 }}>{changed}</span>}
            </button>
            <span style={vtabStyle(false, true, live.accent)} title={t('grid.viewSoon')}>
              {t('grid.viewFiles')}
            </span>
            <span style={{ flex: 1, minInlineSize: 8 }} />
            {plan && (
              <span title={t('grid.planTitle')} style={{ color: 'var(--status-working)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
                {t('grid.plan', { done: plan.completed, total: plan.total })}
              </span>
            )}
            <GitContext status={git} />
            {usage && <UsageStrip usage={usage.usage} model={usage.model} inline />}
          </div>
          {/* active view */}
          <div style={{ flex: 1, minBlockSize: 0, position: 'relative' }}>
            <div style={{ blockSize: '100%', display: view === 'terminal' ? 'block' : 'none' }}>
              <TerminalPane sessionId={live.id} visible={visible && view === 'terminal'} />
            </div>
            {view === 'feed' && <FeedView sessionId={live.id} visible={visible && view === 'feed'} />}
            {view === 'diff' && folder && <DiffPane folder={folder} theme={docTheme()} />}
            {exitedOverlay && <div style={overlayBackdrop}>{exitedOverlay}</div>}
          </div>
        </div>
      ) : suspended ? (
        <div style={{ ...overlayBackdrop, position: 'relative', flex: 1 }}>{suspendedOverlay}</div>
      ) : exited ? (
        // spawn/resume failed before a terminal existed — still recoverable
        <div style={{ ...overlayBackdrop, position: 'relative', flex: 1 }}>{exitedOverlay}</div>
      ) : (
        <span style={{ margin: 'auto' }}>
          {t('grid.resuming', { title: props.api.title ?? folder ?? '' })}
        </span>
      )}
    </div>
  );
}

// current app theme, for the in-card Diff view (theme lives on <html>)
function docTheme(): 'nordic' | 'daylight' {
  return document.documentElement.dataset.theme === 'daylight' ? 'daylight' : 'nordic';
}

const cheadBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  cursor: 'pointer',
  fontSize: 15,
  lineHeight: 1,
  padding: '2px 4px',
};

// status pill colors mirror the rail's STATUS_TOKEN (chrome.tsx)
const STATUS_COLOR: Record<string, string> = {
  starting: 'var(--status-idle)',
  working: 'var(--status-working)',
  'needs-input': 'var(--status-needs-input)',
  'needs-permission': 'var(--status-needs-permission)',
  idle: 'var(--status-idle)',
  done: 'var(--status-done)',
  crashed: 'var(--status-crashed)',
  suspended: 'var(--faint)',
};
function statusPillStyle(status: string): React.CSSProperties {
  const c = STATUS_COLOR[status] ?? 'var(--faint)';
  return {
    fontSize: 9.5,
    fontWeight: 600,
    letterSpacing: 0.3,
    color: c,
    background: `color-mix(in srgb, ${c} 14%, transparent)`,
    border: `1px solid color-mix(in srgb, ${c} 40%, transparent)`,
    borderRadius: 4,
    paddingInline: 6,
    paddingBlock: 2,
    fontFamily: 'var(--font-ui)',
    whiteSpace: 'nowrap',
  };
}
function vtabStyle(active: boolean, disabled: boolean, accent?: string): React.CSSProperties {
  const edge = accent ?? 'var(--status-working)';
  // The active tab has to read clearly at a glance across 7–8 cards: an accent
  // top stripe, an elevated (card-colored) fill that seams into the view below,
  // bolder text, and a lift shadow — inactive/soon tabs stay flat and muted.
  return {
    padding: active ? '5px 12px 7px' : '4px 11px 6px',
    borderStartStartRadius: 6,
    borderStartEndRadius: 6,
    fontSize: 11,
    fontFamily: 'var(--font-ui)',
    fontWeight: active ? 650 : 500,
    cursor: disabled ? 'default' : 'pointer',
    color: disabled ? 'var(--faint)' : active ? 'var(--text)' : 'var(--muted)',
    background: active ? 'var(--card-bg)' : 'transparent',
    borderInline: active ? '1px solid var(--border)' : '1px solid transparent',
    borderBlockStart: active ? `2px solid ${edge}` : '2px solid transparent',
    borderBlockEnd: active ? '1px solid var(--card-bg)' : '1px solid transparent',
    marginBlockEnd: active ? -1 : 0, // overlap the strip's bottom border to "connect"
    boxShadow: active ? 'var(--tab-lift)' : 'none',
    opacity: disabled ? 0.5 : 1,
  };
}

const overlayBackdrop: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'color-mix(in srgb, var(--bg) 82%, transparent)',
  display: 'grid',
  placeItems: 'center',
  textAlign: 'center',
};

function overlayBtn(primary: boolean): React.CSSProperties {
  return {
    background: primary ? 'var(--btn-primary-bg)' : 'var(--panel)',
    color: primary ? 'var(--btn-primary-text)' : 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    padding: '4px 14px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    fontSize: 12,
  };
}

function DiffPanel(props: IDockviewPanelProps<{ folder?: string; theme?: string }>): React.JSX.Element {
  return (
    <DiffPane
      folder={props.params?.folder ?? ''}
      theme={props.params?.theme === 'daylight' ? 'daylight' : 'nordic'}
    />
  );
}

const components = { sessionCard: SessionCardPanel, diffPane: DiffPanel };

// live session id -> stable card id (single-window app). Lets the rail, which
// tracks live sessions, focus/diff a card by its ephemeral session id.
const liveToCard = new Map<string, string>();
// card ids currently docking back via the pop-out BUTTON (toggle). The panel's
// location-change handler reads this to keep a button dock-back alive while a
// bare window-close suspends the session (E8-04).
const dockingBackByButton = new Set<string>();
function cardIdForLive(liveId: string): string {
  return liveToCard.get(liveId) ?? liveId;
}
function forgetCardLiveIds(cardId: string): void {
  for (const [liveId, cid] of liveToCard) if (cid === cardId) liveToCard.delete(liveId);
}
// set while the window is tearing down: Dockview disposal must NOT be mistaken
// for the user closing cards (which would wipe persisted records)
let tearingDown = false;
// set while fromJSON replays a saved layout: those group-change events are
// restore mechanics, not user drags — never adopt membership from them
let restoringLayout = false;

// Grid-drag membership sync (E12-04): after a user drag drops a session panel
// into a dockview group, it adopts its new siblings' persistent group.
async function adoptMembershipFromDockGroup(
  props: IDockviewPanelProps<CardParams>
): Promise<void> {
  const cardId = props.params?.cardId;
  if (!cardId) return;
  const panel = props.containerApi.getPanel(props.api.id);
  if (!panel || panel.group.api.location.type !== 'grid') return; // popouts don't regroup
  const siblingIds = panel.group.panels
    .map((p) => /^session-(.+)$/.exec(p.id)?.[1])
    .filter((x): x is string => !!x);
  const cards = await window.switchboard.sessions.cards();
  const mine = cards.find((c) => c.cardId === cardId);
  if (!mine) return; // brand-new card, no record yet — create() carries its groupId
  const target = pickAdoptedGroupId(cardId, siblingIds, cards);
  if ((mine.groupId ?? null) !== target) {
    await window.switchboard.groups.setSessionGroup(cardId, target);
    // the rail lives in App state — poke it to re-read memberships
    window.dispatchEvent(new Event('switchboard:groups-changed'));
  }
}

export interface GridController {
  /** create a session in `folder` and add its card (drag-drop, rail actions);
   *  groupId places it clustered with its persistent group (E12) */
  addSessionCard: (folder: string, groupId?: string) => Promise<void>;
  /** move an existing card's PANEL next to its persistent-group siblings
   *  after a rail drop set its membership (E12-04) */
  moveCardToGroup: (cardId: string, groupId: string | null) => void;
  /** focus an existing session's card */
  focusSession: (sessionId: string) => void;
  /** open (or focus) the per-session diff tab (E5-02) */
  openDiff: (sessionId: string, folder: string, title: string) => void;
}

export function SessionGrid(props: {
  theme: 'nordic' | 'daylight';
  seedPanels: number;
  onCardsChanged: (ids: string[]) => void;
  controller?: React.MutableRefObject<GridController | null>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const apiRef = useRef<DockviewApi | null>(null);
  const counter = useRef(0);

  // Add a NEW card. It gets a stable id and spawns its session lazily when it
  // becomes visible (which, as the newly-active tab, is immediately).
  const addSessionCard = useCallback(async (folder: string, groupId?: string) => {
    const api = apiRef.current;
    if (!api) return;
    const title = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folder;
    const cardId = crypto.randomUUID();
    // A new session must land in the MAIN window, never as a tab inside whatever
    // popout happens to be active. dockview's addPanel defaults to the active
    // group — which becomes the popout once a card is torn off — so pin it to a
    // main-grid group explicitly (E8-04). If every card is popped out there is
    // no grid group left, so make one in the main grid rather than falling back
    // to the (popout) active group.
    // A persistent-group member clusters with its siblings (E12-02): reuse the
    // dockview group already holding another member, when one is in the grid.
    let refGroup = api.groups.find((g) => g.api.location.type === 'grid') ?? api.addGroup();
    if (groupId) {
      const cards = await window.switchboard.sessions.cards();
      const siblings = new Set(
        cards.filter((c) => c.groupId === groupId).map((c) => `session-${c.cardId}`)
      );
      const sibling = api.panels.find(
        (p) => siblings.has(p.id) && p.group.api.location.type === 'grid'
      );
      if (sibling) refGroup = sibling.group;
    }
    api.addPanel({
      id: `session-${cardId}`,
      component: 'sessionCard',
      title,
      params: { cardId, folder, title, groupId } satisfies CardParams,
      position: { referenceGroup: refGroup },
    });
  }, []);

  React.useEffect(() => {
    if (!props.controller) return;
    props.controller.current = {
      addSessionCard,
      moveCardToGroup: (cardId, groupId) => {
        const api = apiRef.current;
        if (!api || !groupId) return; // ungrouping keeps the panel where it sits
        const panel = api.getPanel(`session-${cardId}`);
        if (!panel) return;
        void window.switchboard.sessions.cards().then((cards) => {
          const siblings = new Set(
            cards
              .filter((c) => c.groupId === groupId && c.cardId !== cardId)
              .map((c) => `session-${c.cardId}`)
          );
          const sibling = api.panels.find(
            (p) => siblings.has(p.id) && p.group.api.location.type === 'grid'
          );
          if (sibling && sibling.group !== panel.group) panel.api.moveTo({ group: sibling.group });
        });
      },
      focusSession: (liveId) => {
        apiRef.current?.getPanel(`session-${cardIdForLive(liveId)}`)?.focus();
      },
      openDiff: (liveId, folder, title) => {
        const api = apiRef.current;
        if (!api) return;
        const cardId = cardIdForLive(liveId);
        const existing = api.getPanel(`diff-${cardId}`);
        if (existing) return existing.focus();
        api.addPanel({
          id: `diff-${cardId}`,
          component: 'diffPane',
          title: t('diff.tabTitle', { title }),
          params: { folder, theme: props.theme },
        });
      },
    };
    // eslint's exhaustive-deps plugin isn't installed; deps kept accurate by hand
  }, [props.controller, addSessionCard, props.theme, t]);

  const [error, setError] = React.useState<string | null>(null);
  const addCard = useCallback(async () => {
    // ⊕ flow: pick a folder, spawn, bind the card (E3-02/E3-04)
    const folder = await window.switchboard.sessions.pickFolder();
    if (!folder) return;
    try {
      await addSessionCard(folder);
    } catch (e) {
      // our breakage must be visible, not mute (fail-open)
      setError(String(e));
    }
  }, [addSessionCard]);

  const onReady = useCallback(
    async (event: DockviewReadyEvent) => {
      const api = event.api;
      apiRef.current = api;

      const report = () => props.onCardsChanged(api.panels.map((p) => p.id));
      const saveLayout = () => window.switchboard.workspace.setLayout(api.toJSON());
      api.onDidLayoutChange(() => {
        report();
        saveLayout();
      });
      // moving/resizing a popped-out window isn't a layout mutation, so persist
      // its geometry on those events too — else a dragged popout forgets its
      // spot on relaunch (E8-04 multi-monitor).
      api.onDidPopoutGroupPositionChange?.(saveLayout);
      api.onDidPopoutGroupSizeChange?.(saveLayout);
      // E8 diagnostics: surface popout success/failure
      api.onDidOpenPopoutWindowFail?.(() => console.error('[popout] onDidOpenPopoutWindowFail'));
      api.onDidAddPopoutGroup?.(() => console.log('[popout] onDidAddPopoutGroup (opened OK)'));
      // window teardown must not be mistaken for the user closing cards
      window.addEventListener('beforeunload', () => {
        tearingDown = true;
      });
      // closing a card (tab X or the overlay) forgets it — it will NOT come
      // back next launch. Quitting keeps the record so sessions DO come back,
      // so we skip this during teardown (belt-and-suspenders vs Dockview
      // disposal ever firing removes).
      api.onDidRemovePanel((panel) => {
        if (tearingDown) return;
        const m = /^session-(.+)$/.exec(panel.id);
        if (!m) return;
        forgetCardLiveIds(m[1]);
        void window.switchboard.sessions.closeCard(m[1]);
      });

      const saved = await window.switchboard.workspace.getLayout();
      if (saved) {
        try {
          // popouts persist in the layout, but their stored url has last
          // launch's (random) loopback port and their position may be on a
          // now-missing monitor — fix both before restoring (E8-02)
          const workAreas = await window.switchboard.workAreas();
          const sane = sanitizePopoutLayout(saved, window.location.origin, workAreas);
          restoringLayout = true;
          try {
            api.fromJSON(sane as Parameters<DockviewApi['fromJSON']>[0]);
          } finally {
            restoringLayout = false;
          }
          // keep restored session cards that still have a persisted record
          // (they resume-on-focus); drop any panel with no record behind it.
          // Diff panes are derived — always drop and let the user reopen.
          const known = new Set(
            (await window.switchboard.sessions.knownCards()).map((c) => c.cardId)
          );
          for (const p of [...api.panels]) {
            const s = /^session-(.+)$/.exec(p.id);
            const d = /^diff-/.exec(p.id);
            if (d || (s && !known.has(s[1]))) api.removePanel(p);
          }
        } catch {
          // fail-open: unusable layout JSON -> fresh grid, never a crash
        }
      }
      for (let i = api.panels.length; i < props.seedPanels; i++) {
        counter.current += 1;
        api.addPanel({
          id: `seed-${counter.current}`,
          component: 'sessionCard',
          title: t('grid.cardTitle', { n: i + 1 }),
        });
      }
      // scripted-check seam: one REAL session without the folder dialog
      const seedFolder = window.switchboard.seedSessionFolder;
      if (seedFolder) {
        await addSessionCard(seedFolder);
      }
      report();
    },
    [] // onReady fires exactly once; props.seedPanels is read at that moment
  );

  return (
    <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minInlineSize: 0 }}>
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: 'var(--grid-pad)',
          paddingBlockEnd: 0,
        }}
      >
        {error && (
          <span style={{ color: 'var(--status-crashed)', fontSize: 11, alignSelf: 'center' }}>
            {error}
          </span>
        )}
        <button
          onClick={() => void addCard()}
          style={{
            background: 'var(--chip)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            padding: '3px 10px',
            cursor: 'pointer',
            fontSize: 11,
            fontFamily: 'var(--font-ui)',
          }}
        >
          {t('grid.addCard')}
        </button>
      </div>
      <div style={{ flex: 1, padding: 'var(--grid-pad)' }}>
        <DockviewReact
          components={components}
          defaultTabComponent={IdentityTab}
          onReady={(e: DockviewReadyEvent) => void onReady(e)}
          className={props.theme === 'daylight' ? 'dockview-theme-light' : 'dockview-theme-dark'}
        />
      </div>
    </main>
  );
}
