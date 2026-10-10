// What an empty workspace says (#1166): one line, and one button that starts a
// session.
//
// Found while moving "+ session" into the Sessions list (#1163): with the list
// hidden and nothing open, the window was blank, and nothing on screen said
// how to start. The ways in (the list's own button, the command list, Ctrl+N)
// all need you to know something first.
//
// WHEN IT SHOWS is not decided here. It is the dock's own "watermark": the
// docking library draws it exactly when the workspace holds no panel at all
// and takes it away the moment one is added. That settles the ticket's three
// questions with no bookkeeping of our own:
//
//   * it shows whether or not the Sessions list is hidden. With the list
//     showing, the list says "No sessions yet" beside its own button and this
//     says the same in the middle of the window; two doors to one room is
//     better than a rule about when the second door exists;
//   * a workspace holding only a document or a diff is NOT empty, and shows
//     nothing: there is something to look at, and a banner over it would be
//     in the way;
//   * it goes when the first card is ADDED, which is the earliest moment there
//     is anything else to show. (Between the click and the card there is the
//     folder picker, a native dialog over the window.)
//
// The button runs the grid's own "new session" path, handed down by context,
// so it is the same gesture as "+ session" in the list: folder picker, then
// the card, in this window.
import React from 'react';
import { useTranslation } from 'react-i18next';

/** What the empty workspace can do. Provided by the grid around its dock. */
export const EmptyWorkspaceActions = React.createContext<{
  onNewSession?: () => void;
}>({});

export function EmptyWorkspace(): React.JSX.Element {
  const { t } = useTranslation();
  const { onNewSession } = React.useContext(EmptyWorkspaceActions);
  return (
    <div
      data-testid="empty-workspace"
      style={{
        blockSize: '100%',
        inlineSize: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: 24,
        boxSizing: 'border-box',
        textAlign: 'center',
        fontFamily: 'var(--font-ui)',
        color: 'var(--muted)',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
        {t('emptyWorkspace.title')}
      </div>
      <div style={{ fontSize: 12, maxInlineSize: 440, lineHeight: 1.45 }}>
        {t('emptyWorkspace.blurb')}
      </div>
      {/* no handler, no button: a button that does nothing is worse than none
          (a popped-out window's dock, or a test's bare mount).

          ITS WORDS ARE ITS OWN, not the list's "+ session". Two buttons with
          one name is a question ("which one?") for a screen reader, and for
          every test that asks for the button called "+ session". */}
      {onNewSession && (
        <button
          type="button"
          data-testid="empty-workspace-new-session"
          onClick={onNewSession}
          style={{
            marginBlockStart: 4,
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--btn-primary-text)',
            background: 'var(--btn-primary-bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '6px 14px',
            cursor: 'pointer',
          }}
        >
          {t('emptyWorkspace.start')}
        </button>
      )}
    </div>
  );
}
