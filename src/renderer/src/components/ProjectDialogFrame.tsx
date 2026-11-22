// The frame the project dialogs share (E42 step 2, #1506): new worktree,
// project settings, and the busy-folder prompt. The same modal contract as
// `OpenProjectDialog` and `NameSessionDialog`: the modal layer, Escape and a
// click on the scrim cancel, Ctrl+Enter accepts, focus goes back where it came
// from. The styles are the Open project dialog's, so all four read as one set.
import React from 'react';
import { useModalLayer } from '../lib/modal-layer';

export const dialogButton: React.CSSProperties = {
  background: 'var(--chip)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-chip)',
  padding: '4px 12px',
  cursor: 'pointer',
  fontFamily: 'var(--font-ui)',
  fontSize: 11.5,
};

export const dialogField: React.CSSProperties = {
  background: 'var(--panel2)',
  color: 'var(--text)',
  border: '1px solid var(--control-edge)',
  borderRadius: 4,
  padding: '5px 7px',
  fontSize: 12,
  fontFamily: 'var(--font-ui)',
  minWidth: 0,
};

export const dialogLabel: React.CSSProperties = { fontSize: 11, color: 'var(--muted)' };

/** The primary button: bold, dimmed while it cannot be pressed. */
export function primaryButton(ready: boolean): React.CSSProperties {
  return {
    ...dialogButton,
    color: ready ? 'var(--text)' : 'var(--muted)',
    cursor: ready ? 'pointer' : 'default',
    fontWeight: 600,
    padding: '4px 14px',
  };
}

export interface ProjectDialogFrameProps {
  testId: string;
  title: string;
  blurb?: React.ReactNode;
  /** the footer's left-hand note */
  note?: React.ReactNode;
  /** the footer's buttons, right-aligned */
  buttons: React.ReactNode;
  onCancel: () => void;
  /** Ctrl/Cmd+Enter, when the dialog can be accepted */
  onAccept?: () => void;
  width?: number;
  children: React.ReactNode;
}

export function ProjectDialogFrame(props: ProjectDialogFrameProps): React.JSX.Element {
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const { top, lift } = useModalLayer(true, dialog);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);

  React.useLayoutEffect(() => {
    const doc = dialog.current?.ownerDocument ?? document;
    returnFocusTo.current = doc.activeElement as HTMLElement | null;
    // the first field takes focus when there is one, else the dialog itself
    const first = dialog.current?.querySelector<HTMLElement>('[data-autofocus]');
    (first ?? dialog.current)?.focus();
  }, []);

  const cancel = (): void => {
    const view = dialog.current?.ownerDocument.defaultView ?? window;
    props.onCancel();
    const el = returnFocusTo.current;
    view.requestAnimationFrame(() => el?.focus?.());
  };

  return (
    <div
      onMouseDown={cancel}
      data-no-maximize
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51 + lift,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '10vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal={top ? 'true' : undefined}
        inert={!top}
        aria-label={props.title}
        data-testid={props.testId}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && props.onAccept) {
            e.preventDefault();
            props.onAccept();
          }
        }}
        style={{
          inlineSize: `min(${props.width ?? 500}px, 94vw)`,
          maxBlockSize: '84vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          outline: 'none',
        }}
      >
        <div style={{ padding: '11px 14px', borderBlockEnd: '1px solid var(--border)', background: 'var(--panel2)' }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{props.title}</div>
          {props.blurb && (
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBlockStart: 3 }}>{props.blurb}</div>
          )}
        </div>
        <div style={{ padding: '12px 14px', display: 'grid', gap: 10, overflowY: 'auto' }}>{props.children}</div>
        <div
          style={{
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, fontSize: 10.5, color: 'var(--muted)', minWidth: 0 }}>{props.note}</span>
          {props.buttons}
        </div>
      </div>
    </div>
  );
}
