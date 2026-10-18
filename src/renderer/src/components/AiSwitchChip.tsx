// The AI switch: a chip before the model chip, and its menu (E40 item 11,
// #1294; design record §5 screen 2, `mockups/multi-ai.html` #s2).
//
// The chip says which AI this card is on — its icon and its name. The menu lists
// every AI the catalog knows (#1291's `ais:list`): the ones this run can start
// are live, each with its login state and account; a missing one is dimmed with
// "set it up…"; one sentence says what switching does; "Manage AIs…" opens
// Settings. Choosing another AI switches THIS card (`sessions:switchAi`).
//
// ── THREE RULES THIS COMPONENT EXISTS TO KEEP ───────────────────────────────
//
// **1. It asks before it stops a turn.** Main refuses a busy card with what it
// is busy with, and the question is put HERE, in place of the list — #1127's
// confirm, in its house style: Cancel has the focus, and the yes cannot be
// pressed until it has been up long enough to be read (`STOP_ARM_MS`). Cancel
// changes nothing; the turn runs on.
//
// **2. Its words are §5.5's.** The sentence under the list never calls a first
// switch a resume; `lib/ai-switch-view.ts` owns every string's choice.
//
// **3. A switch in flight holds the menu open** — `ModelQuickMenu`'s note 4,
// for its reason: a refusal that arrives a moment later needs somewhere to be
// said. The chip is greyed, with a reason, for the same window.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MENU_EDGE_MARGIN, placeMenu, type MenuPlacement } from '../lib/menu-placement';
import { directionOf } from '../lib/writing-direction';
import { useAiList } from '../lib/ai-list';
import { aiMenuRows, MANAGE_AIS_TAB, type AiMenuRow, type SwitchAiNext } from '../lib/ai-switch-view';
import { openSettingsAt } from '../lib/settings-port';
import { STOP_ARM_MS } from './SessionHistoryDialog';
import { AiIcon } from './AiIcon';

export interface AiSwitchChipProps {
  /** the provider this card is on now */
  providerId: string;
  /** what that AI is called, as the session reports it (`sessions:controls`) */
  aiName?: string;
  /** a class for the chip, so it wears the composer row's look */
  className?: string;
  /** greyed with this reason, or null when it can be used */
  unavailable?: string | null;
  /**
   * Switch this card to `providerId`. The SessionGrid's: it owns the re-arm of
   * the card's start, which nothing in the composer can reach.
   */
  onSwitch: (providerId: string, stopFirst: boolean) => Promise<SwitchAiNext>;
}

/**
 * An AI's icon: the shared `AiIcon` (#1293), so the chip and its menu draw an
 * AI exactly as its tab, rail card and header do — the catalog's mark, or the
 * neutral tile with the initial when there is none or it does not load.
 */
function AiGlyph({
  row,
  size,
}: {
  row: Pick<AiMenuRow, 'icon' | 'ink' | 'name'> | undefined;
  size: number;
}): React.JSX.Element | null {
  if (!row) return null;
  return (
    <AiIcon
      look={{
        name: row.name,
        iconUrl: row.icon,
        ...(row.ink ? { ink: row.ink } : {}),
        initial: (row.name.trim()[0] ?? '?').toUpperCase(),
      }}
      size={size}
    />
  );
}

export function AiSwitchChip(props: AiSwitchChipProps): React.JSX.Element {
  const { t } = useTranslation();
  const { providerId, aiName, onSwitch, unavailable = null } = props;
  const chip = React.useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
  const [busy, setBusy] = React.useState(false);
  // the list is asked for once the chip exists, so the chip can wear the icon
  const items = useAiList(true);
  const rows = React.useMemo(
    () => aiMenuRows(items ?? [], providerId, aiName ?? providerId),
    [items, providerId, aiName]
  );
  const current = rows.find((r) => r.current);
  const name = current?.name || aiName || providerId;

  const close = (): void => {
    setAnchor(null);
    chip.current?.focus();
  };
  const reason = busy ? t('aiSwitch.chipBusy') : unavailable;
  return (
    <>
      <span title={reason ?? undefined} data-unavailable-reason={reason ? '' : undefined}>
        <button
          ref={chip}
          type="button"
          data-testid="composer-ai"
          data-provider={providerId}
          aria-haspopup="menu"
          aria-expanded={anchor !== null}
          disabled={reason !== null}
          title={reason ?? t('aiSwitch.chipHint', { ai: name })}
          className={props.className}
          onClick={(e) => {
            if (anchor) return close();
            setAnchor(e.currentTarget.getBoundingClientRect());
          }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minInlineSize: 0 }}
        >
          <AiGlyph row={current} size={12} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        </button>
      </span>
      {anchor && (
        <AiSwitchMenu
          anchor={anchor}
          rows={rows}
          listKnown={items !== null}
          currentName={name}
          onClose={close}
          onBusyChange={setBusy}
          onSwitch={onSwitch}
        />
      )}
    </>
  );
}

interface MenuProps {
  anchor: { x: number; y: number; width: number; height: number };
  rows: AiMenuRow[];
  /** the catalog answered; false = only the card's own AI is known */
  listKnown: boolean;
  currentName: string;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onSwitch: (providerId: string, stopFirst: boolean) => Promise<SwitchAiNext>;
}

export function AiSwitchMenu(props: MenuProps): React.JSX.Element {
  const { t } = useTranslation();
  const { anchor, rows, onClose, onBusyChange, onSwitch } = props;
  const menu = React.useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = React.useState<MenuPlacement | null>(null);
  /** the AI a switch is on the wire to — the whole double-send guard */
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  /** the question, when main said the session is busy (rule 1) */
  const [ask, setAsk] = React.useState<{ row: AiMenuRow; busy: 'working' | 'waiting' } | null>(null);
  const [armed, setArmed] = React.useState(false);
  const cancelAsk = React.useRef<HTMLButtonElement | null>(null);
  const askTextId = React.useId();
  const explainId = React.useId();

  React.useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const direction = directionOf(el);
    const root = el.ownerDocument.documentElement;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const x = direction === 'rtl' ? anchor.x + anchor.width : anchor.x;
    const below = anchor.y + anchor.height;
    const roomBelow = below + size.height <= root.clientHeight - MENU_EDGE_MARGIN;
    setPlace(
      placeMenu(
        { x, y: roomBelow ? below : anchor.y },
        size,
        { width: root.clientWidth, height: root.clientHeight },
        { direction }
      )
    );
  }, [anchor, rows, notice, busy, ask]);

  // The keyboard goes to the first live row once the menu is placed; to Cancel
  // while a question is up — the next Enter must land on "no" (#1127).
  const focused = React.useRef(false);
  /** the row a question was asked about — where the keyboard goes on "no" */
  const askedAbout = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    if (!place) return;
    const box = menu.current;
    if (!box) return;
    if (ask) {
      askedAbout.current = ask.row.key;
      return void cancelAsk.current?.focus();
    }
    // The question went away with the button that had the focus. Hand the
    // keyboard back to the row it was about, or Escape would land on <body>
    // and never reach this menu (found by the e2e).
    const back = askedAbout.current;
    if (back) {
      askedAbout.current = null;
      const row = Array.from(box.querySelectorAll<HTMLElement>('[data-ai-row]')).find((el) => el.dataset.aiRow === back);
      return void (row ?? box).focus();
    }
    if (focused.current) return;
    const first =
      box.querySelector<HTMLElement>('[role^="menuitem"][aria-checked="true"]') ??
      box.querySelector<HTMLElement>('[role^="menuitem"]');
    focused.current = true;
    (first ?? box).focus();
  }, [place, ask]);

  // The yes is not pressable the instant it appears (#1127's `STOP_ARM_MS`).
  React.useEffect(() => {
    setArmed(false);
    if (!ask) return;
    const id = window.setTimeout(() => setArmed(true), STOP_ARM_MS);
    return () => window.clearTimeout(id);
  }, [ask]);

  // a disabled row loses focus to <body>: park it on the box while a switch is out
  React.useLayoutEffect(() => {
    if (busy) menu.current?.focus();
  }, [busy]);

  React.useEffect(() => {
    const view = menu.current?.ownerDocument.defaultView;
    if (!view) return;
    const go = (): void => close();
    view.addEventListener('resize', go);
    return () => view.removeEventListener('resize', go);
  });

  const close = (): void => {
    if (busy) return;
    onClose();
  };

  const go = (row: AiMenuRow, stopFirst: boolean): void => {
    if (busy || !row.providerId) return;
    if (row.current) return onClose();
    setBusy(row.providerId);
    onBusyChange(true);
    setNotice(null);
    setAsk(null);
    void onSwitch(row.providerId, stopFirst)
      .catch((): SwitchAiNext => ({ kind: 'notice', key: 'aiSwitch.refusedFailed' }))
      .then((next) => {
        setBusy(null);
        onBusyChange(false);
        if (next.kind === 'ask') return setAsk({ row, busy: next.busy });
        if (next.kind === 'notice') return setNotice(t(next.key, { ai: row.name }));
        onClose();
      });
  };

  const manage = (): void => {
    if (busy) return;
    onClose();
    openSettingsAt(MANAGE_AIS_TAB);
  };

  const item: React.CSSProperties = {
    display: 'flex',
    inlineSize: '100%',
    alignItems: 'center',
    gap: 8,
    textAlign: 'start',
    padding: '5px 9px',
    border: 'none',
    borderRadius: 6,
    background: 'transparent',
    color: 'var(--text)',
    font: 'inherit',
    fontFamily: 'var(--font-ui)',
    cursor: busy ? 'default' : 'pointer',
  };
  const sub: React.CSSProperties = {
    display: 'block',
    fontSize: 10,
    color: 'var(--muted)',
    marginBlockStart: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const rule: React.CSSProperties = { borderBlockStart: '1px solid var(--border)', marginBlock: 4 };
  const confirmBtn: React.CSSProperties = {
    background: 'var(--chip)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    color: 'var(--text)',
    fontFamily: 'var(--font-ui)',
    fontSize: 11.5,
    padding: '3px 10px',
    cursor: 'pointer',
  };

  return (
    <>
      <div
        data-ai-menu-scrim
        onPointerDown={(e) => {
          e.preventDefault();
          close();
        }}
        style={{ position: 'fixed', inset: 0, zIndex: 49 }}
      />
      <div
        ref={menu}
        aria-label={t('aiSwitch.menuLabel')}
        aria-busy={busy !== null}
        data-testid="ai-switch-menu"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            // Escape on the question answers it "no", like its Cancel
            if (ask) return setAsk(null);
            close();
            return;
          }
          if (e.key === 'Tab') {
            if (!ask) close();
            return;
          }
          if (ask) return;
          const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
          if (items.length === 0) return;
          const at = items.indexOf(e.currentTarget.ownerDocument.activeElement as HTMLElement);
          const wrap = (n: number): number => (n + items.length) % items.length;
          const next =
            e.key === 'ArrowDown'
              ? at < 0
                ? 0
                : wrap(at + 1)
              : e.key === 'ArrowUp'
                ? at < 0
                  ? items.length - 1
                  : wrap(at - 1)
                : e.key === 'Home'
                  ? 0
                  : e.key === 'End'
                    ? items.length - 1
                    : null;
          if (next === null) return;
          e.preventDefault();
          items[next].focus();
        }}
        style={{
          position: 'fixed',
          insetInlineStart: place ? place.insetInlineStart : 0,
          insetBlockStart: place ? place.insetBlockStart : 0,
          visibility: place ? undefined : 'hidden',
          maxBlockSize: place?.maxBlockSize,
          overflowY: 'auto',
          zIndex: 50,
          minInlineSize: 240,
          maxInlineSize: 380,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          boxShadow: 'var(--tab-lift)',
          padding: 4,
          color: 'var(--text)',
          fontFamily: 'var(--font-ui)',
          fontSize: 11.5,
          outline: 'none',
        }}
      >
        <p
          style={{
            margin: 0,
            padding: '4px 9px 2px',
            fontSize: 9.5,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
          }}
        >
          {t('aiSwitch.heading')}
        </p>
        {ask ? (
          // THE QUESTION, in place of the list (#1127): nothing else to pick by
          // accident while it is up. A labelled GROUP inside the menu, like the
          // composer's own Clear confirmation — not a dialog: it opens no layer
          // of its own, and the focus is already handed to its Cancel.
          <div
            data-ai-switch-confirm
            role="group"
            aria-label={t('aiSwitch.stopTitle')}
            aria-describedby={askTextId}
            style={{ padding: '8px 9px', display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <span id={askTextId} style={{ color: 'var(--status-crashed-ink)', whiteSpace: 'normal' }}>
              {t(ask.busy === 'working' ? 'aiSwitch.stopWorking' : 'aiSwitch.stopWaiting')}
            </span>
            <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                ref={cancelAsk}
                type="button"
                data-ai-switch-confirm-cancel
                onClick={() => setAsk(null)}
                style={confirmBtn}
              >
                {t('aiSwitch.stopCancel')}
              </button>
              <button
                type="button"
                data-ai-switch-confirm-ok
                disabled={!armed}
                onClick={() => go(ask.row, true)}
                style={armed ? confirmBtn : { ...confirmBtn, color: 'var(--faint)', cursor: 'default' }}
              >
                {t('aiSwitch.stopConfirm')}
              </button>
            </span>
          </div>
        ) : (
          // The sentence is DESCRIBED onto the menu as well as drawn in it: a
          // menu's non-item children are a reader's to prune.
          <div role="menu" aria-label={t('aiSwitch.menuLabel')} aria-describedby={explainId}>
            {props.rows.map((row) =>
              row.missing ? (
                // DIMMED, NOT DEAD: it says why and offers the way to fix it.
                // `--muted` ink, never opacity (the house rule
                // `opacity-dims.test.ts` enforces), and the words carry the
                // state so it reads without colour.
                <button
                  key={row.key}
                  type="button"
                  role="menuitem"
                  data-ai-row={row.key}
                  data-missing="yes"
                  disabled={busy !== null}
                  onClick={manage}
                  style={{ ...item, color: 'var(--muted)' }}
                >
                  <span aria-hidden style={{ display: 'inline-block', inlineSize: 12 }} />
                  <AiGlyph row={row} size={16} />
                  <span style={{ flex: 1, minInlineSize: 0 }}>
                    <span>{row.name}</span>
                    <span style={sub}>
                      {t('aiSwitch.missingLine', { state: t(row.sub.key, row.sub.vars), setUp: t('aiSwitch.setUp') })}
                    </span>
                  </span>
                </button>
              ) : (
                <button
                  key={row.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={row.current}
                  data-ai-row={row.key}
                  data-current={row.current ? 'yes' : undefined}
                  disabled={busy !== null}
                  onClick={() => go(row, false)}
                  style={item}
                >
                  <span aria-hidden style={{ display: 'inline-block', inlineSize: 12 }}>
                    {row.current ? t('aiSwitch.currentMark') : ''}
                  </span>
                  <AiGlyph row={row} size={16} />
                  <span style={{ flex: 1, minInlineSize: 0 }}>
                    <span style={{ fontWeight: row.current ? 700 : 400 }}>{row.name}</span>
                    <span style={sub}>{t(row.sub.key, row.sub.vars)}</span>
                  </span>
                  {busy === row.providerId && (
                    <span style={{ fontSize: 10, color: 'var(--muted)' }}>{t('aiSwitch.switching')}</span>
                  )}
                </button>
              )
            )}
            <div role="separator" style={rule} />
            <p
              id={explainId}
              data-ai-switch-explain
              style={{ margin: 0, padding: '2px 9px 4px', fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'normal' }}
            >
              {props.listKnown ? t('aiSwitch.explain') : t('aiSwitch.noList', { ai: props.currentName })}
            </p>
            <div role="separator" style={rule} />
            <button
              type="button"
              role="menuitem"
              data-ai-manage
              disabled={busy !== null}
              onClick={manage}
              style={item}
            >
              <span aria-hidden style={{ display: 'inline-block', inlineSize: 12 }} />
              {t('aiSwitch.manage')}
            </button>
          </div>
        )}
        <p
          data-ai-switch-notice
          role="status"
          style={{
            margin: 0,
            padding: notice ? '6px 9px' : 0,
            marginBlockStart: notice ? 2 : 0,
            borderBlockStart: notice ? '1px solid var(--border)' : undefined,
            fontSize: 10.5,
            whiteSpace: 'pre-wrap',
            color: 'var(--status-crashed-ink)',
          }}
        >
          {notice}
        </p>
      </div>
    </>
  );
}
