// The list of prompts you sent in this conversation (#1203). See
// `lib/prompt-history` for what it is and is not.
//
// IT IS A TAB OF THE HISTORY WINDOW (#1237), beside the list of previous
// conversations. It first shipped as a panel dropped from its own small
// "prompts" button in the conversation's toolbar, and the owner, the day he
// installed it: "I don't see any icon for that." One history button, two
// kinds of history behind it. So this is the list alone; the window around
// it, its Escape and its focus belong to `SessionHistoryDialog`.
//
// EACH ROW IS TWO BUTTONS, side by side, never one inside the other: the prompt
// itself (go to where it is in the conversation) and "Use again" (put its text
// back in the prompt box). A button inside a button is not a thing a keyboard
// or a screen reader can use.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { filterPrompts, promptAge, type PromptEntry } from '../lib/prompt-history';

export function PromptList(props: {
  prompts: readonly PromptEntry[];
  /** the view's buffer is full: older prompts than these exist and are not listed */
  truncated: boolean;
  /**
   * This session has no conversation view to list from (it is showing
   * something else). Said, rather than shown as "you have sent nothing".
   */
  unavailable?: boolean;
  onJump: (seq: number) => void;
  onRecall: (text: string) => void;
  /** the filter box, so the window can put the keyboard in it */
  inputRef?: React.Ref<HTMLInputElement>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState('');

  const shown = filterPrompts(props.prompts, query);
  const now = Date.now();
  const age = (p: PromptEntry): string => {
    const a = promptAge(p.ts, now);
    if (!a) return '';
    return a.unit === 'now' ? t('promptHistory.age.now') : t(`promptHistory.age.${a.unit}`, { count: a.count });
  };

  return (
    <div
      data-prompt-history
      style={{ display: 'flex', flexDirection: 'column', minBlockSize: 0, flex: 1, color: 'var(--text)' }}
    >
      <div style={{ padding: '8px 10px', borderBlockEnd: '1px solid var(--border)' }}>
        <input
          ref={props.inputRef}
          type="text"
          value={query}
          disabled={props.unavailable}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('promptHistory.filter')}
          aria-label={t('promptHistory.filter')}
          data-prompt-history-filter
          className="prompt-history-filter"
        />
      </div>
      <div style={{ overflowY: 'auto', minBlockSize: 0, flex: 1, padding: '4px 0' }}>
        {props.unavailable ? (
          <div data-prompt-history-empty style={emptyStyle}>
            {t('promptHistory.unavailable')}
          </div>
        ) : props.prompts.length === 0 ? (
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
      {props.truncated && !props.unavailable && (
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
