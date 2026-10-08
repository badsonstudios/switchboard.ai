// The rename box for something on the sessions strip (#1143): a pill, or a
// group's entry.
//
// It takes the PLACE of the thing being renamed rather than sitting inside it.
// A pill and a group entry are both buttons, and a text box cannot live inside
// a button; a row in a group's list is not a button, so it keeps using
// `SessionRow`'s own field.
//
// The rules are the rail's, in the rail's idiom (#294, #311): a blank name is
// not a rename, the name is trimmed on the way through, and Escape and blur
// both end the edit and leave the name that was there.
import React from 'react';

export function StripRenameBox(props: {
  /** what is being renamed, for assistive tech: "Rename <name>" */
  label: string;
  /** the name as it is now — where the edit starts */
  initial: string;
  /** a non-blank, trimmed name; the edit ends either way */
  onRename: (name: string) => void;
  onEnd: () => void;
  /** the e2e handle: the id of the session or group being renamed */
  target: string;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState(props.initial);
  return (
    <span
      data-strip-rename={props.target}
      style={{
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        minBlockSize: 43,
        paddingInline: 8,
        borderRadius: 7,
        border: '1px solid var(--status-working-ink)',
        background: 'var(--rail-card)',
      }}
    >
      <input
        autoFocus
        aria-label={props.label}
        value={draft}
        // select the whole name: a rename usually replaces it, and with the
        // text selected typing does that while the arrows still let you edit
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={props.onEnd}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // CONSUMED, and it has to be. Ending the edit hands the keyboard
            // back to the pill or the group, which is a button — and a button
            // that gains focus while Enter is still going down is "clicked" by
            // that same Enter. Found in the real app: renaming a group opened
            // its list. jsdom does not do this, so only the flag can be tested.
            e.preventDefault();
            const name = draft.trim();
            if (name) props.onRename(name);
            props.onEnd();
          }
          if (e.key === 'Escape') {
            // ours, and only ours: this must not also reach whatever else is
            // listening for Escape and close it
            e.stopPropagation();
            props.onEnd();
          }
        }}
        style={{
          inlineSize: 150,
          background: 'var(--panel2)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 11.5,
          fontFamily: 'var(--font-ui)',
        }}
      />
    </span>
  );
}
