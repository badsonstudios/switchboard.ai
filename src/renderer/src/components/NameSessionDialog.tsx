// "Name the new session" (#1282).
//
// WHAT IT REPLACED. Starting a session used to go folder -> (sometimes) a list of
// that folder's earlier conversations -> a card named after the folder, or the
// folder with `-2` on the end. Dan asked for the opposite on both counts: a new
// session ALWAYS starts a fresh conversation (the card's own history button is
// how you reach an earlier one), and it asks what to call it, pre-filled with
// the name it would have got anyway — so the cheapest path is still one Enter.
//
// THE NAME SHOWN IS MAIN'S. The pre-fill comes from `sessions:suggestTitle`,
// which runs the very rule `sessions:create` applies, and so does the check made
// as you type. This dialog never decides what is taken; if it did, it would be a
// second copy of the rule, and the day they disagreed the name you OK'd would
// not be the name you got.
//
// A clash is a WARNING, not a refusal (the issue's recommendation): "that name is
// taken, so it will be called X". OK still works and you get X — the same thing
// that has always happened to a second session in one folder, said in advance
// instead of discovered afterwards.
//
// The shell — scrim, click-away, Escape, focus taken and given back, only the
// top modal is modal — is `ModelPickerDialog`'s. The field's behaviour is
// `StripRenameBox`'s: the whole name selected on open so typing replaces it,
// Enter is OK, Escape is Cancel, and a blank name is not a name.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useModalLayer } from '../lib/modal-layer';
import { MAX_SESSION_TITLE } from '../../../shared/sessions';

/** How long typing must pause before the name is checked with main. */
export const NAME_CHECK_MS = 150;

export interface NameSessionDialogProps {
  /** the folder the session will run in — shown so the user knows which ask this is */
  folder: string;
  /** what the field starts with: the name main would give, already de-duplicated */
  initial: string;
  /**
   * The name main would give a session asking for `name`, or null when it
   * cannot say. Asked as the user types; a null is simply "no warning".
   */
  check: (name: string) => Promise<string | null>;
  /** OK, with a trimmed, non-blank name */
  onConfirm: (name: string) => void;
  /** Cancel, Escape, click-away: no session is started */
  onCancel: () => void;
}

export function NameSessionDialog(props: NameSessionDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const input = React.useRef<HTMLInputElement | null>(null);
  // `dialog` as `where`: a popped-out card opens this in ITS window, and the
  // stack it joins is that document's, not the main window's (#1020)
  const { top, lift } = useModalLayer(true, dialog);
  const [draft, setDraft] = React.useState(props.initial);
  /**
   * What main said about one exact name. Keyed by the name it was asked
   * about, so an answer is only ever read against the text it answers — a slow
   * reply for "app" must not put a warning under "app-x".
   *
   * Seeded with the pre-fill: main produced it, so it is free by construction
   * and there is nothing to ask until the user changes it.
   */
  const [verdict, setVerdict] = React.useState<{ asked: string; title: string | null }>({
    asked: props.initial.trim(),
    title: props.initial.trim(),
  });
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const noteId = React.useId();
  const { check } = props;
  const name = draft.trim();

  // a LAYOUT effect: focused (and selected) in the commit that shows it
  React.useLayoutEffect(() => {
    const doc = dialog.current?.ownerDocument ?? document;
    returnFocusTo.current = doc.activeElement as HTMLElement | null;
    input.current?.focus();
    input.current?.select();
  }, []);

  React.useEffect(() => {
    if (!name || verdict.asked === name) return;
    let live = true;
    const timer = setTimeout(() => {
      // fail-open: a check that fails is "no warning", never a blocked OK
      void check(name)
        .catch(() => null)
        .then((title) => {
          if (live) setVerdict({ asked: name, title });
        });
    }, NAME_CHECK_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [name, verdict.asked, check]);

  const cancel = (): void => {
    // THIS window's frame clock, read before the unmount takes the node: in a
    // popout the main window is often covered, and a covered window's frames
    // are throttled, so its `requestAnimationFrame` may not come round soon
    const view = dialog.current?.ownerDocument.defaultView ?? window;
    props.onCancel();
    // …on the next frame, once this has unmounted and let go of focus
    const el = returnFocusTo.current;
    view.requestAnimationFrame(() => el?.focus?.());
  };
  const accept = (): void => {
    if (name) props.onConfirm(name);
  };

  /** the name main will give instead, when that is not what was typed */
  const renamedTo =
    name && verdict.asked === name && verdict.title && verdict.title !== name ? verdict.title : null;

  const button: React.CSSProperties = {
    background: 'var(--chip)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    padding: '4px 12px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    fontSize: 11.5,
  };

  return (
    <div
      onMouseDown={cancel}
      // Portalled out of a popped-out card's header, but React still bubbles
      // its events up to that header, whose double-click maximises the card:
      // the marker opts this out, as it does the header's own controls.
      data-no-maximize
      style={{
        position: 'fixed',
        inset: 0,
        // above whatever modal was already open (#1020): paint order follows the stack
        zIndex: 51 + lift,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '14vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal={top ? 'true' : undefined}
        inert={!top}
        aria-label={t('nameSession.title')}
        data-testid="name-session-dialog"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // ours, and only ours: nothing behind a modal hears its keys
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        style={{
          inlineSize: 'min(420px, 94vw)',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          outline: 'none',
        }}
      >
        <div
          style={{
            padding: '11px 14px',
            borderBlockEnd: '1px solid var(--border)',
            background: 'var(--panel2)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {t('nameSession.title')}
          <div
            data-name-session-folder
            title={props.folder}
            style={{
              fontWeight: 400,
              fontSize: 11,
              color: 'var(--muted)',
              marginBlockStart: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {t('nameSession.folder', { folder: props.folder })}
          </div>
        </div>
        <div style={{ padding: '12px 14px', display: 'grid', gap: 6 }}>
          <input
            ref={input}
            data-name-session-input
            aria-label={t('nameSession.label')}
            aria-describedby={noteId}
            value={draft}
            maxLength={MAX_SESSION_TITLE}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // not the Enter that commits an IME composition (CommandPalette's guard)
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                // consumed: the card this starts must not also receive this Enter
                e.preventDefault();
                accept();
              }
            }}
            style={{
              background: 'var(--panel2)',
              color: 'var(--text)',
              border: '1px solid var(--control-edge)',
              borderRadius: 4,
              padding: '5px 7px',
              fontSize: 12.5,
              fontFamily: 'var(--font-ui)',
            }}
          />
          <div
            id={noteId}
            role="status"
            data-name-session-note={renamedTo ? 'taken' : !name ? 'blank' : undefined}
            style={{ minBlockSize: 15, fontSize: 11, color: 'var(--muted)' }}
          >
            {renamedTo
              ? t('nameSession.taken', { name: renamedTo })
              : !name
                ? t('nameSession.blank')
                : ''}
          </div>
        </div>
        <div
          style={{
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button type="button" data-name-session-cancel onClick={cancel} style={button}>
            {t('nameSession.cancel')}
          </button>
          <button
            type="button"
            data-name-session-ok
            disabled={!name}
            onClick={accept}
            style={{
              ...button,
              color: name ? 'var(--text)' : 'var(--muted)',
              cursor: name ? 'pointer' : 'default',
              fontWeight: 600,
              padding: '4px 14px',
            }}
          >
            {t('nameSession.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}
