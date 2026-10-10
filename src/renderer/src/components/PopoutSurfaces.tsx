// The things that live at the app's root, drawn again in each popped-out window
// (#1022, and the two gaps found beside it on 2026-10-09).
//
// A popped-out session is not a second app. Dockview opens a window and ADOPTS
// the panel's DOM into it; the panel's JavaScript, its store and its React tree
// go on running here, in the main window. So everything a card renders arrives
// in the popout by itself. What does NOT arrive is anything mounted beside the
// cards at the root of `App`, because that is drawn into THIS document and a
// popout is another one:
//
//   - the live region, so a screen reader in a popout heard nothing;
//   - the last-prompt box, which listens for the pointer on one document.
//
// Both are small and both have the same answer: one instance per window,
// portalled into that window's own `<body>`. This is the one place that does
// it, so the next root-level surface that has to exist in a popout has a list
// to join rather than a third copy of the loop to write.
//
// (The theme and the other document-wide flags travel a different way, as
// attributes copied across: `lib/tab-rows.ts` → `syncDocumentFlags`.)
import React, { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ContributionBoundary } from '../extensibility/boundary';
import { getPopoutWindows, subscribePopoutChange } from '../lib/popout-windows';
import { LastPromptHover } from './LastPromptHover';
import { LiveRegion } from './LiveRegion';

/**
 * A window's body, or null for one that has closed (fail open: draw nothing).
 * The `try` is defence, not an observed throw: a popout that closes by its own
 * X can stay in the registry for a few seconds, until the liveness sweep.
 */
function bodyOf(win: Window): HTMLElement | null {
  try {
    return win.closed ? null : (win.document?.body ?? null);
  } catch {
    return null;
  }
}

/**
 * IN A BOUNDARY THAT DRAWS NOTHING. These are drawn into windows that can
 * close under them, at the root of the app, where the only thing above is the
 * renderer itself: a throw here would blank every session. Losing the
 * announcements in a popout is the old behaviour; losing the window is not.
 */
export function PopoutSurfaces(): React.JSX.Element {
  return (
    <ContributionBoundary id="popout-surfaces">
      <Surfaces />
    </ContributionBoundary>
  );
}

function Surfaces(): React.JSX.Element {
  // straight from the registry, the way `WorkspaceNoticeBanner` reads it (#227)
  const popouts = useSyncExternalStore(subscribePopoutChange, getPopoutWindows);
  return (
    <>
      {popouts.map((p) => {
        const body = bodyOf(p.win);
        if (!body) return null;
        // one fragment per popout, keyed by the registry's own id, so a second
        // popout opening or closing remounts nothing in the first
        return (
          <React.Fragment key={p.id}>
            {createPortal(<LiveRegion win={p.win} />, body)}
            <LastPromptHover win={p.win} />
          </React.Fragment>
        );
      })}
    </>
  );
}
