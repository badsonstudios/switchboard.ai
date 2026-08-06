import React, { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
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

/**
 * "This workspace file came from a newer switchboard.ai, so nothing you do
 * this run will be saved" — said on screen rather than only in the log.
 *
 * #110 made the store refuse every write when the file's schema version is
 * ahead of this build (writing it back would rewrite their file as a lossy v1
 * and delete whatever the newer version added). Refusing is right; refusing
 * SILENTLY is not — a user who rearranged a whole workspace would lose the lot
 * at quit with nothing having warned them. P9: never hide what we are doing.
 *
 * Four deliberate choices:
 *
 * - **A banner, not a toast.** This is a condition that lasts the whole run,
 *   and the harm lands at quit — hours after a toast would have faded.
 * - **Not dismissible.** A dismissal is exactly the state we are trying to
 *   avoid: the notice gone, the work still being discarded.
 * - **The live region is always mounted**, empty until there is something to
 *   say. A `role="status"` that arrives WITH its text is announced by almost
 *   nothing; one that already exists when the text lands is announced
 *   properly — and this notice is the only warning a screen-reader user gets.
 * - **Self-contained.** It reads its own state so the app shell pays one
 *   import and one line for it. Read-only-ness latches in `load()` and never
 *   changes for the process lifetime, so a single read at mount is the whole
 *   story — no subscription, no polling.
 *
 * #208 added the same notice to every POPPED-OUT window (see below): one call,
 * one component, several places to draw it.
 */
export function WorkspaceReadOnlyBanner(): React.JSX.Element {
  const [readOnly, setReadOnly] = useState(false);
  // The popouts currently open, read straight from the shared registry (#227)
  // rather than mirrored into state here. Read UNCONDITIONALLY, whether or not
  // the workspace turns out to be read-only: `isReadOnly()` is an IPC
  // round-trip and at boot a restored popout can open inside it, so a list that
  // only started filling once the answer landed would never hear about the one
  // window the user restored on purpose.
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

  return (
    <>
      <ReadOnlyNotice shown={readOnly} />
      {/* the same notice, in every window the user might actually be looking
          at (#208). Nothing extra is asked of main: one answer, drawn N times */}
      {readOnly
        ? popouts.map((p) => <PopoutReadOnlyNotice key={p.id} win={p.win} />)
        : null}
    </>
  );
}

/**
 * The strip itself. `shown` rather than an early `null` return so the live
 * region is mounted from the start — see the note above.
 */
function ReadOnlyNotice({ shown }: { shown: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    // polite, not assertive: by the time it has anything to say it is already
    // on screen, and it is not an interruption — it is the standing condition
    // of this whole run
    <div role="status" style={shown ? banner : undefined}>
      {shown ? (
        <>
          <strong>{t('workspace.readOnlyTitle')}</strong>
          <span>{t('workspace.readOnlyBody')}</span>
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
 * `isReadOnly()` answer above are shared. The notice has no interactive parts,
 * which is what makes a cross-document portal safe here (React's synthetic
 * events are delegated to the tree's own root container, not this one).
 *
 * The host element is created in a layout effect rather than during render:
 * mutating another document while rendering is exactly the kind of thing React
 * 19's double-invoked renders punish. One extra tick before it paints; a popout
 * window is a hundred milliseconds of its own opening anyway.
 *
 * The words then land on the NEXT commit, so the live region exists — empty —
 * before it has anything to say. Same reason as the main window's (above): a
 * `role="status"` that appears already holding its text is announced by almost
 * nothing. In a popout it is always this case, because read-only-ness has long
 * since latched by the time the window opens, so without the extra commit the
 * notice would be silent in exactly the window the user is sitting in. The host
 * is still mounted only when there IS something to say — a writable workspace
 * must not have its popouts re-laid-out for a notice that never comes.
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
function PopoutReadOnlyNotice({ win }: { win: Window }): React.JSX.Element | null {
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
  return host ? createPortal(<ReadOnlyNotice shown={spoken} />, host) : null;
}
