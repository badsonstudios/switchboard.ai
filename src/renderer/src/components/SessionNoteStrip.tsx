// A session's sticky note, drawn as a strip of paper (#1544, §5.11).
//
// Placement A, "above the prompt": the Session tab puts this between the
// conversation and the composer, where the eye lands on coming back to type.
// It shows the note (click the words to edit, × to delete it for good), or the
// editor when the card's 📝 button or the words were clicked. Nothing here
// talks to the session: the note is the user's label on the card, never part
// of the conversation.
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { NOTE_QUICK_PICK_KEYS, SESSION_NOTE_MAX, type SessionNote } from '../../../shared/session-note';
import { switchWhen } from '../lib/ai-switch-view';
import { cancelEditingNote, deleteNote, saveNote, startEditingNote, useSessionNote } from '../lib/session-notes';

export interface SessionNoteStripProps {
  cardId: string;
  /** the session's AI by name, for an AI-written note's label */
  aiName?: string;
}

/** "You · Today 2:18 PM" / "✦ Claude · 3 Nov 2026, 9:40 AM" */
export function noteMeta(
  note: SessionNote,
  t: (key: string, vars?: Record<string, string>) => string,
  nowMs: number,
  locale?: string,
  aiName?: string
): string {
  const at = Date.parse(note.at);
  const sameDay = new Date(at).toDateString() === new Date(nowMs).toDateString();
  const when = sameDay
    ? t('sessionNote.today', { time: switchWhen(at, nowMs, locale) })
    : switchWhen(at, nowMs, locale);
  const who =
    note.by === 'ai'
      ? aiName
        ? t('sessionNote.byAi', { ai: aiName })
        : t('sessionNote.byAiUnnamed')
      : t('sessionNote.byYou');
  return t('sessionNote.meta', { who, when });
}

/** What a quick pick puts in the box: its words, ready to be continued. */
export function pickText(label: string): string {
  return label.replace(/…$/, ' ');
}

/**
 * Put focus back on this card's 📝 button once the editor or the note is gone,
 * so a keyboard user is not dropped onto the page body. Found in the strip's
 * own document: a popped-out card has its own.
 */
function refocusButton(from: Element | null, cardId: string): void {
  const doc = from?.ownerDocument ?? document;
  requestAnimationFrame(() => {
    const btn = Array.from(doc.querySelectorAll<HTMLElement>('[data-note-button]')).find(
      (b) => b.getAttribute('data-note-button') === cardId
    );
    btn?.focus();
  });
}

export function SessionNoteStrip(props: SessionNoteStripProps): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const { note, editing } = useSessionNote(props.cardId);
  const self = React.useRef<HTMLDivElement>(null);
  if (!note && !editing) return null;
  const ai = note?.by === 'ai';
  return (
    <div
      ref={self}
      role="note"
      aria-label={t('sessionNote.region')}
      data-session-note={props.cardId}
      data-note-by={note?.by ?? ''}
      style={{
        position: 'relative',
        marginInline: 10,
        marginBlock: 6,
        paddingBlock: 7,
        paddingInlineStart: ai ? 12 : 10,
        paddingInlineEnd: 8,
        background: 'var(--note-paper)',
        color: 'var(--note-ink)',
        borderRadius: 3,
        // the paper's folded edge along the bottom, and the AI's blue down the left
        borderBlockEnd: '2px solid var(--note-paper-edge)',
        borderInlineStart: ai ? '3px solid var(--note-ai)' : undefined,
        fontFamily: 'var(--font-ui)',
        fontSize: 12.5,
        flexShrink: 0,
      }}
    >
      {editing ? (
        <NoteEditor
          initial={note?.text ?? ''}
          onSave={(text) => {
            refocusButton(self.current, props.cardId);
            void saveNote(props.cardId, text);
          }}
          onCancel={() => {
            refocusButton(self.current, props.cardId);
            cancelEditingNote(props.cardId);
          }}
        />
      ) : note ? (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <button
            type="button"
            data-note-text=""
            onClick={() => startEditingNote(props.cardId)}
            title={t('sessionNote.editHint')}
            style={{
              flex: 1,
              minInlineSize: 0,
              textAlign: 'start',
              background: 'transparent',
              border: 'none',
              padding: 0,
              color: 'inherit',
              font: 'inherit',
              cursor: 'text',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {/* plain text, always: React escapes it, and nothing here is ever
                read as markdown or HTML (an AI may write this note later) */}
            {note.text}
          </button>
          <span
            data-note-meta=""
            style={{
              fontSize: 10.5,
              whiteSpace: 'nowrap',
              color: ai ? 'var(--note-ai-ink)' : 'var(--note-ink-muted)',
              fontWeight: ai ? 600 : undefined,
              paddingBlockStart: 1,
            }}
          >
            {noteMeta(note, t, Date.now(), i18n.language, props.aiName)}
          </span>
          <button
            type="button"
            data-note-delete=""
            onClick={() => {
              refocusButton(self.current, props.cardId);
              void deleteNote(props.cardId);
            }}
            title={t('sessionNote.delete')}
            aria-label={t('sessionNote.delete')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--note-ink-muted)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: '0 3px',
            }}
          >
            {t('sessionNote.deleteIcon')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NoteEditor(props: {
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = React.useState(props.initial);
  const box = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const pick = (label: string): void => {
    setText(pickText(label));
    // back to the box, caret at the end, so the pick can be finished by typing
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };
  return (
    <div data-note-editor="">
      <textarea
        ref={box}
        data-note-input=""
        rows={2}
        value={text}
        maxLength={SESSION_NOTE_MAX}
        placeholder={t('sessionNote.placeholder')}
        aria-label={t('sessionNote.placeholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // the card listens for keys too (Esc may stop a turn elsewhere):
          // the editor's own keys stop here
          // Shift+Enter too: the note is one line, and a break would be
          // turned into a space on save anyway
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            props.onSave(text);
          } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
          }
        }}
        style={{
          inlineSize: '100%',
          boxSizing: 'border-box',
          resize: 'none',
          border: '1px solid var(--note-ink-muted)',
          background: 'var(--note-paper)',
          color: 'var(--note-ink)',
          font: 'inherit',
          borderRadius: 3,
          padding: '4px 6px',
          outlineColor: 'var(--note-ink)',
        }}
      />
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginBlockStart: 5 }}>
        {NOTE_QUICK_PICK_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            data-note-pick={key}
            onClick={() => pick(t(key))}
            style={{
              background: 'transparent',
              border: '1px solid var(--note-ink-muted)',
              borderRadius: 10,
              padding: '1px 9px',
              fontSize: 11.5,
              color: 'var(--note-ink)',
              cursor: 'pointer',
            }}
          >
            {t(key)}
          </button>
        ))}
        <span style={{ marginInlineStart: 'auto', fontSize: 10.5, color: 'var(--note-ink-muted)' }}>
          {t('sessionNote.hint')}
        </span>
      </div>
    </div>
  );
}
