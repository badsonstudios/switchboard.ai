// "See what it was told" (E40 item 12, #1295; design record §5 screen 3): the
// exact text an AI was briefed with when a card switched to it.
//
// READ-ONLY AND BYTE-EXACT. The text is the file main kept when the briefing
// was sent (`sessions:briefingText`), shown in a `<pre>` as it is — not
// rendered as markdown, because what the reader came to check is what the AI
// was handed, character for character. Copy puts those same characters on the
// clipboard.
//
// THE SHAPE is `ContextDropDialog`'s — scrim, click-away, Escape, focus taken
// in the commit that shows it and given back on close, one place on the modal
// stack (#1020) — because two modals that behave differently is a bug report
// waiting to happen. There was no exact-text viewer to reuse: the drop dialog
// is a picker and shows no text.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useModalLayer } from '../lib/modal-layer';
import type { AiSwitchMark, BriefingTextResult } from '../../../shared/ai-switch';

export interface BriefingDialogProps {
  mark: AiSwitchMark;
  /** the mark's `briefingRef` */
  briefingRef: string;
  onClose: () => void;
}

type Loaded = { state: 'loading' } | { state: 'text'; text: string } | { state: 'gone' };

/** Is this the channel's answer, and not a refusal or a missing bridge? */
function isBriefingText(v: unknown): v is BriefingTextResult {
  return !!v && typeof v === 'object' && typeof (v as { ok?: unknown }).ok === 'boolean';
}

export function BriefingDialog(props: BriefingDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const { top, lift } = useModalLayer(true, dialog);
  const [loaded, setLoaded] = React.useState<Loaded>({ state: 'loading' });
  const [copied, setCopied] = React.useState(false);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();
  const subtitleId = React.useId();
  const bodyId = React.useId();

  React.useLayoutEffect(() => {
    returnFocusTo.current = dialog.current?.ownerDocument.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, []);

  React.useEffect(() => {
    let live = true;
    // a missing bridge, a refusal, a rejection: all "no longer available" —
    // the viewer never crashes over a file it cannot show
    const call = window.switchboard?.sessions?.briefingText?.(props.briefingRef);
    Promise.resolve(call)
      .then((r) => {
        if (!live) return;
        setLoaded(isBriefingText(r) && r.ok ? { state: 'text', text: r.text } : { state: 'gone' });
      })
      .catch(() => live && setLoaded({ state: 'gone' }));
    return () => {
      live = false;
    };
  }, [props.briefingRef]);

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const copy = (): void => {
    if (loaded.state !== 'text') return;
    void navigator.clipboard
      ?.writeText(loaded.text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  const names = { from: props.mark.from.name, to: props.mark.to.name };
  const chip: React.CSSProperties = {
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
      onMouseDown={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51 + lift,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '8vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal={top ? 'true' : undefined}
        inert={!top}
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        data-testid="briefing-dialog"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        style={{
          inlineSize: 'min(720px, 94vw)',
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
        <div
          style={{
            padding: '11px 14px',
            borderBlockEnd: '1px solid var(--border)',
            background: 'var(--panel2)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, minInlineSize: 0 }}>
            <span id={titleId} style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
              {t('aiSwitch.briefingTitle', names)}
            </span>
            <span id={subtitleId} style={{ display: 'block', fontSize: 11, color: 'var(--muted)', marginBlockStart: 2 }}>
              {t('aiSwitch.briefingSubtitle', names)}
            </span>
          </span>
          <button
            type="button"
            onClick={close}
            aria-label={t('aiSwitch.briefingClose')}
            title={t('aiSwitch.briefingClose')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: 4,
            }}
          >
            {t('aiSwitch.briefingCloseIcon')}
          </button>
        </div>

        <div id={bodyId} style={{ flex: 1, minBlockSize: 0, overflow: 'auto', padding: '10px 14px' }}>
          {loaded.state === 'loading' && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('aiSwitch.briefingLoading')}</div>
          )}
          {loaded.state === 'gone' && (
            <div data-briefing-gone style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {t('aiSwitch.briefingGone')}
            </div>
          )}
          {loaded.state === 'text' && (
            <pre
              data-briefing-text
              style={{
                margin: 0,
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                userSelect: 'text',
              }}
            >
              {loaded.text}
            </pre>
          )}
        </div>

        <div
          style={{
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, minInlineSize: 0 }} />
          <button
            type="button"
            data-briefing-copy
            disabled={loaded.state !== 'text'}
            onClick={copy}
            style={{ ...chip, color: loaded.state === 'text' ? 'var(--text)' : 'var(--muted)' }}
          >
            <span aria-live="polite">{copied ? t('aiSwitch.briefingCopied') : t('aiSwitch.briefingCopy')}</span>
          </button>
          <button type="button" data-briefing-close onClick={close} style={chip}>
            {t('aiSwitch.briefingClose')}
          </button>
        </div>
      </div>
    </div>
  );
}
