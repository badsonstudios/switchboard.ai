import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * "The claude CLI isn't there, so nothing will start" — the app's first-run
 * preflight notice (P1-E6-03, §5.25).
 *
 * It used to be rendered as `{!preflightOk && <PreflightBanner />}` in App: the
 * element and its words arrived in the same commit, and it carried no live
 * region at all. To a screen-reader user that is a warning that never happens —
 * the one message explaining why no session will ever start was silent, and the
 * user is left with a disabled "new session" and no stated reason (#222).
 * DESIGN §5.32: screen-reader labels on status surfaces.
 *
 * Two things make it announce, and it needs both — this is why it was never a
 * one-attribute fix:
 *
 * - **`role="status"`**, so the words are announced where they land instead of
 *   only being reachable by someone who happens to walk the document.
 * - **The region exists before the words do.** A live region that is INSERTED
 *   already holding its text is announced by almost nothing; one that already
 *   exists when text lands inside it is announced properly. This is exactly the
 *   defect #168's reviewer caught on the read-only banner.
 *
 * Guaranteed twice over, because each cover has a hole the other fills:
 *
 * 1. App renders this unconditionally, so the region is in the document from
 *    the first frame it draws and `shown` only gates what is INSIDE it.
 * 2. `spoken` holds the words back one commit anyway. App's whole tree is
 *    behind a `!uiReady` gate, so this can mount with `shown` ALREADY true if
 *    the preflight answer beats the UI state off disk — and it can: a MISSING
 *    CLI is the fast path through `runPreflight` (no `--version` to spawn).
 *    Point 1 alone would leave that race deciding whether a screen-reader user
 *    is told anything. Same trick, same reason, as #208's popout notice.
 *
 * Polite, not assertive (`role="status"` is polite by definition): it is the
 * standing condition of the whole run, not an interruption.
 *
 * **Main window only**, unlike the read-only notice, which #208 portals into
 * every popout. Deliberate: preflight is a boot condition that has resolved
 * long before a popout can exist, and its banner belongs to the window where
 * new sessions are started — the thing it says is disabled.
 *
 * The look stays in `.preflight-banner` in tokens.css (#206): the fill/ink pair
 * has a contrast floor to meet in every theme, and a pair the drift test can
 * read out of a stylesheet rule is a pair it can hold to that floor. Unstyled
 * and empty, the region is a zero-height box — nothing on screen moves. The
 * fill is driven by `spoken` too, so the strip never paints a frame early with
 * nothing written on it.
 */
export function PreflightBanner({ shown }: { shown: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const [spoken, setSpoken] = useState(false);
  // the commit AFTER the region exists — see point 2 above
  useEffect(() => {
    setSpoken(shown);
  }, [shown]);
  return (
    <div role="status" className={spoken ? 'preflight-banner' : undefined}>
      {spoken ? t('preflight.missingCli') : null}
    </div>
  );
}
