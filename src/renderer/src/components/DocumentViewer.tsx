// The document viewer panel (P2-E16-02, §5.30).
//
// A viewer is a DOCUMENT SURFACE: a panel whose content is a file on disk,
// rendered read-only. It is session-ATTRIBUTED, not session-owned — it outlives
// any session, needs none, and never appears in the rail, the attention queue
// or a bulk close (the attribution chip is P2-E16-03; this item built the
// surface).
//
// ONE PANEL, ONE DOCUMENT (#530). Every file opens its own tab, so `path` is
// fixed for the life of this component and nothing re-points it from outside.
// P2-E16-03's peek slot and its 📌 are gone — the header no longer has a pin,
// `lib/document-panels` no longer has a pointer to move, and the only thing
// that changes what is on screen is this component's own back/forward.
//
// WHAT IS DELIBERATELY NOT HERE:
//   * images, JSON/CSV bodies and a file tree (Phase 3, DESIGN §8).
//
// P2-E16-04 ADDED THE LIVE HALF, and it is deliberately thin here: main owns the
// watch and the debounce (`main/fs/file-watch.ts`), and all that arrives is
// "read it again" or "it is gone". The viewer's own share of that contract is
// the two things a reader would notice if they were missing — the scroll
// position survives a re-render, and a deleted file becomes a strip over what
// you were reading rather than an error or an empty pane.
//
// THE SECURITY SHAPE, in one place, because it is spread across three modules:
// main decides what may be read at all (`ReadScope`), `lib/markdown` is the
// only thing in the app that runs a sanitizer, and `lib/document-render`
// decorates the result OFF-PAGE so nothing fetches. This component is the part
// that decides what a CLICK means, and its rule is that a link with an href
// never survives to be clicked — see `decorateLinks`.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { FileReadResult, FileTextEncoding, FileWatchNotice } from '../../../shared/ipc/fs';
import { renderMarkdown } from '../lib/markdown';
import {
  classifyDocument,
  DocumentMode,
  baseName,
  directoryName,
} from '../lib/document-kind';
import { classifyHref } from '../lib/document-link';
import {
  chipForFailedImage,
  decorateDocument,
  rememberImageSize,
  splitFrontMatter,
  DecorationLabels,
  OutlineEntry,
} from '../lib/document-render';
import { applyMatches, clearMatches, focusMatch } from '../lib/document-find';
import {
  getDocumentOutline,
  subscribeDocumentOutline,
  toggleDocumentOutline,
} from '../lib/document-outline';
import { findBarState, findQuery } from '../lib/find-bar-state';
import { findSurfaceKey, publishFindSurface, type DocumentFindSurface } from '../lib/find-surfaces';
import { openMonacoFind, type FindableEditor } from '../lib/monaco-find';
import { answered } from '../../../shared/ipc/refusal';
import { runCopy } from '../lib/feed-code';
import { sessionStore } from '../store/session-store';

const DocumentSource = React.lazy(() => import('./DocumentSource'));

/**
 * Find a heading by id.
 *
 * VALIDATED, NOT ESCAPED, and the difference is a white screen. The id we build
 * is `slugify`'s output, which can only be letters, numbers, `-` and `_` — but
 * the NEEDLE comes from a link inside a file we did not write, percent-decoded
 * on the way (`classifyHref`). A document containing `[go](./x.md#a%0Ab)` hands
 * this a raw newline, a newline inside a CSS string is a parse error, and
 * `querySelector` THROWS — from inside an effect, where React's answer is to
 * unmount the tree. There is no error boundary above a dockview panel's
 * content, so one hostile link would take every session pane in the window with
 * it, which is the fail-open constraint broken by a file on disk.
 *
 * Escaping was the first version and it is not enough: escaping `"` and `\`
 * leaves the newline, and a complete CSS-string escaper is a thing to own
 * forever. An id that cannot match anything we generated is simply not looked
 * up. (`CSS.escape` is also absent from the jsdom the unit tests run on, and
 * jsdom's selector engine is more forgiving than Chromium's — which is why this
 * only shows up in the real app.)
 */
function headingById(root: ParentNode | null, id: string): Element | null {
  if (!root || !/^[\p{L}\p{N}\-_]+$/u.test(id)) return null;
  return root.querySelector(`[id="${id}"]`);
}

/** The session a viewer was opened FROM, for §5.24's lineage convention. */
export interface DocumentAttribution {
  /** what that session calls itself, right now */
  name: string;
  /** its identity accent, or undefined while the store has not answered */
  accent?: string;
}

export interface DocumentViewerProps {
  /** the absolute path this viewer opened on */
  path: string;
  /**
   * The dockview panel this viewer is the content of (`doc-3`), which is how
   * the §5.31 find bar names it (#533).
   *
   * Optional because a unit test mounts the component with no panel around it.
   * Absent means the find surface is not published, and Ctrl+F over this viewer
   * finds nothing to search — which is the correct answer for a viewer nobody
   * can name.
   */
  panelId?: string;
  colorScheme: 'light' | 'dark';
  /** the panel's tab title follows relative-link navigation */
  onTitleChange?: (title: string) => void;
  /** is this viewer currently in its own OS window? */
  poppedOut?: boolean;
  /** pop out, or dock back — one control, because it is one toggle */
  onPopoutToggle?: () => void;
  /** the session this viewer was opened from, if any (§5.24) */
  session?: DocumentAttribution;
  /**
   * Bumped whenever dockview moved this panel's DOM (#562) — the same signal
   * `PanelContext.dockEpoch` carries for a session card's panels (#555).
   *
   * MEASURED, two documents sharing a dockview group: read halfway down one,
   * click the other tab, click back — **722 -> 0**. And the component is NEVER
   * UNMOUNTED while that happens, which is the part that misleads: only one
   * `[data-testid="doc-scroll"]` is findable at a time, so the obvious reading
   * is that the inactive panel was destroyed. It was not. Dockview DETACHES the
   * panel's element from the document and keeps the React tree alive, so
   * `querySelector` cannot see it while every ref in here still holds its value
   * — `scrollMemo` included. Nothing was lost; there was simply nothing to
   * re-apply it, because the effect that does so only runs when the rendered
   * HTML changes and the document had not changed at all.
   */
  dockEpoch?: number;
}

/** Bytes as a human says them. Two significant places is enough for a header. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The bridge slice this panel uses, so a test can stub exactly it. */
interface FilesBridge {
  read(path: string): Promise<FileReadResult>;
  openPath?(path: string): Promise<boolean>;
  reveal?(path: string): Promise<boolean>;
  openExternal?(url: string): Promise<boolean>;
  /**
   * Follow the file; returns the unsubscribe (P2-E16-04).
   *
   * `onAnswer` is main's reply to the ask itself (#506): whether it agreed to
   * follow. `unknown`, because a channel can answer with a refusal instead of
   * its payload (#650) and because a rejected call reports as `null`.
   */
  watch?(
    path: string,
    onChange: (notice: FileWatchNotice) => void,
    onAnswer?: (answer: unknown) => void
  ): () => void;
}

/**
 * What the viewer shows when it could not read the file — no bridge at all, a
 * rejected read, or (since #650) a broker refusal. One value, so the three
 * ways of not getting content cannot drift into three different screens.
 */
const UNREADABLE: FileReadResult = { ok: false, reason: 'unreadable' };

function files(): FilesBridge | undefined {
  return (window as unknown as { switchboard?: { files?: FilesBridge } }).switchboard?.files;
}

/**
 * "This file was opened again while a panel already had it" (#506), by panel
 * id. One listener per mounted viewer; `SessionGrid` is the only caller. A map
 * and not the session store, because this is one panel being poked, not state
 * anybody else reads.
 */
const reopenListeners = new Map<string, (path: string) => void>();
export function documentReopened(panelId: string, path: string): void {
  reopenListeners.get(panelId)?.(path);
}

export function DocumentViewer(props: DocumentViewerProps): React.JSX.Element {
  const { t } = useTranslation();

  // --- navigation ---------------------------------------------------------
  // A stack plus a cursor, which is what back/forward IS. Following a relative
  // link truncates everything after the cursor, exactly like a browser: the
  // path you came from is behind you, the one you abandoned is gone.
  const [history, setHistory] = React.useState<string[]>([props.path]);
  const [at, setAt] = React.useState(0);
  const current = history[at] ?? props.path;
  const [pendingHash, setPendingHash] = React.useState<string | undefined>(undefined);

  // DEFENSIVE, and unreachable by design since #530: `path` is fixed for the
  // life of a panel, and a remount re-runs the `useState` initialiser above
  // anyway. Kept because the cost is one render on mount and the failure it
  // guards is silent — a history stack seeded from a stale prop is a back
  // button that lies about where you have been. Delete it the day something
  // proves no prop can ever change under this component.
  React.useEffect(() => {
    setHistory([props.path]);
    setAt(0);
    setPendingHash(undefined);
  }, [props.path]);

  const meta = React.useMemo(() => classifyDocument(current), [current]);
  const [result, setResult] = React.useState<FileReadResult | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [mode, setMode] = React.useState<DocumentMode>(meta.defaultMode);

  React.useEffect(() => {
    setMode(meta.defaultMode);
  }, [meta.defaultMode, current]);
  React.useEffect(() => {
    props.onTitleChange?.(meta.name);
  }, [meta.name, props.onTitleChange]);

  /**
   * The file was there when we opened it and is not there now (P2-E16-04).
   *
   * SEPARATE from `result`, because the done-when is that a deleted file shows
   * "a strip instead of an error or a blank pane": the last good read stays on
   * screen underneath it. Overwriting `result` with the refusal would be the
   * blank pane, and it would also throw away the only copy of a document the
   * reader may still be halfway through — the file is gone, their place in it
   * need not be.
   */
  const [missing, setMissing] = React.useState(false);

  /**
   * Main has stopped following this file, and the reader is told (#506).
   *
   * How it happens: the last open session working in the file's folder was
   * closed, so the path left the read scope and main let the watch go. The
   * document stays on screen and stays readable. It has simply stopped
   * updating, and until this existed NOTHING SAID SO: a frozen document and a
   * document nobody is writing to looked the same, and bringing the panel back
   * to the front did not help.
   *
   * `'stopped'` is the notice. `'refused'` is the same strip after the reader
   * asked to follow again and the scope still said no, which earns different
   * words saying what would change the answer. `'failed'` is an ask that could
   * not be answered either way (a lock, a call that never came back): the
   * words then promise nothing about sessions, because sessions were not the
   * reason. SEPARATE from `missing` for the reason `missing` is separate from
   * `result`: different things can be true of a document that is still on
   * screen. The two can be true TOGETHER (the file is gone and we are not
   * watching for its return), and then "deleted" is the sentence and this
   * state contributes the button.
   *
   * WHAT SAYS WE ARE FOLLOWING AGAIN IS THE WATCH, never a read: main's own
   * answer to a fresh `fs:watch`, or a `changed` notice arriving on the watch
   * we hold. (A link followed to another file also clears it, because the
   * strip was about the file that left the screen.) A read
   * coming back proves the file is readable NOW, and the two can disagree (a
   * writer holding the file, the scope moving between two messages); the first
   * cut inferred one from the other and review found the strip could then sit
   * over a live document, or clear over a dead one.
   */
  const [unfollowed, setUnfollowed] = React.useState<false | 'stopped' | 'refused' | 'failed'>(
    false
  );
  const unfollowedNow = React.useRef(unfollowed);
  unfollowedNow.current = unfollowed;
  const currentNow = React.useRef(current);
  currentNow.current = current;

  /**
   * "Ask main to follow this file again", as a number the watch effect is
   * keyed on: each bump is a new ask, made under a new token.
   */
  const [followAsk, setFollowAsk] = React.useState(0);
  /** the last ask the watch effect has acted on, so a path change is not one */
  const followAskDone = React.useRef(0);
  /**
   * A PERSON is waiting for an answer (they pressed the button, or opened the
   * file again), as opposed to a session opening and us trying quietly. A
   * refusal is only worth saying to someone who asked.
   *
   * A ref that the ANSWER consumes, not a field on the ask: a quiet try can
   * overtake a press that is still in flight, and the press must still get its
   * answer from whichever ask lands.
   */
  const readerAsked = React.useRef(false);
  const followBtn = React.useRef<HTMLButtonElement | null>(null);
  /** what is on screen, for a callback that outlives the render it was made in */
  const resultNow = React.useRef(result);
  resultNow.current = result;

  /**
   * Which read is the CURRENT one.
   *
   * A watch notice can land while the open read is still in flight, and the two
   * resolve in whatever order the bridge feels like — so the answers are stamped
   * and a stale one is dropped. Without it a slow first read can overwrite the
   * fresher content that a rewrite already delivered, and the viewer shows the
   * old document with no event left to correct it.
   */
  const readSeq = React.useRef(0);

  /**
   * Apply one read's answer — ONE function, because there are two readers and
   * `loading` must be cleared by whichever of them lands last.
   *
   * The bug this shape exists to prevent: the open read and a change notice can
   * be in flight at the same time (they are issued in the same commit, and the
   * flagship scenario is opening a file an agent is *already* rewriting). The
   * notice's read retires the open read's stamp, so if only the open read
   * cleared `loading`, the viewer would sit on "Opening…" for the rest of the
   * panel's life with a perfectly good document rendered behind it — the blank
   * pane the done-when forbids, arrived at from the other direction.
   *
   * `keep` is what separates the two readers: a RELOAD keeps the document that
   * is on screen when the new read fails, because it is still the last true
   * thing anyone wrote. An OPEN has nothing to keep.
   */
  const applyRead = React.useCallback((mine: number, r: FileReadResult, keep: boolean): void => {
    if (mine !== readSeq.current) return;
    setLoading(false);
    if (r.ok) {
      setResult(r);
      setMissing(false);
      return;
    }
    if (!keep) {
      setResult(r);
      return;
    }
    // A read that fails on a RELOAD keeps what is on screen. `not-found` is the
    // deletion racing us to the file and earns the strip; anything else (the
    // scope narrowed because the session card closed, a lock, an unplugged
    // drive) is a document that has stopped updating, not one that has stopped
    // existing — and replacing a page of prose with a refusal message would be
    // this item breaking what E16-02 shipped.
    if (r.reason === 'not-found') setMissing(true);
  }, []);

  /**
   * Follow the open file (P2-E16-04, §5.30).
   *
   * Main does the watching, the coalescing and the deciding; this asks, re-reads
   * and — crucially — UNSUBSCRIBES. The effect is keyed on the path, so a
   * relative-link navigation moves the watch with it, and unmounting a panel
   * takes the last reference off the file in main.
   *
   * DECLARED BEFORE THE READ, and the order is load-bearing: effects run in
   * declaration order, so `fs:watch` reaches main first and main seeds the
   * file's signature BEFORE the bytes are read. The other way round leaves a
   * window — the file being rewritten between the read and the seed — in which
   * the change is baked into the seed and no event is ever emitted for it, so
   * the viewer shows content it already knows is stale until something else
   * happens to the file.
   *
   * A re-read deliberately does NOT set `loading`. Flashing "Opening…" over a
   * document every time an agent saves is worse than the staleness it replaces,
   * and there is nothing to wait for: the previous content is still correct
   * until the new one arrives.
   */
  React.useEffect(() => {
    const bridge = files();
    // A bridge without `watch` is an older preload or a test that stubbed the
    // three methods it cared about. The viewer is simply not live; nothing else
    // about it changes.
    if (!bridge?.watch) return;
    // Is THIS run of the effect a fresh ask to follow (#506), as opposed to
    // the first watch or a link moving it to a new path?
    const asked = followAsk !== followAskDone.current;
    followAskDone.current = followAsk;
    let current_ = true; // this run's watch is still the one we hold
    const stop = bridge.watch(
      current,
      (notice) => {
        if (notice.state === 'gone') {
          setMissing(true);
          return;
        }
        if (notice.state === 'unfollowed') {
          // No re-read: it would be refused, for the reason the watch ended.
          //
          // AND "DELETED" COMES DOWN. Main only checks the scope of a file that
          // is THERE (a deleted one keeps its watch, so its return can be
          // seen), so this notice arriving over the deleted strip can mean one
          // thing: the file came back, in a folder we may no longer read.
          // Leaving "deleted" up would be a strip that is no longer true with
          // no way to get rid of it.
          setMissing(false);
          setUnfollowed('stopped');
          return;
        }
        // A `changed` on the watch we hold is proof that it is live, whatever
        // the strip currently says.
        setUnfollowed(false);
        const mine = ++readSeq.current;
        // KEEP what is on screen if this fails, WHEN THERE IS SOMETHING ON
        // SCREEN. This read has just retired the open read's stamp, so if the
        // notice beat the open read and this one then fails, nobody is left to
        // clear "Opening…" (found in the #506 review, and older than it):
        // with no document to keep, the failure has to be allowed to show.
        const keep = resultNow.current?.ok === true;
        void bridge
          .read(current)
          // `answered` (#650). On THIS path (`keep`) a refusal was already
          // harmless — `applyRead` reads `.ok`, the brand has none, and a failed
          // reload keeps what is on screen. Laundered anyway, because the OPEN
          // path below is the same call with the opposite `keep` and there a
          // refusal was NOT harmless; two spellings of one rule is how the next
          // person picks the wrong one.
          .then((r) => applyRead(mine, answered(r) ?? UNREADABLE, keep))
          .catch(() => {
            if (!keep) applyRead(mine, UNREADABLE, false);
          });
      },
      // MAIN'S OWN ANSWER to the ask, and the only thing that decides the
      // strip. Only listened to for a fresh ask: the first watch of a path
      // has the open read to say what went wrong.
      asked
        ? (answer) => {
            if (!current_) return;
            const byReader = readerAsked.current;
            readerAsked.current = false;
            // `null` is a call that was rejected; a broker refusal has no `ok`
            const said = answered(answer) as { ok?: unknown; reason?: unknown } | null | undefined;
            if (said?.ok !== true) {
              // WHY it was a no decides what may be said. Three answers, and
              // only one of them is about sessions:
              if (said?.reason === 'not-found') {
                // The file is not there. That is news whoever asked, and it
                // is the deleted strip's to give; this state stays, so the
                // button stays, because nothing is watching for its return.
                setMissing(true);
              } else if (!byReader) {
                // a QUIET try that failed leaves the strip exactly as it was
              } else if (said?.reason === 'out-of-scope') {
                setUnfollowed('refused');
              } else {
                // a lock, a path that is not a file, a call that never landed:
                // "open a session there" would be advice that cannot help
                setUnfollowed('failed');
              }
              return;
            }
            // The button is about to unmount with the strip. If it holds the
            // keyboard, hand that to a control that stays rather than to
            // <body>: the first button in this viewer that can take it. NOT
            // the outline toggle by name, which is what the outline's own
            // rescue uses: it is disabled on every document without three
            // headings, and focusing a disabled button does nothing.
            const btn = followBtn.current;
            if (btn && btn.ownerDocument.activeElement === btn) {
              btn
                .closest('[data-testid="document-viewer"]')
                ?.querySelector<HTMLButtonElement>(
                  'button:not(:disabled):not([data-testid="doc-follow-again"])'
                )
                ?.focus();
            }
            setUnfollowed(false);
            setMissing(false);
            // ...then fetch whatever was written while nobody was looking.
            // AFTER the watch was granted, for the reason the open read comes
            // after its watch: main has seeded the file's signature. `keep`
            // only if there is a document to keep; with none (the ask overtook
            // the open read) a failure has to be allowed to say so.
            const mine = ++readSeq.current;
            const keep = resultNow.current?.ok === true;
            void bridge
              .read(current)
              .then((r) => applyRead(mine, answered(r) ?? UNREADABLE, keep))
              .catch(() => {
                if (!keep) applyRead(mine, UNREADABLE, false);
              });
          }
        : undefined
    );
    return () => {
      current_ = false;
      stop();
    };
  }, [current, applyRead, followAsk]);

  /**
   * A session opening is the moment following can resume by itself (#506): the
   * read scope is the open sessions' folders, so a new card over this file's
   * folder puts the file back in reach. Try once, quietly, whenever the set of
   * open folders changes while this viewer is not being followed.
   *
   * Keyed on the FOLDERS, not on the store changing: the store is written to
   * many times a second while a session works, and each try costs main a
   * scope check (and, if granted, a watch and a read). A session CLOSING
   * changes the key too and buys one try that
   * will be refused, which is the price of not teaching this viewer which
   * folder would help (main decides that, on the real path, with symlinks
   * resolved; a guess made here would be a second copy of the rule).
   */
  React.useEffect(() => {
    if (!unfollowed) return;
    const folders = (): string =>
      sessionStore
        .getState()
        .sessions.map((s) => s.folder)
        .sort()
        .join('\n');
    let seen = folders();
    return sessionStore.subscribe(() => {
      const now = folders();
      if (now === seen) return;
      seen = now;
      setFollowAsk((n) => n + 1);
    });
  }, [unfollowed]);

  /**
   * Opening a file that is already open focuses its panel instead of making a
   * second one. If that panel is THIS one and it had stopped, the person has
   * just done the most direct thing there is to ask for it back (and through
   * **Open File…** they have also just granted the file), so it counts as a
   * press of the button. `SessionGrid` calls this by panel id.
   *
   * ONLY IF IT IS THE FILE ON SCREEN. The panel is found by the path it was
   * OPENED on, and a viewer follows links: a panel opened on A that is now
   * showing B is still "the panel for A". Re-opening A is then no request
   * about B at all, and granted nothing about B, so it is a quiet try and a
   * refusal says nothing.
   */
  React.useEffect(() => {
    const id = props.panelId;
    if (!id) return;
    const ask = (path: string): void => {
      if (!unfollowedNow.current) return;
      if (path === currentNow.current) readerAsked.current = true;
      setFollowAsk((n) => n + 1);
    };
    reopenListeners.set(id, ask);
    return () => {
      if (reopenListeners.get(id) === ask) reopenListeners.delete(id);
    };
  }, [props.panelId]);

  React.useEffect(() => {
    const mine = ++readSeq.current;
    setLoading(true);
    setResult(null);
    setMissing(false);
    // a link followed out of a document that had stopped: the new path gets
    // its own watch and its own answer, and the old strip is about a file
    // that is no longer on screen. So is a press that main had not answered
    // yet: left set, it would make some later QUIET refusal on the new file
    // read as an answer to a question nobody asked about it.
    setUnfollowed(false);
    readerAsked.current = false;
    const bridge = files();
    if (!bridge) {
      // Fail-open (litmus #3): no bridge is a viewer that says so, not a throw
      // that takes the window's React tree with it.
      setResult(UNREADABLE);
      setLoading(false);
      return;
    }
    void bridge
      .read(current)
      // #650, and this is the path where it MATTERED: with `keep` false,
      // `applyRead` puts a not-ok result straight into state, so the brand
      // became `result` — and the strip renders `t('document.refusal.' +
      // result.reason)`, i.e. the literal string `document.refusal.undefined`
      // on screen. `UNREADABLE` is the same value the no-bridge branch above
      // uses, so a refused read looks exactly like a file we cannot open.
      .then((r) => applyRead(mine, answered(r) ?? UNREADABLE, false))
      .catch(() => applyRead(mine, UNREADABLE, false));
    // Retiring the stamp is what the old `live` flag did, said once for both
    // readers: a read still in flight when the path changes — or when the panel
    // closes — has nothing left to apply to.
    return () => {
      readSeq.current += 1;
    };
  }, [current, applyRead]);

  const navigate = React.useCallback(
    (to: string, hash?: string) => {
      setHistory((h) => [...h.slice(0, at + 1), to]);
      setAt((i) => i + 1);
      setPendingHash(hash);
    },
    [at]
  );

  // --- bodies -------------------------------------------------------------
  const ok = result?.ok === true ? result : null;
  const binary = ok?.binary === true;
  const isCard = meta.kind === 'external' || binary;
  const text = ok?.text ?? '';

  const front = React.useMemo(
    () => (meta.kind === 'markdown' ? splitFrontMatter(text) : { body: text }),
    [meta.kind, text]
  );

  const labels: DecorationLabels = React.useMemo(
    () => ({
      copy: t('document.copy'),
      image: t('document.image'),
      openInBrowser: t('document.openInBrowser'),
      mediaOmitted: t('document.mediaOmitted'),
    }),
    [t]
  );

  // TWO elements, and the split is not cosmetic: `scrollRef` is the pane that
  // scrolls and `bodyRef` is the column of prose inside it, capped at a
  // readable measure (§5.30). One element doing both puts the scrollbar 78
  // characters in, with dead pane to the right of it.
  //
  // `mainRef` is a third and belongs to FIND (#533): it wraps the prose AND the
  // front-matter block, which is what the reader can see and therefore what a
  // search has to cover. The decoration effect still writes into `bodyRef` —
  // the rendered document is the only thing React does not own here.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const mainRef = React.useRef<HTMLDivElement | null>(null);
  const [outline, setOutline] = React.useState<readonly OutlineEntry[]>([]);
  const [frontOpen, setFrontOpen] = React.useState(false);

  // The reader's own off switch for the outline (#1010). GLOBAL, and
  // `lib/document-outline`'s header says at length why a per-panel key could
  // not survive a relaunch: a `doc-` panel is dropped from every restored
  // layout, so its id names a different file next launch.
  const outlineWanted = React.useSyncExternalStore(subscribeDocumentOutline, getDocumentOutline);
  const outlineRef = React.useRef<HTMLElement | null>(null);
  const outlineToggleRef = React.useRef<HTMLButtonElement | null>(null);

  // Scroll position per MODE, so the toggle round-trips. Two numbers rather
  // than one shared offset: a rendered line and a source line are not the same
  // distance down the pane, and pretending they are lands you in the wrong
  // place in both directions.
  const scrollMemo = React.useRef<{ rendered: number; source: number }>({
    rendered: 0,
    source: 0,
  });
  React.useEffect(() => {
    scrollMemo.current = { rendered: 0, source: 0 };
  }, [current]);

  const renderedHtml = React.useMemo(
    () => (meta.kind === 'markdown' && ok && !binary ? renderMarkdown(front.body) : ''),
    [meta.kind, ok, binary, front.body]
  );

  const showRendered = meta.kind === 'markdown' && mode === 'rendered' && !!ok && !binary && !isCard;

  React.useEffect(() => {
    const host = bodyRef.current;
    if (!host || !showRendered) return;
    const { fragment, outline: found } = decorateDocument(renderedHtml, labels, (href) =>
      classifyHref(href, current)
    );
    host.replaceChildren(fragment);
    // A picture main refused — out of scope, gone, not really a picture —
    // becomes the same chip a remote image gets. `error` does not bubble, so
    // this listens in the capture phase, on the host the pictures live in.
    const onImageError = (e: Event): void => void chipForFailedImage(e.target, labels);
    host.addEventListener('error', onImageError, true);
    // …and one that loaded says how big it is, so the NEXT time this picture is
    // rendered — a live re-render, a toggle back from Source, a move into a
    // popped-out window — the room is already there and the reader stays put.
    const onImageLoad = (e: Event): void => void rememberImageSize(e.target);
    host.addEventListener('load', onImageLoad, true);
    setOutline(found);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollMemo.current.rendered;
    // The marks belonged to the OLD document — `replaceChildren` just deleted
    // them, so the bar would sit there reading "1 of 5" over a document with no
    // highlights in it. Re-mark against the new body instead of pretending.
    //
    // The bar's own state is READ, not driven: there is no way to ask it to
    // re-run its query, so a rewrite that changes how many matches there are
    // leaves its COUNT one keystroke stale. The highlights are the thing the
    // reader is looking at (#520 — a jump with no visible mark reads as broken),
    // and they are right; the number catches up on the next keystroke.
    const q = findQuery();
    if (findBarState().openOn === props.panelId && q.term && mainRef.current) {
      applyMatches(mainRef.current, q.term, q);
    }
    return () => {
      host.removeEventListener('error', onImageError, true);
      host.removeEventListener('load', onImageLoad, true);
    };
  }, [showRendered, renderedHtml, labels, current, props.panelId]);

  /**
   * Put the reader back after dockview moved this panel's DOM (#562).
   *
   * `scrollMemo` already holds the right number — the component was never
   * unmounted (see the `dockEpoch` prop) — so this is purely "apply it again".
   * The browser dropped the element's `scrollTop` during the detach and fired
   * nothing: no scroll event, no resize (the panel comes back at exactly the
   * size it left), no visibility change. The card's own panels learned this in
   * #555; a document panel is not a card panel and had no such signal at all.
   *
   * Twice, a frame apart, for `FeedView`'s reason: the dockview event can land
   * on either side of the DOM move, and re-applying a scrollTop the element is
   * already sitting at costs nothing.
   *
   * The SOURCE body is INFERRED to need no equivalent, and the word is chosen:
   * Monaco scrolls a virtual viewport rather than a native `scrollTop`, and the
   * Changes tab — a Monaco editor under the identical move — came back on the
   * same line, measured. But that is a diff editor and this is a plain one, and
   * nothing has moved a viewer while it was in Source mode. Inference, not
   * measurement; `e2e/panel-restore-position.spec.ts`'s header lists it as such
   * beside the Terminal.
   *
   * SKIPS THE FIRST RUN. `dockEpoch` starts at 0, so this effect fires on mount,
   * where there is nothing to restore and the write races the `#fragment` jump
   * declared just below — a relative link's anchor would be undone a frame after
   * it landed.
   */
  const restoredEpoch = React.useRef<number | undefined>(props.dockEpoch);
  React.useEffect(() => {
    if (props.dockEpoch === undefined || props.dockEpoch === restoredEpoch.current) return;
    restoredEpoch.current = props.dockEpoch;
    const apply = (): void => {
      const el = scrollRef.current;
      if (el) el.scrollTop = scrollMemo.current.rendered;
    };
    apply();
    const id = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(id);
  }, [props.dockEpoch]);

  /**
   * The backstop `FeedView` has and this did not (#562 review).
   *
   * The two shots above are timed to the dockview event, and both are silent
   * no-ops if the element has no layout box at that instant — `scrollTop =` on a
   * zero-height element does nothing. The measured gesture is fine; a document
   * tab DRAGGED into another group, where the event can land on the far side of
   * the move, has no third chance. `FeedView` solves this by calling the same
   * reconcile from a ResizeObserver on the scroller, so the dockview signal is
   * one route among several rather than the only one.
   *
   * Re-applying costs nothing when nothing is wrong: `scrollMemo` is updated by
   * the scroll handler, so the remembered position IS the current one, and the
   * guard makes the ordinary case a comparison rather than a write. It must not
   * fight a user who resizes the pane — and it cannot, for the same reason.
   */
  React.useEffect(() => {
    const el = scrollRef.current;
    // `ResizeObserver` is a browser affordance and jsdom has none. Guarded rather
    // than stubbed in every test that merely mounts this component: a backstop
    // that cannot run in a unit test is still a backstop in the app, and making
    // twenty tests declare a global to get past it would be the tail wagging.
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const want = scrollMemo.current.rendered;
      if (want > 0 && el.scrollTop === 0 && el.scrollHeight > el.clientHeight) {
        el.scrollTop = want;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showRendered]);

  // The `#fragment` a relative link carried, applied once the body exists.
  React.useEffect(() => {
    if (!pendingHash || !showRendered) return;
    const host = bodyRef.current;
    headingById(host ?? null, pendingHash)?.scrollIntoView?.({ block: 'start' });
    setPendingHash(undefined);
  }, [pendingHash, showRendered, renderedHtml]);

  // --- find (#533) ---------------------------------------------------------
  //
  // THE VIEWER NO LONGER OWNS A FIND BAR. It publishes a `FindSurface` and the
  // shared §5.31 bar drives it — same Ctrl+F, same chrome and same sticky term
  // as every other panel in the app, with a results list the private bar never
  // had. What used to live here (a bar, four pieces of state, a debounce and a
  // keydown listener) is `extensibility/find-providers.ts`'s `find-document`
  // and `components/FindBar.tsx` now.
  //
  // THE KEYDOWN LISTENER IS GONE ON PURPOSE, and it is worth knowing why rather
  // than re-adding it: it was attached to this component's ROOT DIV and nothing
  // in that subtree is focusable, so unless the user had first clicked a button
  // in the header the keydown's target was `document.body` and the event never
  // bubbled through here at all. It was dead code, and the reason Ctrl+F looked
  // broken over a document. The keystroke arrives through the app's dispatcher
  // now (`find.open` + `GridController.activeDocumentId`), which works wherever
  // focus happens to be — including in a popped-out viewer's own window.
  const sourceEditor = React.useRef<FindableEditor | null>(null);
  // Read by the surface's methods, which are called from OUTSIDE React's render
  // (a keydown, then the bar's effects) and must see what is true now.
  const showRenderedRef = React.useRef(false);
  // The editor's ARRIVAL, as state rather than only as a ref — see the effect's
  // deps below for why a ref alone would leave the bar greyed.
  const [sourceReady, setSourceReady] = React.useState(false);

  const panelId = props.panelId;
  React.useEffect(() => {
    // No panel id means nobody can name this viewer — a unit test mounting the
    // component directly, and the one case where publishing would be wrong: the
    // key is what makes "a search cannot reach another panel" structural.
    // In the EFFECT rather than during render: a ref written while rendering
    // can hold a value from a render React went on to throw away, and the deps
    // below already re-run this whenever the answer changes.
    showRenderedRef.current = showRendered;
    if (!panelId) return;
    const surface: DocumentFindSurface = {
      kind: 'document',
      view: () => {
        if (showRenderedRef.current && mainRef.current) return 'rendered';
        if (!showRenderedRef.current && sourceEditor.current?.getModel()) return 'source';
        // loading, refused, binary (the card), or the editor has not built yet
        return 'none';
      },
      search: (query) => {
        const host = mainRef.current;
        if (!host) return { matches: [], truncated: false };
        return applyMatches(host, query.term, query);
      },
      reveal: (index) => {
        const host = mainRef.current;
        return host ? focusMatch(host, index) >= 0 : false;
      },
      clear: () => {
        if (mainRef.current) clearMatches(mainRef.current);
      },
      openFind: (term) => openMonacoFind(sourceEditor.current, term),
    };
    return publishFindSurface(findSurfaceKey(panelId, 'document'), surface);
    // RE-PUBLISHED whenever `view()` would answer differently, and that is the
    // point of the deps rather than an accident of them: the bar is a SIBLING
    // subtree, so nothing here re-renders it, and a publish is the only signal
    // it gets (`findSurfacesVersion`). Without this, toggling to Source would
    // leave the bar still driving a rendered body that has been unmounted, and
    // the editor arriving a moment later would leave it greyed with "hasn't
    // finished opening" over an editor that had. Re-publishing is cheap and
    // explicitly supported — last publisher wins, and the cleanup only deletes
    // the entry if it is still the one it published.
  }, [panelId, showRendered, sourceReady]);


  // --- clicks inside the rendered body ------------------------------------
  const activate = React.useCallback(
    (target: HTMLElement | null): void => {
      if (!target) return;
      const copy = target.closest<HTMLElement>('[data-doc-copy]');
      if (copy) {
        const code = copy.closest('.doc-code')?.querySelector('pre')?.textContent ?? '';
        // THE BUTTON'S OWN WINDOW (#508), which is `runCopy`'s whole reason to
        // exist. This used the module's `navigator` — the MAIN window's — and a
        // viewer popped out into its own window is DOM in another document
        // with this JavaScript still running here: the main document is not
        // the focused one when the click lands over there, and `writeText`
        // rejects on an unfocused document. The button flashed "Copied" and
        // the clipboard was untouched. The feed learned this in #477; the
        // viewer's button predates the lesson.
        runCopy(copy, code, t('document.copied'));
        return;
      }
      const image = target.closest<HTMLElement>('[data-doc-external]');
      if (image) {
        void files()?.openExternal?.(image.getAttribute('data-doc-external') ?? '');
        return;
      }
      const link = target.closest<HTMLElement>('[data-doc-link]');
      if (!link) return;
      const kind = link.getAttribute('data-doc-link');
      const to = link.getAttribute('data-doc-target') ?? '';
      // 'blocked' falls through every branch and does nothing at all — the
      // done-when for this item names `javascript:` specifically.
      if (kind === 'external') void files()?.openExternal?.(to);
      else if (kind === 'relative') navigate(to, link.getAttribute('data-doc-hash') ?? undefined);
      else if (kind === 'anchor') {
        headingById(bodyRef.current, to)?.scrollIntoView?.({ block: 'start' });
      }
    },
    [navigate, t]
  );

  // --- header -------------------------------------------------------------
  const canRender = meta.kind === 'markdown';
  const truncated = ok?.truncated === true;
  /** the one thing to do about a file we are not following (#506) */
  const followAgain = (
    <button
      ref={followBtn}
      type="button"
      className="doc-btn"
      data-testid="doc-follow-again"
      onClick={() => {
        readerAsked.current = true;
        setFollowAsk((n) => n + 1);
      }}
    >
      {t('document.unfollowed.again')}
    </button>
  );
  const encoding = ok?.encoding;

  const switchMode = (next: DocumentMode): void => {
    if (next === mode) return;
    if (mode === 'rendered' && scrollRef.current) {
      scrollMemo.current.rendered = scrollRef.current.scrollTop;
    }
    // Leaving the rendered body takes its marks with it — they are real nodes
    // in a tree that is about to be unmounted, and the next search would
    // otherwise match inside its own highlights. The BAR stays open across the
    // toggle, and switches from driving us to delegating to Monaco, because
    // `modeFor` is asked of the live surface on every render.
    if (mainRef.current) clearMatches(mainRef.current);
    setMode(next);
  };

  // --- the outline's off switch (#1010) ------------------------------------
  //
  // TWO QUESTIONS, deliberately separate. `outlineOffered` is whether there is
  // an outline to hide at all — the toggle is GREYED, never absent (§5.8, the
  // same rule the Rendered chip follows for a `.ts`), because a control that
  // vanishes tells the reader nothing about why. `outlineShown` is the answer
  // the body actually renders, and it is the AND of "there is one" and "you
  // want it": a stored `false` must not make a chip appear over a source view,
  // and three headings must not resurrect an outline the reader turned off.
  //
  // `outline` itself is only written by the rendered-body effect, so it holds
  // the last rendered document's headings while Source is on screen — which is
  // exactly why `showRendered` is part of both answers rather than just one.
  const outlineOffered = showRendered && outline.length >= 3;
  const outlineShown = outlineOffered && outlineWanted;

  /**
   * Flip it, without stranding a keyboard user in a pane that is about to stop
   * existing (#1010's a11y done-when).
   *
   * The ordinary path cannot strand anyone — the chip is what was clicked, so
   * the chip has focus and keeps it. This covers the path where the flip
   * arrives from somewhere else while a heading link is focused: a second
   * viewer's chip, a popped-out window, or any later caller of
   * `setDocumentOutline`. Read BEFORE the state change, because once React has
   * unmounted the nav its `contains` can only ever answer false and the focus
   * has already fallen to `<body>`.
   *
   * `toggleDocumentOutline` rather than `set(!outlineWanted)`: the module reads
   * the LIVE value, where `outlineWanted` is this render's copy of it. Equal
   * today, and the difference is the day two windows flip it in the same tick.
   */
  const toggleOutline = (): void => {
    const nav = outlineRef.current;
    const active = nav?.ownerDocument?.activeElement ?? null;
    if (nav && active && nav.contains(active)) outlineToggleRef.current?.focus();
    toggleDocumentOutline();
  };

  // §5.24's lineage convention: the accent is a TINT on the surface (a rule
  // down its leading edge, exactly as a card header wears it), never the ink —
  // the eight accents span 1.8:1 to 3.1:1 on daylight and text on them cannot
  // be read (the #5.11 finding IdentityChip records).
  const attribution = props.session;
  const rootStyle = attribution?.accent
    ? ({ ['--doc-accent' as string]: attribution.accent } as React.CSSProperties)
    : undefined;

  return (
    <div
      className={`doc-viewer${attribution ? ' doc-attributed' : ''}`}
      style={rootStyle}
      data-testid="document-viewer"
    >
      <div className="doc-header">
        <div className="doc-nav">
          <button
            type="button"
            className="doc-btn"
            disabled={at === 0}
            title={t('document.back')}
            aria-label={t('document.back')}
            onClick={() => setAt((i) => Math.max(0, i - 1))}
          >
            {t('document.icon.back')}
          </button>
          <button
            type="button"
            className="doc-btn"
            disabled={at >= history.length - 1}
            title={t('document.forward')}
            aria-label={t('document.forward')}
            onClick={() => setAt((i) => Math.min(history.length - 1, i + 1))}
          >
            {t('document.icon.forward')}
          </button>
        </div>
        {/* the full path on hover, per §5.30's header list */}
        <span className="doc-name" title={current} data-testid="doc-name">
          {baseName(current)}
        </span>
        <span className="doc-dir" title={current}>
          {directoryName(current)}
        </span>
        {attribution ? (
          // A CHIP, not a title bar: a viewer is session-ATTRIBUTED and not
          // session-owned (§5.30), so this says where it came from and claims
          // nothing else. `role="note"` because the chip has to carry its own
          // accessible name — "↳ api-work" read aloud is a rune and a word.
          <span
            className="doc-attribution"
            data-testid="doc-attribution"
            role="note"
            aria-label={t('document.openedFromLabel', { name: attribution.name })}
            title={t('document.openedFromLabel', { name: attribution.name })}
          >
            <span aria-hidden="true">{t('document.icon.lineage')}</span> {attribution.name}
          </span>
        ) : null}
        {encoding && encoding !== 'utf-8' ? (
          <span className="doc-chip" data-testid="doc-encoding">
            {t('document.encodingNote', { encoding: encoding as FileTextEncoding })}
          </span>
        ) : null}
        <span className="doc-header-gap" />
        <div className="doc-modes" role="group" aria-label={t('document.toggleLabel')}>
          <button
            type="button"
            className="doc-btn"
            aria-pressed={mode === 'rendered'}
            // Greyed, never hidden (§5.8): a `.ts` has no rendered view, and
            // saying so is more use than a toggle that silently isn't there.
            disabled={!canRender || isCard}
            title={canRender ? undefined : t('document.renderedOnlyForMarkdown')}
            onClick={() => switchMode('rendered')}
          >
            {t('document.rendered')}
          </button>
          <button
            type="button"
            className="doc-btn"
            aria-pressed={mode === 'source'}
            disabled={isCard}
            onClick={() => switchMode('source')}
          >
            {t('document.source')}
          </button>
        </div>
        {/* The outline's off switch (#1010, §5.30). BESIDE the mode pair and
            not inside it: Rendered|Source are two spellings of one question and
            share a `role="group"`, while this is an independent on/off and
            would muddy that group's name. A PRESSED TOGGLE rather than a label
            flipping between "Hide outline" and "Show outline" — the chip then
            names the thing it controls in both states, and the verb lives in
            the tooltip where the owner's own words can stay. Greyed, never
            hidden, when there is nothing to hide (§5.8). */}
        <button
          type="button"
          ref={outlineToggleRef}
          className="doc-btn doc-outline-toggle"
          data-testid="doc-outline-toggle"
          aria-pressed={outlineShown}
          disabled={!outlineOffered}
          title={
            !outlineOffered
              ? t('document.outlineUnavailable')
              : outlineShown
                ? t('document.hideOutline')
                : t('document.showOutline')
          }
          onClick={toggleOutline}
        >
          {t('document.outline')}
        </button>
        <button
          type="button"
          className="doc-btn"
          title={t('document.openExternally')}
          onClick={() => void files()?.openPath?.(current)}
        >
          {t('document.openExternally')}
        </button>
        <button
          type="button"
          className="doc-btn"
          title={t('document.revealInFolder')}
          onClick={() => void files()?.reveal?.(current)}
        >
          {t('document.revealInFolder')}
        </button>
        {props.onPopoutToggle ? (
          // ONE control for both directions, like the card's (E8-04): pop out
          // and dock back are the same toggle, and two buttons that are never
          // both meaningful is two chances to show the wrong one. Its title is
          // deliberately NOT the card's "Pop out into its own window" — several
          // specs reach for that string by title, and a second match would make
          // them ambiguous rather than wrong, which is the harder failure.
          <button
            type="button"
            className="doc-btn doc-popout"
            data-testid="doc-popout"
            aria-pressed={props.poppedOut === true}
            title={props.poppedOut ? t('document.dockBack') : t('document.popOut')}
            aria-label={props.poppedOut ? t('document.dockBack') : t('document.popOut')}
            onClick={() => props.onPopoutToggle?.()}
          >
            {props.poppedOut ? t('document.icon.dockBack') : t('document.icon.popOut')}
          </button>
        ) : null}
      </div>

      {/* The file went away while it was open (P2-E16-04). A STRIP over the
          document, not in place of it: what you were reading is still the last
          true thing anyone wrote, and losing your place as well as the file
          would be this feature costing more than it gives. */}
      {missing && !unfollowed ? (
        <div className="doc-notice doc-gone" role="status" data-testid="doc-gone">
          {t('document.gone')}
        </div>
      ) : null}
      {/* ...and when we are ALSO not watching for it to come back (#506): the
          same sentence, plus the one thing that can be done about that. */}
      {missing && unfollowed ? (
        <div className="doc-notice doc-gone doc-unfollowed" data-testid="doc-gone">
          <span role="status">{t('document.gone')}</span>
          {followAgain}
        </div>
      ) : null}

      {/* Main stopped following the file (#506). The same shape as the strip
          above and for its reason: the document under it is still the last
          true thing we read. Only over a document (`ok`): with nothing on
          screen there is no "last version" for it to be talking about.
          THE BUTTON IS OUTSIDE THE LIVE REGION, so a screen reader is told the
          sentence and not the sentence plus a button's name, and so the words
          changing after a refused ask re-announce only the words. */}
      {unfollowed && ok && !missing ? (
        <div className="doc-notice doc-unfollowed" data-testid="doc-unfollowed">
          <span role="status">{t(`document.unfollowed.${unfollowed}`)}</span>
          {followAgain}
        </div>
      ) : null}

      {truncated && ok ? (
        <div className="doc-notice" role="status" data-testid="doc-truncated">
          {t('document.truncated', {
            shown: formatBytes(ok.bytes ?? 0),
            size: formatBytes(ok.size),
          })}
        </div>
      ) : null}

      {loading ? (
        <div className="doc-body-message" role="status">
          {t('document.loading')}
        </div>
      ) : result && !result.ok ? (
        <div className="doc-body-message doc-refusal" role="status" data-testid="doc-refusal">
          {t(`document.refusal.${result.reason}`)}
        </div>
      ) : isCard ? (
        <div className="doc-card" data-testid="doc-card">
          <div className="doc-card-title">{t('document.card.title')}</div>
          <div className="doc-card-body">
            {meta.extension
              ? t('document.card.body', {
                  name: meta.name,
                  type: meta.extension.toUpperCase(),
                  size: formatBytes(ok?.size ?? 0),
                })
              : t('document.card.bodyUnknown', {
                  name: meta.name,
                  size: formatBytes(ok?.size ?? 0),
                })}
          </div>
          <div className="doc-card-actions">
            <button type="button" className="doc-btn" onClick={() => void files()?.openPath?.(current)}>
              {t('document.openExternally')}
            </button>
            <button type="button" className="doc-btn" onClick={() => void files()?.reveal?.(current)}>
              {t('document.revealInFolder')}
            </button>
          </div>
        </div>
      ) : showRendered ? (
        <div className="doc-rendered-wrap">
          {outlineShown ? (
            // UNMOUNTED, not `display: none`, when the reader turns it off:
            // `.doc-outline` is a flex item beside a `flex: 1` `.doc-main`, so
            // taking it out of the tree is what hands its width back to the
            // document — and it takes the outline's tab stops with it, which a
            // hidden-but-present nav would not.
            <nav className="doc-outline" ref={outlineRef} aria-label={t('document.outline')}>
              <div className="doc-outline-title">{t('document.outline')}</div>
              <ul>
                {outline.map((h) => (
                  <li key={h.id} className={`doc-outline-l${h.level}`}>
                    <button
                      type="button"
                      className="doc-outline-link"
                      onClick={() =>
                        headingById(bodyRef.current, h.id)?.scrollIntoView?.({ block: 'start' })
                      }
                    >
                      {h.text}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          {/* THE SEARCH ROOT, not just a layout box (#533). The find surface
              marks inside THIS element rather than inside `.doc-md`, so that
              expanded front matter — text the reader can see — is searchable
              too. A zero over something on screen is the same lie §5.31 refuses
              one level up, and the chrome inside it (the "Front matter" chip)
              is excluded by `document-find`'s own walker. Collapsed front
              matter is not in the DOM at all, so it is honestly not searched. */}
          <div className="doc-main" ref={mainRef}>
            {front.frontMatter !== undefined ? (
              <div className="doc-front">
                <button
                  type="button"
                  className="doc-front-chip"
                  aria-expanded={frontOpen}
                  onClick={() => setFrontOpen((v) => !v)}
                >
                  {t('document.frontMatter')}
                </button>
                {frontOpen ? <pre className="doc-front-body">{front.frontMatter}</pre> : null}
              </div>
            ) : null}
            <div
              ref={scrollRef}
              className="doc-body"
              data-testid="doc-scroll"
              // WHERE THE READER IS, recorded as they read (P2-E16-04). The
              // decoration effect hands this back after every re-render, which
              // is the whole of "preserving scroll position": without it a
              // rewrite of the file would drop the reader at the top of the
              // document, and an agent that saves every few seconds would make
              // the pane unreadable. `switchMode` still records it explicitly —
              // a mode toggle is not a scroll, so no event fires for it.
              onScroll={(e) => {
                scrollMemo.current.rendered = e.currentTarget.scrollTop;
              }}
              onClick={(e) => activate(e.target as HTMLElement)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  const el = e.target as HTMLElement;
                  if (el.getAttribute?.('role') === 'link') {
                    e.preventDefault();
                    activate(el);
                  }
                }
              }}
            >
              {/* The rendered HTML is written by the effect above, never by
                  React: it is decorated DOM, not JSX, and letting React own the
                  children would have it discard the decoration on every
                  render. */}
              <div ref={bodyRef} className="doc-md" data-testid="doc-rendered" />
            </div>
          </div>
        </div>
      ) : (
        <div className="doc-body doc-source-wrap" data-testid="doc-source">
          <React.Suspense fallback={<div className="doc-body-message">{t('document.loading')}</div>}>
            <DocumentSource
              text={text}
              language={meta.language}
              colorScheme={props.colorScheme}
              initialScrollTop={scrollMemo.current.source}
              onScrollTop={(top) => {
                scrollMemo.current.source = top;
              }}
              // §5.31 delegates the source body's find to Monaco's own widget
              // rather than reimplementing it (#533). Held structurally, so the
              // viewer still never imports monaco.
              onEditor={(editor) => {
                sourceEditor.current = editor;
                setSourceReady(!!editor);
              }}
            />
          </React.Suspense>
        </div>
      )}
    </div>
  );
}
