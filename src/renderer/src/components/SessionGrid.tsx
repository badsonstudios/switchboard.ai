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

// The DURABLE unit is the card (cardId + folder). The live claude session
// under it is ephemeral: spawned — or --resumed — lazily the first time the
// card is visible (resume-on-focus, §5.25). Params carry only stable data so
// they survive Dockview layout serialization across restarts.
export interface CardParams {
  cardId: string;
  folder: string;
  title?: string;
}

interface Live {
  id: string;
  accent?: string;
  badge?: string;
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
    if (!visible || live || exited || spawning.current || !cardId || !folder) return;
    spawning.current = true;
    void window.switchboard.sessions
      .create({ cardId, folder, title: props.api.title ?? folder })
      .then((record) => {
        if (cardId) liveToCard.set(record.id, cardId);
        setLive({ id: record.id, accent: record.identity.accentColor, badge: record.identity.langBadge });
      })
      .catch(() => {
        setExited({ code: -1, crashed: true }); // spawn failed — show the overlay
      })
      .finally(() => {
        spawning.current = false;
      });
  }, [visible, live, exited, cardId, folder, props.api.title]);

  // a dead session's card must be dismissable, not a stuck blank terminal
  React.useEffect(() => {
    if (!live) return;
    return window.switchboard.sessions.onExited((e) => {
      if (e.sessionId === live.id) setExited({ code: e.code, crashed: e.crashed });
    });
  }, [live]);

  const closeSelf = (): void => {
    const panel = props.containerApi.getPanel(props.api.id);
    if (panel) props.containerApi.removePanel(panel); // onDidRemovePanel -> closeCard
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
  const overlay = exited ? (
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
      <span
        style={{
          position: 'absolute',
          insetInlineStart: 0,
          insetBlockStart: 0,
          insetBlockEnd: 0,
          inlineSize: 3,
          background: live?.accent ?? 'var(--faint)',
          zIndex: 1,
        }}
      />
      {live ? (
        <div style={{ flex: 1, paddingInlineStart: 3, minInlineSize: 0, position: 'relative' }}>
          <TerminalPane sessionId={live.id} visible={visible} />
          {overlay && <div style={overlayBackdrop}>{overlay}</div>}
        </div>
      ) : exited ? (
        // spawn/resume failed before a terminal existed — still recoverable
        <div style={{ ...overlayBackdrop, position: 'relative', flex: 1 }}>{overlay}</div>
      ) : (
        <span style={{ margin: 'auto' }}>
          {t('grid.resuming', { title: props.api.title ?? folder ?? '' })}
        </span>
      )}
    </div>
  );
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
function cardIdForLive(liveId: string): string {
  return liveToCard.get(liveId) ?? liveId;
}
function forgetCardLiveIds(cardId: string): void {
  for (const [liveId, cid] of liveToCard) if (cid === cardId) liveToCard.delete(liveId);
}
// set while the window is tearing down: Dockview disposal must NOT be mistaken
// for the user closing cards (which would wipe persisted records)
let tearingDown = false;

export interface GridController {
  /** create a session in `folder` and add its card (drag-drop, rail actions) */
  addSessionCard: (folder: string) => Promise<void>;
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
  const addSessionCard = useCallback(async (folder: string) => {
    const api = apiRef.current;
    if (!api) return;
    const title = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folder;
    const cardId = crypto.randomUUID();
    api.addPanel({
      id: `session-${cardId}`,
      component: 'sessionCard',
      title,
      params: { cardId, folder, title } satisfies CardParams,
    });
  }, []);

  React.useEffect(() => {
    if (!props.controller) return;
    props.controller.current = {
      addSessionCard,
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
      api.onDidLayoutChange(() => {
        report();
        window.switchboard.workspace.setLayout(api.toJSON());
      });
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
          api.fromJSON(saved as Parameters<DockviewApi['fromJSON']>[0]);
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
