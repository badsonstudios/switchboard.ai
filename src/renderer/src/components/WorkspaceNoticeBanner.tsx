import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { WorkspaceSaveState } from '../../../shared/workspace';
import { mountBannerHost, unmountBannerHost } from '../lib/popout-banner-host';
import { getPopoutWindows, subscribePopoutChange } from '../lib/popout-windows';

const banner: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  columnGap: 6,
  // the window is a 100vh flex column whose main area has basis 0, so every
  // pixel of negative free space lands on the auto-basis children: without
  // this, a short window clips the one notice that must not be missed.
  // Deleting it used to be green (#274); always-visible-notices.test.ts is
  // what keeps it here now.
  flexShrink: 0,
  background: 'var(--panel2)',
  // the only decoration — an accent edge in the "wants something from you"
  // status color, on a surface that carries --text at 9:1 (dark) / 14:1
  // (light), so the words never depend on the accent to be legible
  borderBlockEnd: '2px solid var(--status-needs-permission)',
  color: 'var(--text)',
  fontFamily: 'var(--font-ui)',
  fontSize: 12,
  padding: '6px 12px',
};

/** what the strip is saying right now, or null when it has nothing to say */
interface Notice {
  title: string;
  body: string;
}

/**
 * "Your workspace is not being saved" — said on screen rather than only in the
 * log. One strip, two reasons.
 *
 * **The file is from the future (#110/#168).** The store refuses every write
 * when the file's schema version is ahead of this build, because writing it
 * back would rewrite the user's file as a lossy v1 and delete whatever the
 * newer version added. Refusing is right; refusing SILENTLY is not — a user who
 * rearranged a whole workspace would lose the lot at quit with nothing having
 * warned them. Latched at load, so it never goes away this run.
 *
 * **The writes are FAILING (#207).** The file is ordinary and switchboard is
 * trying to write it, but the disk is full, a permission changed, or something
 * has the file open. #165 made that a log line; this makes it the same strip,
 * because it is the same loss — the layout on disk quietly stops keeping up
 * with the one on screen, and the next launch restores a stale workspace with
 * no hint why. Unlike the read-only case this one COMES AND GOES, which is the
 * whole reason it is pushed rather than read once (see below).
 *
 * The two cannot happen at once — a read-only store attempts no writes, so its
 * writes cannot fail — but read-only wins the slot anyway, being the stronger
 * and permanent statement.
 *
 * Deliberate choices:
 *
 * - **A banner, not a toast.** Both conditions last, and the harm lands at
 *   quit — hours after a toast would have faded.
 * - **Not dismissible.** A dismissal is exactly the state we are trying to
 *   avoid: the notice gone, the work still being discarded. The save-failure
 *   notice dismisses ITSELF, by the condition ending — which is the only
 *   honest way for this strip to disappear.
 * - **The live region is always mounted**, empty until there is something to
 *   say. A `role="status"` that arrives WITH its text is announced by almost
 *   nothing; one that already exists when the text lands is announced
 *   properly — and this notice is the only warning a screen-reader user gets.
 *   It is also what makes the save-failure text, which lands seconds into a
 *   run and can be replaced by silence later, audible at all.
 * - **Self-contained.** It reads its own state so the app shell pays one
 *   import and one line for it.
 *
 * #208 added the same notice to every POPPED-OUT window (see below): one call,
 * one component, several places to draw it.
 */
export function WorkspaceNoticeBanner(): React.JSX.Element {
  const { t } = useTranslation();
  const [readOnly, setReadOnly] = useState(false);
  const [saveFailure, setSaveFailure] = useState<WorkspaceSaveState | null>(null);
  // The popouts currently open, read straight from the shared registry (#227)
  // rather than mirrored into state here. Read UNCONDITIONALLY, whether or not
  // there turns out to be anything to say: both answers are IPC round-trips and
  // at boot a restored popout can open inside one, so a list that only started
  // filling once an answer landed would never hear about the one window the
  // user restored on purpose.
  const popouts = useSyncExternalStore(subscribePopoutChange, getPopoutWindows);

  useEffect(() => {
    let live = true;
    // fail-open: a missing bridge, or an older preload without this channel,
    // must not take the window down. The store refuses to write either way, so
    // the worst case here is a missing notice — never a damaged file.
    void Promise.resolve(window.switchboard?.workspace?.isReadOnly?.())
      .then((ro) => {
        if (live && ro === true) setReadOnly(true);
      })
      .catch(() => {
        /* no notice is better than no window */
      });
    return () => {
      live = false;
    };
  }, []);

  // Whether a push has already told us the truth. The initial read below is a
  // round-trip, and saving can start or stop failing while it is in flight; the
  // push is always newer than an answer that predates it, so once one has
  // arrived the read is stale by definition and is dropped.
  const pushed = useRef(false);
  useEffect(() => {
    let live = true;
    const apply = (s: WorkspaceSaveState | undefined): void => {
      if (live) setSaveFailure(s?.failing ? s : null);
    };
    // SUBSCRIBE FIRST, then read: the other order has a window between the
    // answer and the listener in which a change is simply lost, and the change
    // that gets lost is "saving just started failing".
    let off: (() => void) | undefined;
    try {
      off = window.switchboard?.workspace?.onSaveStateChanged?.((s) => {
        pushed.current = true;
        apply(s);
      });
    } catch {
      /* no notice is better than no window */
    }
    void Promise.resolve(window.switchboard?.workspace?.saveState?.())
      .then((s) => {
        if (!pushed.current) apply(s);
      })
      .catch(() => {
        /* as above */
      });
    return () => {
      live = false;
      off?.();
    };
  }, []);

  const notice: Notice | null = readOnly
    ? { title: t('workspace.readOnlyTitle'), body: t('workspace.readOnlyBody') }
    : saveFailure
      ? {
          title: t('workspace.saveFailedTitle'),
          body: t('workspace.saveFailedBody', { file: saveFailure.file }),
        }
      : null;

  return (
    <>
      <WorkspaceNotice notice={notice} />
      {/* the same notice, in every window the user might actually be looking
          at (#208). Nothing extra is asked of main: one answer, drawn N times */}
      {notice ? popouts.map((p) => <PopoutNotice key={p.id} win={p.win} notice={notice} />) : null}
    </>
  );
}

/**
 * The strip itself. A `notice` prop rather than an early `null` return so the
 * live region is mounted from the start — see the note above.
 */
function WorkspaceNotice({ notice }: { notice: Notice | null }): React.JSX.Element {
  return (
    // polite, not assertive: it is not an interruption — it is the standing
    // condition of this run, and by the time it has anything to say the region
    // is already on screen
    <div role="status" style={notice ? banner : undefined}>
      {notice ? (
        <>
          <strong>{notice.title}</strong>
          <span>{notice.body}</span>
        </>
      ) : null}
    </div>
  );
}

/**
 * The notice inside one popped-out window (#208).
 *
 * A portal, not a second component tree: the popout is a different DOCUMENT but
 * the same React tree, so the text, the styling and — crucially — the single
 * answer from main are shared. The notice has no interactive parts, which is
 * what makes a cross-document portal safe here (React's synthetic events are
 * delegated to the tree's own root container, not this one).
 *
 * The host element is created in a layout effect rather than during render:
 * mutating another document while rendering is exactly the kind of thing React
 * 19's double-invoked renders punish. One extra tick before it paints; a popout
 * window is a hundred milliseconds of its own opening anyway.
 *
 * The words then land on the NEXT commit, so the live region exists — empty —
 * before it has anything to say. Same reason as the main window's (above): a
 * `role="status"` that appears already holding its text is announced by almost
 * nothing. In a popout it is usually this case, because the condition has long
 * since been established by the time the window opens, so without the extra
 * commit the notice would be silent in exactly the window the user is sitting
 * in. The host is still mounted only when there IS something to say — a
 * workspace that saves normally must not have its popouts re-laid-out for a
 * notice that never comes, and a save-failure notice that CLEARS has to take
 * the host with it.
 *
 * The session below it shrinks rather than being covered or clipped: the notice
 * takes its space from dockview's container (see popout.html), and dockview
 * re-lays the popout's gridview out from that container's client box, not from
 * the window's. MEASURED, because the initial layout DOES come from
 * `window.innerHeight` and only a same-realm ResizeObserver corrects it: with
 * the container pinned to 400px the group's own pixel width followed it to 400
 * rather than staying at the window's 722, and the terminal re-fit from 31 rows
 * to 28 the moment the notice appeared.
 */
function PopoutNotice({ win, notice }: { win: Window; notice: Notice }): React.JSX.Element | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [spoken, setSpoken] = useState(false);
  useLayoutEffect(() => {
    setHost(mountBannerHost(win));
    return () => unmountBannerHost(win);
  }, [win]);
  // the commit AFTER the region exists — see the note above
  useEffect(() => {
    if (host) setSpoken(true);
  }, [host]);
  return host ? createPortal(<WorkspaceNotice notice={spoken ? notice : null} />, host) : null;
}
