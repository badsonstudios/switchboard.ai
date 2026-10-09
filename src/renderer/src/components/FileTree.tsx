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
import { LETTER_INKS } from './ScmSidebar';
import { getGitStatus, refreshGitStatus, subscribeGitStatus } from '../lib/git-status-store';
import { decorationsFor, type Decoration } from '../lib/vcs-decorations';
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
  /**
   * Room to leave at the end of each row, in px (#1105).
   *
   * The git letter is the last thing on a row, and a host may have something
   * drawn over its edge. This component still does not know where it lives —
   * the host says how much room it needs and why is the host's business.
   */
  rowEndInset?: number;
  /** the directory lister, injected so tests need no Electron bridge */
  listDir?: ListDir;
  /**
   * The git decorations for this folder, injected (E24 Git v2 item 11).
   *
   * ⚠️ **INJECTED SO THE TREE STILL DOES NOT KNOW WHERE IT LIVES.** This file's
   * header states that as a requirement of the item that built it — no `cardId`,
   * no `sessionId`, no `PanelContext`. Absent means no decorations, which is a
   * tree that works exactly as it did; the default reads the shared store, which
   * is what makes the Files tab and the Changes tab agree (design §4 item 11).
   */
  decorations?: Map<string, Decoration>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const list = props.listDir ?? bridgeListDir;
  const [state, setState] = React.useState<TreeState>(() => createTree(props.root));
  /**
   * The decorations, from the ONE shared status (E24 Git v2 item 11).
   *
   * `useSyncExternalStore` over the store rather than a fetch of its own, which is
   * the whole point: two tabs reading one answer cannot disagree about whether a
   * file is modified. An injected prop wins, for tests.
   */
  const shared = React.useSyncExternalStore(subscribeGitStatus, () => getGitStatus(props.root));
  /**
   * ⚠️ **KEYED OFF THE ROOT MAIN *RESOLVED*, NOT THE ONE WE ASKED FOR, AND CI IS
   * WHAT FOUND IT.** Every row's `path` is built by main from the realpath'd
   * directory, so on a machine where the two differ — a symlink, a junction, or
   * an **8.3 short name** such as the GitHub Windows runner's
   * `C:\Users\RUNNER~1\AppData\Local\Temp` — a decoration map keyed by
   * `props.root` shares no prefix with any row and EVERY badge silently vanishes.
   * That is what the Files-tab badge test was failing on, deterministically,
   * while passing on every developer machine.
   *
   * `state.resolvedRoot` is `undefined` until the root listing lands, and falling
   * back to `props.root` for that frame is right: there are no rows to decorate
   * yet either. The git STATUS is still keyed by `props.root`, which is correct —
   * that is the folder the session declared and the key the shared store uses.
   */
  const decorations = React.useMemo(
    () => props.decorations ?? decorationsFor(state.resolvedRoot ?? props.root, shared),
    [props.decorations, props.root, state.resolvedRoot, shared]
  );
  const onOpenFile = props.onOpenFile;
  // Roving tabindex: ONE row is focusable at a time, which is what makes a tree
  // one tab stop instead of one per file (§5.32).
  const [cursor, setCursor] = React.useState<string | null>(null);
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  // Set while a key press moved the cursor, so focus follows the keyboard and
  // does NOT get yanked back on an unrelated re-render (a refresh, a listing
  // landing) — which would steal focus from wherever the user had gone next.
  const focusWanted = React.useRef(false);

  /**
   * Which round of asking we are on.
   *
   * Bumped by a root change and by every refresh, and carried into each fetch,
   * so an answer from a superseded round is DROPPED rather than written over a
   * fresher one. Without it, two quick presses of Refresh can land round 1's
   * listing after round 2's and show older data with nothing to say so.
   *
   * It doubles as the after-unmount guard, which is why there is no separate
   * `alive` flag: the cleanup sets it to a value no in-flight fetch is holding.
   */
  const gen = React.useRef(0);
  React.useEffect(() => {
    return () => {
      gen.current += 1;
    };
  }, []);

  const fetchDir = React.useCallback(
    (dir: string, round: number) => {
      const root = props.root;
      const land = (result: DirListResult): void => {
        if (gen.current !== round) return;
        setState((s) => (s.root === root ? applyListing(s, dir, result) : s));
      };
      void list(root, dir === root ? undefined : dir)
        .then(land)
        // FAIL-OPEN. The bridge rejecting is our breakage, and a tree that throws
        // must not take the card with it — it shows the same row a refusal shows,
        // which is honest: we do not have the listing.
        .catch(() => land({ ok: false, reason: 'unreadable' }));
    },
    [list, props.root]
  );

  // A new root is a new tree, not a refresh of the old one.
  React.useEffect(() => {
    gen.current += 1;
    const round = gen.current;
    setState(createTree(props.root));
    setCursor(null);
    fetchDir(props.root, round);
    // fetchDir is keyed on props.root, so this runs exactly once per folder
  }, [props.root, fetchDir]);

  /**
   * Re-read the root and every open folder.
   *
   * THE FETCHES ARE FIRED OUTSIDE THE UPDATER. They used to be inside a
   * `setState(s => { …fetch…; return s })`, which reads as a tidy way to get at
   * the current state and is a rule violation with teeth: an updater must be
   * pure, and React's StrictMode double-invokes it — so every Refresh issued two
   * listings per open folder, doubling the main-process work behind them. The
   * open folders come off the render's `state` instead, which is the same list
   * `invalidate` is about to mark.
   */
  const refresh = React.useCallback(() => {
    gen.current += 1;
    const round = gen.current;
    const dirs = openDirs(state);
    setState((s) => invalidate(s));
    for (const dir of dirs) fetchDir(dir, round);
  }, [fetchDir, state]);

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
    if (now && !wasActive.current) {
      refresh();
      // ⚠️ AND THE DECORATIONS WITH IT (E24 Git v2 item 11). The listing and the
      // git status go stale for the same reason — nothing watches the folder — so
      // refreshing one and not the other would draw today's files with yesterday's
      // badges. `force` because the store's whole job is to answer the second
      // asker from cache, and this IS the case that wants a new read.
      refreshGitStatus(props.root, { force: true });
    }
    wasActive.current = now;
  }, [props.active, props.root, refresh]);

  // Ask once per folder on mount. Idempotent in the store, so the Changes tab
  // mounting in the same frame still produces one `git status` rather than two —
  // which is the thing a `useEffect` in each component gets wrong.
  React.useEffect(() => {
    refreshGitStatus(props.root);
  }, [props.root]);

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
        // THE STATE CHANGE IS FUNCTIONAL; only the fetch DECISION reads the
        // render's copy. `setState(next.state)` over a captured state would
        // throw away a listing that committed between this render and this
        // click — a resolved fetch in the same task, or two toggles batched —
        // and leave the folder `loading` with nobody in flight.
        //
        // The decision cannot be read out of the updater (React does not run it
        // synchronously here), so it is taken from `state`, which can be one
        // listing stale. That is safe in both directions: a spurious extra
        // listing is one IPC call, and a MISSED one is recovered because
        // `toggleDir` refetches a `loading` folder. `toggleDir` is pure, so
        // StrictMode's second invocation answers identically.
        const decision = toggleDir(state, row.path);
        setState((s) => toggleDir(s, row.path).state);
        if (decision.fetch) fetchDir(row.path, gen.current);
        return;
      }
      if (isOpenable(row.kind)) onOpenFile(row.path);
    },
    [state, fetchDir, onOpenFile]
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
        // `move` clamps, so "go to index 0" and "go to the last index" are the
        // same call with different anchors. Guarded because this handler is only
        // attached to entry rows but the array is read before the call.
        if (entryRows.length > 0) move(entryRows[0].path, 0);
        return;
      case 'End':
        e.preventDefault();
        if (entryRows.length > 0) move(entryRows[entryRows.length - 1].path, 0);
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
                color: row.notice === 'error' ? 'var(--status-crashed-ink)' : 'var(--faint)',
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
                paddingInlineEnd: props.rowEndInset ?? 8,
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
              {/* ⚠️ THE VCS DECORATION (E24 Git v2 item 11) — §5.7's remaining
                  half. A ROLLED-UP folder badge is drawn dimmer and in
                  parentheses, because "something under here changed" and "this
                  changed" are different facts and a tree that drew them alike
                  would say every folder up to the root had been edited. */}
              {decorations.get(row.path) && (
                <span
                  className={`file-vcs file-vcs-${decorations.get(row.path)!.key}`}
                  data-rolled-up={decorations.get(row.path)!.rolledUp ? 'true' : undefined}
                  title={t(
                    decorations.get(row.path)!.rolledUp
                      ? 'files.vcsUnder'
                      : `scm.letter.${decorations.get(row.path)!.key}`,
                    { status: t(`scm.letter.${decorations.get(row.path)!.key}`) }
                  )}
                  style={{
                    flex: '0 0 auto',
                    marginInlineStart: 'auto',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    fontWeight: decorations.get(row.path)!.rolledUp ? 400 : 600,
                    opacity: decorations.get(row.path)!.rolledUp ? 0.55 : 1,
                    color: `var(${LETTER_INKS[decorations.get(row.path)!.letter] ?? '--muted'})`,
                  }}
                >
                  {decorations.get(row.path)!.letter}
                </span>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}
