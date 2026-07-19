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

export interface CardParams {
  sessionId?: string;
  accent?: string;
  badge?: string;
}

function IdentityTab(props: IDockviewPanelProps<CardParams>): React.JSX.Element {
  return (
    <div style={{ paddingInline: 8, display: 'flex', alignItems: 'center', blockSize: '100%' }}>
      <IdentityChip
        title={props.api.title ?? ''}
        accent={props.params?.accent}
        badge={props.params?.badge}
        compact
      />
    </div>
  );
}

function SessionCardPanel(props: IDockviewPanelProps<CardParams>): React.JSX.Element {
  const { t } = useTranslation();
  const [visible, setVisible] = React.useState<boolean>(props.api.isVisible);
  React.useEffect(() => {
    const d = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [props.api]);

  const sessionId = props.params?.sessionId;
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
          background: props.params?.accent ?? 'var(--faint)',
          zIndex: 1,
        }}
      />
      {sessionId ? (
        <div style={{ flex: 1, paddingInlineStart: 3, minInlineSize: 0 }}>
          <TerminalPane sessionId={sessionId} visible={visible} />
        </div>
      ) : (
        <span style={{ margin: 'auto' }}>{t('grid.cardBody', { title: props.api.title })}</span>
      )}
    </div>
  );
}

const components = { sessionCard: SessionCardPanel };

export interface GridController {
  /** create a session in `folder` and add its card (drag-drop, rail actions) */
  addSessionCard: (folder: string) => Promise<void>;
  /** focus an existing session's card */
  focusSession: (sessionId: string) => void;
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

  const addSessionCard = useCallback(async (folder: string) => {
    const api = apiRef.current;
    if (!api) return;
    const title = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? folder;
    const record = await window.switchboard.sessions.create({ folder, title });
    api.addPanel({
      id: `session-${record.id}`,
      component: 'sessionCard',
      title,
      params: {
        sessionId: record.id,
        accent: record.identity.accentColor,
        badge: record.identity.langBadge,
      } satisfies CardParams,
    });
  }, []);

  React.useEffect(() => {
    if (!props.controller) return;
    props.controller.current = {
      addSessionCard,
      focusSession: (sessionId) => {
        apiRef.current?.getPanel(`session-${sessionId}`)?.focus();
      },
    };
    // eslint's exhaustive-deps plugin isn't installed; deps kept accurate by hand
  }, [props.controller, addSessionCard]);

  const addCard = useCallback(async () => {
    // ⊕ flow: pick a folder, spawn, bind the card (E3-02/E3-04)
    const folder = await window.switchboard.sessions.pickFolder();
    if (!folder) return;
    await addSessionCard(folder);
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

      const saved = await window.switchboard.workspace.getLayout();
      if (saved) {
        try {
          api.fromJSON(saved as Parameters<DockviewApi['fromJSON']>[0]);
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
        const title = seedFolder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? seedFolder;
        const record = await window.switchboard.sessions.create({ folder: seedFolder, title });
        api.addPanel({
          id: `session-${record.id}`,
          component: 'sessionCard',
          title,
          params: {
            sessionId: record.id,
            accent: record.identity.accentColor,
            badge: record.identity.langBadge,
          } satisfies CardParams,
        });
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
