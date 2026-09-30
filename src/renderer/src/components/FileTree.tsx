// The Files tree — a view over a directory model (#521 layer 2, §5.35).
//
// ⚠️ THIS COMPONENT DOES NOT KNOW WHERE IT LIVES, and keeping that true is a
// requirement of the item rather than a matter of taste. The owner chose shape A
// (a Files tab on the session card) over shape B (Files as a document-area
// panel) knowing A's limitation — session tabs are exclusive, so you cannot
// browse the tree while watching the Feed — and chose it on the condition that B
// stays a later move rather than a rewrite. So: no `cardId`, no `sessionId`, no
// `PanelContext`, no dockview, no tab. Four props and a callback. `panels.tsx`
// is a three-line host over this, and a document-area home would be another
// three-line host.
//
// All of the layout arithmetic is in `lib/file-tree-model.ts`, including the
// notice rows. What is left here is: paint a row, answer a key, and re-list when
// the surface comes back into view.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DirListResult } from '../../../shared/ipc/fs';
import {
  applyListing,
  createTree,
  invalidate,
  isExpandable,
  isOpenable,
  openDirs,
  toggleDir,
  visibleRows,
  type TreeRow,
  type TreeState,
} from '../lib/file-tree-model';

/** One level of one directory. The bridge's shape, so a test can stub it. */
export type ListDir = (root: string, dir?: string) => Promise<DirListResult>;

const bridgeListDir: ListDir = (root, dir) => window.switchboard.files.listDir(root, dir);

/** px of indent per level — one ruler, used by the row and by nothing else. */
const INDENT = 14;

/** The glyph in front of a row. Decorative: every row also carries real text. */
function glyphFor(row: Extract<TreeRow, { type: 'entry' }>): string {
  if (row.kind === 'dir') return row.expanded ? '▾' : '▸';
  if (row.kind === 'link') return '⇥';
  if (row.kind === 'other') return '∘';
  return '·';
}

export function FileTree(props: {
  /**
   * The folder to browse — and the boundary every request declares.
   *
   * Main checks it against the read scope on every call and refuses anything
   * outside it, so this prop cannot grant access to a folder the app was not
   * already pointed at; it can only narrow one call further.
   */
  root: string;
  /** what to do with a clicked file — §5.30's placement policy, injected */
  onOpenFile: (absolutePath: string) => void;
  /**
   * Is this surface on screen?
   *
   * A VISIBILITY hint, deliberately not "is my tab selected": a host in the
   * document area would pass `true` and nothing here would change. It is what
   * drives the refresh-on-focus below — the only thing this tree does with the
   * knowledge that it was away for a while.
   */
  active?: boolean;
  /** the directory lister, injected so tests need no Electron bridge */
  listDir?: ListDir;
}): React.JSX.Element {
  const { t } = useTranslation();
  const list = props.listDir ?? bridgeListDir;
  const [state, setState] = React.useState<TreeState>(() => createTree(props.root));
  // Roving tabindex: ONE row is focusable at a time, which is what makes a tree
  // one tab stop instead of one per file (§5.32).
  const [cursor, setCursor] = React.useState<string | null>(null);
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  // Set while a key press moved the cursor, so focus follows the keyboard and
  // does NOT get yanked back on an unrelated re-render (a refresh, a listing
  // landing) — which would steal focus from wherever the user had gone next.
  const focusWanted = React.useRef(false);

  /**
   * Fetch one directory into the model.
   *
   * A ref-held guard, not state: two fetches for the same folder in one tick
   * (open it, then Refresh) must both resolve into the model, and the only thing
   * that matters is that an answer arriving after unmount is dropped.
   */
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetchDir = React.useCallback(
    (dir: string) => {
      const root = props.root;
      void list(root, dir === root ? undefined : dir)
        .then((result) => {
          if (alive.current) setState((s) => (s.root === root ? applyListing(s, dir, result) : s));
        })
        .catch(() => {
          // FAIL-OPEN. The bridge rejecting is our breakage, and a tree that
          // throws must not take the card with it — it shows the same row a
          // refusal shows, which is honest: we do not have the listing.
          if (alive.current) {
            setState((s) =>
              s.root === root ? applyListing(s, dir, { ok: false, reason: 'unreadable' }) : s
            );
          }
        });
    },
    [list, props.root]
  );

  // A new root is a new tree, not a refresh of the old one.
  React.useEffect(() => {
    setState(createTree(props.root));
    setCursor(null);
    fetchDir(props.root);
    // fetchDir is keyed on props.root, so this runs exactly once per folder
  }, [props.root, fetchDir]);

  const refresh = React.useCallback(() => {
    setState((s) => invalidate(s));
    // Read the open folders off the state we are refreshing rather than
    // capturing them: `openDirs` is the model's answer to "what is on screen",
    // and it is the same list `invalidate` just marked.
    setState((s) => {
      for (const dir of openDirs(s)) fetchDir(dir);
      return s;
    });
  }, [fetchDir]);

  /**
   * REFRESH ON BECOMING VISIBLE — and this is the whole of the "live" story.
   *
   * `FileWatchService` watches FILES BY SIGNATURE, not directories: it cannot
   * tell you an entry appeared, so there is no directory watch in this app and
   * none is claimed here. What the tab gets instead is a re-list when it comes
   * back into view and a Refresh button, which for the case this exists for —
   * glance at what the agent has been writing — is the moment the answer is
   * wanted anyway. `docs/manual/21-files.md` says exactly this, in those words.
   */
  const wasActive = React.useRef(props.active ?? true);
  React.useEffect(() => {
    const now = props.active ?? true;
    if (now && !wasActive.current) refresh();
    wasActive.current = now;
  }, [props.active, refresh]);

  const rows = visibleRows(state);
  const entryRows = rows.filter((r): r is Extract<TreeRow, { type: 'entry' }> => r.type === 'entry');
  // The cursor may have been on a row that a refresh removed; fall back to the
  // first row rather than leaving the tree with no tab stop at all.
  const activeKey = cursor && entryRows.some((r) => r.path === cursor) ? cursor : entryRows[0]?.path ?? null;

  React.useEffect(() => {
    if (!focusWanted.current || !activeKey) return;
    focusWanted.current = false;
    rowRefs.current.get(activeKey)?.focus();
  }, [activeKey, rows.length]);

  const open = React.useCallback(
    (row: Extract<TreeRow, { type: 'entry' }>) => {
      if (isExpandable(row.kind)) {
        const next = toggleDir(state, row.path);
        setState(next.state);
        if (next.fetch) fetchDir(row.path);
        return;
      }
      if (isOpenable(row.kind)) props.onOpenFile(row.path);
    },
    [state, fetchDir, props]
  );

  const move = (from: string | null, delta: number): void => {
    if (entryRows.length === 0) return;
    const at = entryRows.findIndex((r) => r.path === from);
    const next = at < 0 ? 0 : Math.min(entryRows.length - 1, Math.max(0, at + delta));
    focusWanted.current = true;
    setCursor(entryRows[next].path);
  };

  const onKeyDown = (e: React.KeyboardEvent, row: Extract<TreeRow, { type: 'entry' }>): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(row.path, 1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(row.path, -1);
        return;
      case 'Home':
        e.preventDefault();
        move(null, 0);
        return;
      case 'End':
        e.preventDefault();
        move(entryRows[entryRows.length - 1].path, 0);
        return;
      case 'ArrowRight':
        if (isExpandable(row.kind) && !row.expanded) {
          e.preventDefault();
          open(row);
        }
        return;
      case 'ArrowLeft':
        if (isExpandable(row.kind) && row.expanded) {
          e.preventDefault();
          open(row);
        }
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        open(row);
        return;
      default:
        return;
    }
  };

  const noticeText = (row: Extract<TreeRow, { type: 'notice' }>): string => {
    switch (row.notice) {
      case 'loading':
        return t('files.loading');
      case 'empty':
        return t('files.empty');
      case 'truncated':
        return t('files.capped', { n: row.cap ?? 0 });
      case 'error':
        return t(`files.refused.${row.reason ?? 'unreadable'}`);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        blockSize: '100%',
        minBlockSize: 0,
        background: 'var(--panel)',
        color: 'var(--text)',
      }}
      data-testid="file-tree"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          borderBlockEnd: '1px solid var(--border)',
          background: 'var(--panel2)',
          flex: '0 0 auto',
        }}
      >
        <span
          style={{
            flex: '1 1 auto',
            minInlineSize: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--muted)',
          }}
          // `direction: rtl` so a long path ellipsises on the LEFT and the
          // folder name — the part that identifies it — stays readable.
          title={props.root}
          data-testid="file-tree-root"
        >
          {props.root}
        </span>
        <button
          type="button"
          onClick={refresh}
          data-testid="file-tree-refresh"
          title={t('files.refreshHint')}
          style={{
            flex: '0 0 auto',
            background: 'transparent',
            color: 'var(--text)',
            border: '1px solid var(--control-edge)',
            borderRadius: 'var(--radius-chip)',
            padding: '2px 8px',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {t('files.refresh')}
        </button>
      </div>
      <div
        role="tree"
        aria-label={t('files.treeLabel')}
        style={{ flex: '1 1 auto', minBlockSize: 0, overflow: 'auto', padding: '4px 0' }}
        data-testid="file-tree-rows"
      >
        {rows.map((row) =>
          row.type === 'notice' ? (
            <div
              key={row.key}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-disabled
              style={{
                paddingInlineStart: 8 + row.depth * INDENT + 14,
                paddingBlock: 2,
                fontSize: 11,
                color: row.notice === 'error' ? 'var(--status-needs-input-ink)' : 'var(--faint)',
              }}
              data-testid={`file-tree-notice-${row.notice}`}
            >
              {noticeText(row)}
            </div>
          ) : (
            <div
              key={row.key}
              ref={(el) => {
                if (el) rowRefs.current.set(row.path, el);
                else rowRefs.current.delete(row.path);
              }}
              role="treeitem"
              aria-level={row.depth + 1}
              {...(isExpandable(row.kind) ? { 'aria-expanded': row.expanded } : {})}
              {...(isOpenable(row.kind) || isExpandable(row.kind) ? {} : { 'aria-disabled': true })}
              tabIndex={row.path === activeKey ? 0 : -1}
              onFocus={() => setCursor(row.path)}
              onKeyDown={(e) => onKeyDown(e, row)}
              onClick={() => {
                focusWanted.current = false;
                setCursor(row.path);
                open(row);
              }}
              title={
                row.kind === 'link'
                  ? t('files.linkHint', { name: row.name })
                  : row.kind === 'other'
                    ? t('files.otherHint', { name: row.name })
                    : row.name
              }
              data-testid={`file-tree-row-${row.kind}`}
              data-path={row.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                paddingInlineStart: 8 + row.depth * INDENT,
                paddingInlineEnd: 8,
                paddingBlock: 2,
                fontSize: 12,
                cursor: isOpenable(row.kind) || isExpandable(row.kind) ? 'pointer' : 'default',
                // A link and a device are shown but not offered — §5.8's rule
                // that you can always SEE what exists, applied to a row.
                color: row.kind === 'link' || row.kind === 'other' ? 'var(--muted)' : 'var(--text)',
                background: row.path === activeKey ? 'var(--rail-row-selected)' : 'transparent',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              <span aria-hidden style={{ inlineSize: 12, flex: '0 0 auto', color: 'var(--faint)' }}>
                {glyphFor(row)}
              </span>
              <span style={{ minInlineSize: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {row.name}
              </span>
              {row.kind === 'link' && (
                <span style={{ flex: '0 0 auto', fontSize: 10, color: 'var(--faint)' }}>
                  {t('files.linkTag')}
                </span>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
