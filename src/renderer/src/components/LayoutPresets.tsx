// The one-click arrangements, as a row of small pictures in the top bar
// (#1147), and "make them even" at the end of the row.
//
// The owner: "We should have an icon for the different ways we can dock —
// across from each other, above each other, etc." Each button is a drawing of
// the shape it makes, because that is the whole instruction: there is nothing
// to read. The words are in the tooltip and the accessible name, and the same
// six are in the command list (lib/command-set), so no capability is in the
// mouse alone.
//
// ONE joined block of narrow cells, not separate chips, and FIVE of them, not
// six. That is arithmetic (#879 / #885 again): the bar is held to the width of
// the narrowest CI window, and the first version of this — six 25px cells —
// measured 149px against the 58px chip it replaced and left the bar with
// nothing to spare on Windows, which is an overflow on the Linux runner
// (its fonts are wider). So the cells are 20px, and "one place, every
// session as a tab" is in the command list only: it is the arrangement you
// start from, and the owner asked for 2-up, 3-up, rows, grid and even.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { LAYOUT_PRESETS, LayoutPreset } from '../lib/layout-presets';

/** the ones with a button; every one of LAYOUT_PRESETS has a command */
export const BAR_PRESETS: readonly LayoutPreset[] = LAYOUT_PRESETS.filter((p) => p !== 'single');

const W = 14;
const H = 11;

/** the outline every picture shares: the workspace */
const Frame = (props: { children?: React.ReactNode }): React.JSX.Element => (
  <svg
    aria-hidden
    width={W}
    height={H}
    viewBox={`0 0 ${W} ${H}`}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.2}
    style={{ display: 'block' }}
  >
    <rect x={0.6} y={0.6} width={W - 1.2} height={H - 1.2} rx={1.5} />
    {props.children}
  </svg>
);

const v = (x: number, y1 = 0.6, y2 = H - 0.6): React.JSX.Element => (
  <line x1={x} y1={y1} x2={x} y2={y2} />
);
const h = (y: number): React.JSX.Element => <line x1={0.6} y1={y} x2={W - 0.6} y2={y} />;

const PICTURE: Record<LayoutPreset, React.JSX.Element> = {
  single: <Frame />,
  columns2: <Frame>{v(W / 2)}</Frame>,
  columns3: (
    <Frame>
      {v(W / 3)}
      {v((2 * W) / 3)}
    </Frame>
  ),
  rows: <Frame>{h(H / 2)}</Frame>,
  grid: (
    <Frame>
      {v(W / 2)}
      {h(H / 2)}
    </Frame>
  ),
};

/** two arrows pushing a divider back to the middle */
const EvenPicture = (): React.JSX.Element => (
  <svg
    aria-hidden
    width={W}
    height={H}
    viewBox={`0 0 ${W} ${H}`}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: 'block' }}
  >
    <line x1={W / 2} y1={0.6} x2={W / 2} y2={H - 0.6} />
    <polyline points={`1.2,${H / 2} 5.6,${H / 2}`} />
    <polyline points={`3.6,${H / 2 - 2} 5.6,${H / 2} 3.6,${H / 2 + 2}`} />
    <polyline points={`${W - 1.2},${H / 2} ${W - 5.6},${H / 2}`} />
    <polyline points={`${W - 3.6},${H / 2 - 2} ${W - 5.6},${H / 2} ${W - 3.6},${H / 2 + 2}`} />
  </svg>
);

const cell = (first: boolean, disabled: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  color: disabled ? 'var(--muted)' : 'var(--text)',
  border: 'none',
  borderInlineStart: first ? 'none' : '1px solid var(--border)',
  padding: '5px 3px',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.55 : 1,
});

export function LayoutPresets(props: {
  onPreset: (preset: LayoutPreset) => void;
  onEqualize: () => void;
  /** fewer than two things open in the workspace: there is nothing to arrange.
   *  The buttons stay, dimmed and still reachable, and say why. */
  disabled: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const why = props.disabled ? t('layout.presetsNothing') : undefined;
  return (
    <div
      role="group"
      aria-label={t('layout.presetsLabel')}
      data-testid="layout-presets"
      style={{
        display: 'flex',
        flex: 'none',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-chip)',
        overflow: 'hidden',
      }}
    >
      {BAR_PRESETS.map((p, i) => (
        <button
          key={p}
          type="button"
          className="layout-preset"
          data-layout-preset={p}
          // `aria-disabled`, not `disabled`: it has to stay findable with Tab
          // to be able to say why it does nothing (the Chip's rule)
          aria-disabled={props.disabled ? true : undefined}
          aria-label={t(`layout.preset.${p}`)}
          title={why ? `${t(`layout.preset.${p}`)}. ${why}` : t(`layout.preset.${p}`)}
          onClick={() => {
            if (!props.disabled) props.onPreset(p);
          }}
          style={cell(i === 0, props.disabled)}
        >
          {PICTURE[p]}
        </button>
      ))}
      <button
        type="button"
        className="layout-preset"
        data-layout-preset="equalize"
        aria-disabled={props.disabled ? true : undefined}
        aria-label={t('layout.equalize')}
        title={why ? `${t('layout.equalize')}. ${why}` : t('layout.equalizeHint')}
        onClick={() => {
          if (!props.disabled) props.onEqualize();
        }}
        style={cell(false, props.disabled)}
      >
        <EvenPicture />
      </button>
    </div>
  );
}
