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

function SessionCardPanel(props: IDockviewPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      style={{
        blockSize: '100%',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--card-bg)',
        color: 'var(--muted)',
        fontSize: 11,
        position: 'relative',
      }}
    >
      <span
        style={{
          position: 'absolute',
          insetInlineStart: 0,
          insetBlockStart: 0,
          insetBlockEnd: 0,
          inlineSize: 3,
          background: 'var(--accent-blue)',
        }}
      />
      <span>{t('grid.cardBody', { title: props.api.title })}</span>
    </div>
  );
}

const components = { sessionCard: SessionCardPanel };

export function SessionGrid(props: {
  theme: 'nordic' | 'daylight';
  seedPanels: number;
  onCardsChanged: (ids: string[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const apiRef = useRef<DockviewApi | null>(null);
  const counter = useRef(0);

  const addCard = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    counter.current += 1;
    const id = `card-${Date.now()}-${counter.current}`;
    api.addPanel({
      id,
      component: 'sessionCard',
      title: t('grid.cardTitle', { n: api.panels.length + 1 }),
    });
  }, [t]);

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
          onClick={addCard}
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
          onReady={(e: DockviewReadyEvent) => void onReady(e)}
          className={props.theme === 'daylight' ? 'dockview-theme-light' : 'dockview-theme-dark'}
        />
      </div>
    </main>
  );
}
