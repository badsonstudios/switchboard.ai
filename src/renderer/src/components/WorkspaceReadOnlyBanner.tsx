import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const banner: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  columnGap: 6,
  // the window is a 100vh flex column whose main area has basis 0, so every
  // pixel of negative free space lands on the auto-basis children: without
  // this, a short window clips the one notice that must not be missed
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
 */
export function WorkspaceReadOnlyBanner(): React.JSX.Element {
  const { t } = useTranslation();
  const [readOnly, setReadOnly] = useState(false);

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
    // polite, not assertive: by the time it has anything to say it is already
    // on screen, and it is not an interruption — it is the standing condition
    // of this whole run
    <div role="status" style={readOnly ? banner : undefined}>
      {readOnly ? (
        <>
          <strong>{t('workspace.readOnlyTitle')}</strong>
          <span>{t('workspace.readOnlyBody')}</span>
        </>
      ) : null}
    </div>
  );
}
