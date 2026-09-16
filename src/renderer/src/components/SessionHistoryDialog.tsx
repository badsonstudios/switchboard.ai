// The session-history picker (P2-E20-01, §5.33) — every past conversation in a
// folder, described well enough to recognise, and one click from being open.
//
// ── WHY A MODAL AND NOT AN ANCHORED DROPDOWN ───────────────────────────────
//
// The card's ⋯ menu is a hand-rolled `position: absolute` box, which is exactly
// the class of surface #641/#642 were filed about: a menu anchored to a card
// header on a four-way split runs past the viewport and becomes unreachable by
// mouse AND by Playwright. This list is searchable and up to 300 rows, so it is
// the worst possible candidate for that treatment. `CommandPalette` is the
// shape to copy — and copying it means this ships WITH listbox semantics rather
// than adding a third surface that lacks them (#828 is the composer popup's
// missing ones).
//
// ── WHAT THE ROWS MEAN ─────────────────────────────────────────────────────
//
// The description is the CLI's own `ai-title` when the conversation has one and
// its first user prompt when it does not — measured, not assumed
// (`spike/findings/e20-836-transcript-head.md`). They read differently on
// purpose: a title is a summary someone else wrote, a prompt is the user's own
// words, so a prompt row is quoted.
//
// A `claimed` row is one a card already has open. It is shown rather than
// hidden, and it is inert: hiding it would leave the user hunting for a
// conversation that is on screen behind them, while opening it would put two
// cards in one transcript — plain `--resume` appends rather than forking.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../shared/ipc/refusal';
import type { ConversationHistory, ConversationRow } from '../../../shared/session-history';

export interface HistoryPick {
  nativeId: string;
  folder: string;
}

export function SessionHistoryDialog(props: {
  open: boolean;
  /** the folder the picker opens scoped to */
  folder: string;
  onClose: () => void;
  onPick: (pick: HistoryPick) => void;
  /**
   * Offered as a row when the picker is standing between the user and a new
   * session (the `+ session` flow), so "actually, a fresh one" is never a
   * dead end they have to Escape out of and start again.
   */
  onNewConversation?: () => void;
}): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = React.useState('');
  const [scope, setScope] = React.useState<'folder' | 'all'>('folder');
  const [answer, setAnswer] = React.useState<ConversationHistory | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [selected, setSelected] = React.useState(0);
  const input = React.useRef<HTMLInputElement | null>(null);
  const selectedRow = React.useRef<HTMLDivElement | null>(null);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  // #654: ids here are IDREFs for `aria-controls` / `aria-activedescendant`, and
  // a stable published name can be captured by earlier content carrying the same
  // `id`. `useId` (plus the root's per-launch prefix) makes them unguessable;
  // tests select on `data-history-row` instead, which content cannot emit.
  const listId = React.useId();
  // `t` in a ref, so the fetch effect below does not depend on it. `t`'s
  // identity changes when the language changes or i18n re-initialises, and a
  // dependency on it would re-run a scan of every project on the machine to
  // restate a fallback sentence.
  const tr = React.useRef(t);
  tr.current = t;

  // Re-fetched on OPEN and on every scope change, never filtered from a stale
  // answer: a conversation that has been written to since the picker last ran
  // has a new position in the newest-first order, and possibly a title it did
  // not have before.
  React.useEffect(() => {
    if (!props.open) return;
    let live = true;
    setLoading(true);
    // Cleared HERE rather than on close, and that is the difference between a
    // component that happens to work and one that does. Resetting on close left
    // the list empty with nothing to refill it: this effect's deps had not
    // changed, so it did not re-run, and a dialog the parent keeps MOUNTED
    // (rather than unmounting, which is the only reason it worked) came back
    // permanently blank. Freshness belongs to whatever opens it.
    setAnswer(null);
    void window.switchboard.transcripts
      .history({ scope, folder: props.folder })
      .then((a) => {
        if (!live) return;
        // #440: a refused channel resolves a TRUTHY brand, so reading `a`
        // directly would show the refusal object as if it were a listing.
        setAnswer(answered(a) ?? { status: 'unknown', reason: t('sessionHistory.openFailed') });
      })
      .catch(() => {
        if (live) setAnswer({ status: 'unknown', reason: t('sessionHistory.openFailed') });
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      // The scope can change while a scan is in flight, and the slower answer
      // must not paint over the newer one.
      live = false;
    };
  }, [props.open, props.folder, scope, t]);

  React.useEffect(() => {
    if (!props.open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    input.current?.focus();
  }, [props.open]);

  // A fresh query never parks the selection past the end of the shorter list.
  React.useEffect(() => {
    setSelected(0);
  }, [query, scope, answer]);
  // Block-bodied on purpose: an expression body returns Chromium's promise,
  // React reads it as a cleanup function and the tree dies (pinned in
  // `e2e/palette.spec.ts` for the palette, and the same trap lives here).
  React.useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const rows: ConversationRow[] = React.useMemo(() => {
    if (!answer || answer.status !== 'ok') return [];
    const q = query.trim().toLowerCase();
    if (!q) return answer.rows;
    // Filtering is over the ANSWER, not the disk — typing does not re-scan.
    return answer.rows.filter(
      (r) =>
        r.description.toLowerCase().includes(q) ||
        r.folder.toLowerCase().includes(q) ||
        r.nativeId.toLowerCase().includes(q)
    );
  }, [answer, query]);

  if (!props.open) return null;

  const close = (): void => {
    setQuery('');
    setScope('folder');
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const pick = (row: ConversationRow | undefined): void => {
    // A claimed row is inert rather than absent — see the header.
    if (!row || row.claimed) return;
    setQuery('');
    setScope('folder');
    props.onPick({ nativeId: row.nativeId, folder: row.folder });
  };

  const move = (delta: number): void => {
    if (rows.length === 0) return;
    setSelected((prev) => (prev + delta + rows.length) % rows.length);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // This dialog owns its keys while open, including the command registry's
    // accelerators — the palette makes the same claim for the same reason.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      pick(rows[selected]);
    }
  };

  const unknown = answer && answer.status === 'unknown' ? answer.reason : null;
  const emptyText = scope === 'all' ? t('sessionHistory.emptyAll') : t('sessionHistory.empty');

  return (
    <div
      onMouseDown={close}
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
        aria-label={t('sessionHistory.title')}
        data-history-dialog
        onMouseDown={(e) => {
          e.stopPropagation();
          // Clicking the dialog's padding must not blur the input: the key
          // handling hangs off this subtree, so focus on <body> would make
          // Escape and the arrows dead. The palette and the composer agree.
          if (e.target !== input.current) e.preventDefault();
        }}
        onKeyDown={onKeyDown}
        style={{
          inlineSize: 'min(720px, 92vw)',
          maxBlockSize: '64vh',
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
        <div style={{ display: 'flex', alignItems: 'center', borderBlockEnd: '1px solid var(--border)' }}>
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('sessionHistory.placeholder')}
            aria-label={t('sessionHistory.placeholder')}
            role="combobox"
            aria-expanded
            aria-controls={`${listId}rows`}
            aria-activedescendant={rows[selected] ? `${listId}row-${rows[selected].nativeId}` : undefined}
            data-history-search
            style={{
              flex: 1,
              minInlineSize: 0,
              background: 'var(--panel2)',
              color: 'var(--text)',
              border: 'none',
              padding: '11px 14px',
              fontSize: 14,
              fontFamily: 'var(--font-ui)',
              outline: 'none',
            }}
          />
          {/* The scope toggle is the CLI picker's `ctrl+a`, given a surface.
              Folder-scoped by default, which is the CLI's own default and the
              reason the common case stays short (§5.33). */}
          <button
            data-history-scope={scope}
            aria-pressed={scope === 'all'}
            onClick={() => setScope((s) => (s === 'all' ? 'folder' : 'all'))}
            title={t('sessionHistory.scopeAllHint')}
            style={{
              background: scope === 'all' ? 'var(--chip)' : 'transparent',
              color: scope === 'all' ? 'var(--text)' : 'var(--muted)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-chip)',
              padding: '3px 10px',
              marginInline: 10,
              cursor: 'pointer',
              fontSize: 11,
              fontFamily: 'var(--font-ui)',
              whiteSpace: 'nowrap',
            }}
          >
            {scope === 'all' ? t('sessionHistory.scopeAll') : t('sessionHistory.scopeFolder')}
          </button>
        </div>

        <div data-history-rows id={`${listId}rows`} role="listbox" aria-label={t('sessionHistory.title')} style={{ overflowY: 'auto' }}>
          {loading && (
            <div data-history-loading style={{ padding: 14, color: 'var(--muted)', fontSize: 12 }}>
              {t('sessionHistory.loading')}
            </div>
          )}
          {/* An unreadable directory, or one past the 500 this will scan, is
              said OUT LOUD rather than rendered as an empty list — §5.33: a
              list that quietly omits what you wanted is worse than one that
              admits its limit. */}
          {!loading && unknown && (
            <div data-history-unknown style={{ padding: 14, color: 'var(--status-crashed-ink)', fontSize: 12 }}>
              {t('sessionHistory.unscannable', { reason: unknown })}
            </div>
          )}
          {!loading && !unknown && rows.length === 0 && (
            <div data-history-empty style={{ padding: 14, color: 'var(--muted)', fontSize: 12 }}>
              {query.trim() ? t('sessionHistory.noMatch', { query: query.trim() }) : emptyText}
            </div>
          )}
          {!loading &&
            rows.map((row, i) => (
              <div
                key={row.nativeId}
                id={`${listId}row-${row.nativeId}`}
                data-history-row={row.nativeId}
                role="option"
                aria-selected={i === selected}
                aria-disabled={row.claimed}
                ref={i === selected ? selectedRow : undefined}
                onMouseMove={() => setSelected(i)}
                onClick={() => pick(row)}
                title={row.claimed ? t('sessionHistory.claimedHint') : row.folder}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  padding: '8px 14px',
                  cursor: row.claimed ? 'default' : 'pointer',
                  background: i === selected ? 'var(--chip)' : 'transparent',
                  color: row.claimed ? 'var(--faint)' : 'var(--text)',
                  fontSize: 12.5,
                }}
              >
                <span style={{ flex: 1, minInlineSize: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.descriptionFrom === 'none' ? (
                    <span style={{ color: 'var(--faint)' }}>{t('sessionHistory.noDescription')}</span>
                  ) : (
                    // A first prompt is the user's own words, so it is quoted; a
                    // title is the CLI's summary of them and is not.
                    <span data-history-from={row.descriptionFrom}>
                      {row.descriptionFrom === 'prompt' ? `“${row.description}”` : row.description}
                    </span>
                  )}
                  {/* The folder earns its place only once the list spans more
                      than one (§5.33) — in folder scope every row would carry
                      the same path. */}
                  {scope === 'all' && (
                    <span data-history-folder style={{ marginInlineStart: 8, fontSize: 10.5, color: 'var(--muted)' }}>
                      {row.folder}
                    </span>
                  )}
                </span>
                {row.claimed && (
                  <span style={{ fontSize: 10, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {t('sessionHistory.claimed')}
                  </span>
                )}
                <span
                  title={t('sessionHistory.lastActive', { when: new Date(row.lastActiveMs).toLocaleString() })}
                  style={{ fontSize: 10.5, color: 'var(--muted)', whiteSpace: 'nowrap' }}
                >
                  {whenText(row.lastActiveMs, i18n.language)}
                </span>
              </div>
            ))}
          {/* Not a refusal: we looked, and this is the newest slice of what is
              there. Said so the user knows the list has an end rather than
              wondering why an old conversation is missing. */}
          {!loading && answer?.status === 'ok' && answer.truncated && (
            <div data-history-truncated style={{ padding: '8px 14px', color: 'var(--muted)', fontSize: 11 }}>
              {t('sessionHistory.truncated', { count: answer.rows.length })}
            </div>
          )}
        </div>

        {props.onNewConversation && (
          <button
            data-history-new
            onClick={() => {
              setQuery('');
              setScope('folder');
              props.onNewConversation?.();
            }}
            style={{
              background: 'transparent',
              color: 'var(--muted)',
              border: 'none',
              borderBlockStart: '1px solid var(--border)',
              padding: '9px 14px',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'var(--font-ui)',
              textAlign: 'start',
            }}
          >
            {t('sessionHistory.newConversation')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * When a conversation was last active, at the precision that helps.
 *
 * Today's conversations are told apart by their TIME and older ones by their
 * DATE — a bare date on six conversations from this afternoon distinguishes
 * none of them, and a time on one from March is noise. No relative-time helper
 * exists in this tree yet; the exact timestamp is on the row's `title`.
 */
function whenText(ms: number, locale: string | undefined): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString(locale || undefined, { timeStyle: 'short' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(locale || undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
