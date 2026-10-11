// The list of prompts you sent in this conversation (#1203). See
// `lib/prompt-history` for what it is and is not.
//
// A PANEL THAT DROPS FROM ITS OWN BUTTON, over the top of the conversation it
// lists, and not a window of its own: you are choosing a place in the thing
// behind it. It is a dialog to assistive technology (it has a name and takes
// the keyboard), it closes on Escape and on a click outside, and it gives the
// keyboard back to its button.
//
// EACH ROW IS TWO BUTTONS, side by side, never one inside the other: the prompt
// itself (go to where it is in the conversation) and "Use again" (put its text
// back in the prompt box). A button inside a button is not a thing a keyboard
// or a screen reader can use.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { filterPrompts, promptAge, type PromptEntry } from '../lib/prompt-history';

export function PromptHistory(props: {
  prompts: readonly PromptEntry[];
  /** the view's buffer is full: older prompts than these exist and are not listed */
  truncated: boolean;
  onJump: (seq: number) => void;
  onRecall: (text: string) => void;
  /**
   * Shut it. `returnFocus` is true only for Escape: that is "never mind", and
   * the keyboard goes back to the button. A press or a Tab somewhere else
   * already put the keyboard where the user wanted it, and taking it back
   * would be stealing it.
   */
  onClose: (returnFocus: boolean) => void;
  /** how tall the panel may be, in px: the room the card has under the toolbar */
  maxBlockSize?: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState('');
  const input = React.useRef<HTMLInputElement | null>(null);
  const panel = React.useRef<HTMLDivElement | null>(null);
  const { onClose } = props;

  // the search box has the keyboard the moment the panel appears (the same
  // layout-effect rule every other dialog here follows, #1171)
  React.useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  // a press anywhere outside closes it. On the panel's OWN document: a card
  // popped out into its own window is a different document from the main one.
  React.useEffect(() => {
    const doc = panel.current?.ownerDocument;
    if (!doc) return;
    const away = (e: Event): void => {
      const target = e.target as Node | null;
      if (target && panel.current?.contains(target)) return;
      // the button that opened it toggles it itself; closing here as well
      // would shut it and let the click open it again
      if ((target as Element | null)?.closest?.('[data-prompt-history-open]')) return;
      onClose(false);
    };
    doc.addEventListener('pointerdown', away, true);
    return () => doc.removeEventListener('pointerdown', away, true);
  }, [onClose]);

  const shown = filterPrompts(props.prompts, query);
  const now = Date.now();
  const age = (p: PromptEntry): string => {
    const a = promptAge(p.ts, now);
    if (!a) return '';
    return a.unit === 'now' ? t('promptHistory.age.now') : t(`promptHistory.age.${a.unit}`, { count: a.count });
  };

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={t('promptHistory.title')}
      data-prompt-history
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      }}
      // It is not modal, so Tab can walk out of it. Leaving by keyboard closes
      // it, the same as a press outside: otherwise it would be left open with
      // no key that shuts it.
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (!to) return; // focus left the window, or went nowhere: not a choice
        if (e.currentTarget.contains(to)) return;
        if ((to as Element).closest?.('[data-prompt-history-open]')) return;
        onClose(false);
      }}
      style={{
        position: 'absolute',
        insetBlockStart: '100%',
        insetInlineEnd: 0,
        zIndex: 5,
        inlineSize: 'min(460px, 100%)',
        // bounded by the CARD, not the window: a short tiled card must not have
        // the end of the list cut off under its own edge
        maxBlockSize: props.maxBlockSize ?? 'min(420px, 70vh)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--panel)',
        border: '1px solid var(--control-edge)',
        borderRadius: 8,
        boxShadow: 'var(--tab-lift)',
        fontFamily: 'var(--font-ui)',
        color: 'var(--text)',
      }}
    >
      <div style={{ padding: '8px 10px 6px', borderBlockEnd: '1px solid var(--border)' }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBlockEnd: 6 }}>
          {t('promptHistory.title')}
        </div>
        <input
          ref={input}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('promptHistory.filter')}
          aria-label={t('promptHistory.filter')}
          data-prompt-history-filter
          className="prompt-history-filter"
        />
      </div>
      <div style={{ overflowY: 'auto', minBlockSize: 0, padding: '4px 0' }}>
        {props.prompts.length === 0 ? (
          <div data-prompt-history-empty style={emptyStyle}>
            {t('promptHistory.empty')}
          </div>
        ) : shown.length === 0 ? (
          <div data-prompt-history-empty style={emptyStyle}>
            {t('promptHistory.noMatch', { query })}
          </div>
        ) : (
          <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {shown.map((p) => (
              <li
                key={p.seq}
                data-prompt-history-row={p.seq}
                style={{ display: 'flex', alignItems: 'stretch', gap: 4, paddingInline: 6 }}
              >
                <button
                  type="button"
                  className="prompt-history-row"
                  data-prompt-history-jump
                  title={t('promptHistory.jumpHint')}
                  onClick={() => props.onJump(p.seq)}
                >
                  <span className="prompt-history-text" data-command={p.command ? 'true' : undefined}>
                    {p.text}
                  </span>
                  <span className="prompt-history-age">{age(p)}</span>
                </button>
                <button
                  type="button"
                  className="doc-btn"
                  data-prompt-history-recall
                  title={t('promptHistory.recallHint')}
                  aria-label={t('promptHistory.recallNamed', {
                    prompt: p.text.replace(/\s+/g, ' ').slice(0, 60),
                  })}
                  onClick={() => props.onRecall(p.recall)}
                  style={{ alignSelf: 'center' }}
                >
                  {t('promptHistory.recall')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {props.truncated && (
        <div
          data-prompt-history-truncated
          style={{
            padding: '6px 10px',
            borderBlockStart: '1px solid var(--border)',
            fontSize: 10.5,
            color: 'var(--muted)',
          }}
        >
          {t('promptHistory.truncated')}
        </div>
      )}
    </div>
  );
}

const emptyStyle: React.CSSProperties = {
  padding: '14px 12px',
  fontSize: 11.5,
  color: 'var(--muted)',
};
