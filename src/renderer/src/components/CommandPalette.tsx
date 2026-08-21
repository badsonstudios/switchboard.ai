// Command palette (P2-E9-02, DESIGN §5.8/§8). A fuzzy-filter list over the
// E9-01 command registry — the guarantee that hiding chrome never removes
// capability: everything the app can do is here, with its key beside it.
//
// Rendering only. What the rows ARE lives in lib/palette.ts (pure, tested);
// which key opens this lives in the registry, like every other binding.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Command, CommandContext, formatBinding, Platform } from '../lib/commands';
import { filterRows, firstRunnable, PaletteRow, paletteRows } from '../lib/palette';

export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  /** read at OPEN time so the rows reflect the workspace as it is right now */
  contextOf: () => CommandContext;
  focusCard: (cardId: string) => void;
  platform: Platform;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState(0);
  const input = React.useRef<HTMLInputElement | null>(null);
  const selectedRow = React.useRef<HTMLDivElement | null>(null);
  // where focus was before we stole it — restored on close, so closing the
  // palette never strands the user with nothing focused
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  /**
   * The prefix for every `id` in this palette (#654).
   *
   * `<label for>` was the reason that item existed, and this component has no
   * label — but it has the OTHER id consumer, and OF THE THREE COMPONENTS #654
   * TOUCHED THIS IS THE ONE THAT WAS LIVE. `aria-activedescendant` and
   * `aria-controls` are IDREFs; an IDREF resolves to the FIRST element in tree
   * order carrying that id, so a forgery only captures if it is EARLIER. `id`
   * survives the sanitizer profile (see `markdown.tsx`), and `App.tsx` renders
   * `UpdateDialog` — which puts GitHub's RELEASE NOTES through `<Markdown>` —
   * IMMEDIATELY BEFORE this palette. So release-notes content containing
   * `<div id="palette-row-quit">Open a file</div>` really did sit above these
   * refs and capture them: verified in Chromium 149, where the combobox's
   * `activedescendant` relation resolved to the planted `<div>` — with no
   * `role` on it, because content cannot write one. The screen-reader user is
   * then told the highlighted command is whatever the notes said, while Enter
   * still runs the real one. That is #509's harm exactly (a lie the sighted
   * reader cannot see) reached through a NAME rather than an attribute. (The
   * feed and the viewer render AFTER this component and never could.)
   *
   * `React.useId()` is not a secret — React 19 numbers client ids from a
   * module-global counter — so what this removes is a STABLE, PUBLISHED name.
   */
  const paletteId = React.useId();

  const rows: PaletteRow[] = React.useMemo(() => {
    if (!props.open) return [];
    return paletteRows({
      // "Show all commands" is what got us here — listing it would let Enter
      // re-open the palette on top of itself
      commands: props.commands.filter((c) => c.id !== 'palette.open'),
      ctx: props.contextOf(),
      translate: (key, params) => t(key, params ?? {}),
      focusCard: props.focusCard,
    });
    // re-read the context on every OPEN (props.open in the deps)
  }, [props.open, props.commands, props.contextOf, props.focusCard, t]);

  const visible = React.useMemo(() => filterRows(query, rows), [query, rows]);

  React.useEffect(() => {
    if (!props.open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    input.current?.focus();
  }, [props.open]);

  // a fresh query never parks the selection on an inert row
  React.useEffect(() => {
    setSelected(Math.max(0, firstRunnable(visible)));
  }, [query, rows]);
  React.useEffect(() => { selectedRow.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);

  if (!props.open) return null;

  /**
   * `restoreFocus` is false when a command ran: the command decides where focus
   * belongs (jumping to a session focuses ITS card), and restoring afterwards
   * would drop the user back in the surface they just navigated away from.
   */
  const close = (restoreFocus: boolean): void => {
    setQuery(''); // clear on CLOSE, so re-opening never flashes a stale list
    props.onClose();
    if (!restoreFocus) return;
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const run = (row: PaletteRow | undefined): void => {
    if (!row || !row.enabled) return;
    close(false);
    row.run();
  };

  const move = (delta: number): void => {
    if (visible.length === 0) return;
    setSelected((prev) => (prev + delta + visible.length) % visible.length);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // the palette owns its keys while open — including the registry's own
    // accelerators, which must not fire underneath it (App also gates the
    // dispatcher on `open`, for keys that never reach this handler)
    e.stopPropagation();
    const mod = props.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault(); // the open hotkey toggles, as everyone expects
      close(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      run(visible[selected]);
    }
  };

  return (
    <div
      onMouseDown={() => close(true)} // click-away
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '12vh',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.label')}
        onMouseDown={(e) => {
          e.stopPropagation();
          // clicking the dialog's padding (or a row) must not blur the input:
          // key handling hangs off this subtree, and focus on <body> would make
          // Escape and the arrows dead. Same trick the composer uses.
          if (e.target !== input.current) e.preventDefault();
        }}
        onKeyDown={onKeyDown}
        style={{
          inlineSize: 'min(620px, 90vw)',
          maxBlockSize: '60vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          overflow: 'hidden',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('palette.placeholder')}
          aria-label={t('palette.placeholder')}
          role="combobox"
          aria-expanded
          aria-controls={`${paletteId}rows`}
          aria-activedescendant={
            visible[selected] ? `${paletteId}row-${visible[selected].id}` : undefined
          }
          style={{
            background: 'var(--panel2)',
            color: 'var(--text)',
            border: 'none',
            borderBlockEnd: '1px solid var(--border)',
            padding: '11px 14px',
            fontSize: 14,
            fontFamily: 'var(--font-ui)',
            outline: 'none',
          }}
        />
        {/* `data-palette-rows` / `data-palette-row` are the TEST HOOKS, and they
            exist because the ids above stopped being nameable (#654). They are
            the same shape `data-push-field` and `data-quiet-field` already use,
            and they are safe to select on for the reason those are: content
            cannot emit a `data-*` attribute at all (`ALLOW_DATA_ATTR: false`),
            so a hook is not a second guessable name. */}
        <div
          data-palette-rows
          id={`${paletteId}rows`}
          role="listbox"
          aria-label={t('palette.label')}
          style={{ overflowY: 'auto' }}
        >
          {visible.length === 0 && (
            <div style={{ padding: '14px', color: 'var(--muted)', fontSize: 12 }}>
              {t('palette.empty')}
            </div>
          )}
          {visible.map((row, i) => (
            <div
              key={row.id}
              id={`${paletteId}row-${row.id}`}
              data-palette-row={row.id}
              role="option"
              aria-selected={i === selected}
              aria-disabled={!row.enabled}
              ref={i === selected ? selectedRow : undefined}
              onMouseMove={() => setSelected(i)}
              onClick={() => run(row)}
              title={!row.enabled && row.disabledReasonKey ? t(row.disabledReasonKey) : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 14px',
                cursor: row.enabled ? 'pointer' : 'default',
                background: i === selected ? 'var(--chip)' : 'transparent',
                color: row.enabled ? 'var(--text)' : 'var(--faint)',
                fontSize: 12.5,
              }}
            >
              <span style={{ flex: 1, minInlineSize: 0 }}>
                <Highlighted text={row.title} indices={row.indices} />
                {!row.enabled && row.disabledReasonKey && (
                  <span style={{ marginInlineStart: 8, fontSize: 10.5, color: 'var(--faint)' }}>
                    {t(row.disabledReasonKey)}
                  </span>
                )}
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                }}
              >
                {t(row.categoryKey)}
              </span>
              {row.binding && (
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    color: 'var(--muted)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '1px 5px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatBinding(row.binding, props.platform)}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** bolds the characters the query matched */
function Highlighted(props: { text: string; indices: number[] }): React.JSX.Element {
  if (props.indices.length === 0) return <>{props.text}</>;
  const hit = new Set(props.indices);
  return (
    <>
      {[...props.text].map((ch, i) =>
        hit.has(i) ? (
          <strong key={i} style={{ color: 'var(--text)', fontWeight: 700 }}>
            {ch}
          </strong>
        ) : (
          <span key={i}>{ch}</span>
        )
      )}
    </>
  );
}
