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
import {
  cancelEditingNote,
  deleteNote,
  saveNote,
  setNotePopoverOpen,
  startEditingNote,
  useNotePlacement,
  useSessionNote,
} from '../lib/session-notes';

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
function refocusButton(from: Element | null, cardId: string, preferChip = false): void {
  const doc = from?.ownerDocument ?? document;
  requestAnimationFrame(() => {
    const find = (attr: string): HTMLElement | undefined =>
      Array.from(doc.querySelectorAll<HTMLElement>(`[${attr}]`)).find((b) => b.getAttribute(attr) === cardId);
    ((preferChip ? find('data-note-chip') : undefined) ?? find('data-note-button'))?.focus();
  });
}

/** How the paper is laid out in each placement. */
type Variant = 'band' | 'line' | 'corner' | 'popover';

const VARIANT_STYLE: Record<Variant, React.CSSProperties> = {
  // A: a band between the conversation and the prompt box
  band: { marginInline: 10, marginBlock: 6, paddingBlock: 7, borderRadius: 3 },
  // B: a full-width strip under the title bar, one line while it is read
  line: { paddingBlock: 5, borderRadius: 0 },
  // C: a small sticky taped over the conversation's top-right corner
  corner: {
    position: 'absolute',
    // below the conversation's own toolbar row (quiet / normal / firehose),
    // which sits at the top right and must stay clickable
    insetBlockStart: 44,
    insetInlineEnd: 16,
    inlineSize: 240,
    maxInlineSize: 'calc(100% - 32px)',
    paddingBlock: 9,
    borderRadius: 2,
    transform: 'rotate(-1.4deg)',
    boxShadow: 'var(--window-shadow)',
    zIndex: 5,
  },
  // D: the chip's popover, under the title bar at the card's right
  popover: {
    position: 'absolute',
    insetBlockStart: 'calc(100% + 4px)',
    insetInlineEnd: 0,
    inlineSize: 300,
    maxInlineSize: '90vw',
    paddingBlock: 9,
    borderRadius: 3,
    boxShadow: 'var(--window-shadow)',
    zIndex: 30,
  },
};

/**
 * The note on its paper: its words (click to edit), who wrote it and when,
 * and ×; or the editor. Every placement draws this; only the paper differs.
 */
function NotePaper(
  props: SessionNoteStripProps & { variant: Variant; onClose?: () => void; maxWidth?: number }
): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const { note, editing } = useSessionNote(props.cardId);
  const self = React.useRef<HTMLDivElement>(null);
  if (!note && !editing) return null;
  const ai = note?.by === 'ai';
  const oneLine = props.variant === 'line';
  // in the tight placements the words go under the byline instead of beside it
  const stacked = props.variant === 'corner' || props.variant === 'popover';
  const done = (): void => {
    refocusButton(self.current, props.cardId, props.variant === 'popover');
    props.onClose?.();
  };
  return (
    <div
      ref={self}
      role="note"
      aria-label={t('sessionNote.region')}
      data-session-note={props.cardId}
      data-note-placement={props.variant}
      data-note-by={note?.by ?? ''}
      onKeyDown={(e) => {
        // a popover that is only being read closes on Esc
        if (e.key === 'Escape' && !editing && props.onClose) {
          e.stopPropagation();
          done();
        }
      }}
      style={{
        position: 'relative',
        paddingInlineStart: ai ? 12 : 10,
        paddingInlineEnd: 8,
        background: 'var(--note-paper)',
        color: 'var(--note-ink)',
        // the paper's folded edge along the bottom, and the AI's blue down the left
        borderBlockEnd: '2px solid var(--note-paper-edge)',
        borderInlineStart: ai ? '3px solid var(--note-ai)' : undefined,
        fontFamily: 'var(--font-ui)',
        fontSize: 12.5,
        flexShrink: 0,
        boxSizing: 'border-box',
        ...VARIANT_STYLE[props.variant],
        ...(props.maxWidth !== undefined ? { maxInlineSize: props.maxWidth } : {}),
      }}
    >
      {editing ? (
        <NoteEditor
          initial={note?.text ?? ''}
          onSave={(text) => {
            done();
            void saveNote(props.cardId, text);
          }}
          onCancel={() => {
            done();
            cancelEditingNote(props.cardId);
          }}
        />
      ) : note ? (
        <div
          style={{
            display: 'flex',
            flexWrap: stacked ? 'wrap' : undefined,
            alignItems: oneLine ? 'center' : 'flex-start',
            gap: stacked ? '4px 8px' : 8,
          }}
        >
          <button
            type="button"
            data-note-text=""
            onClick={() => startEditingNote(props.cardId)}
            // where the line is cut short, the whole note is one hover away
            title={oneLine ? note.text : t('sessionNote.editHint')}
            style={{
              flex: stacked ? '1 1 100%' : 1,
              order: stacked ? 3 : undefined,
              minInlineSize: 0,
              textAlign: 'start',
              background: 'transparent',
              border: 'none',
              padding: 0,
              color: 'inherit',
              font: 'inherit',
              cursor: 'text',
              ...(oneLine
                ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
                : { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }),
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
              flex: stacked ? 1 : undefined,
              color: ai ? 'var(--note-ai-ink)' : 'var(--note-ink-muted)',
              fontWeight: ai ? 600 : undefined,
              paddingBlockStart: oneLine ? 0 : 1,
            }}
          >
            {noteMeta(note, t, Date.now(), i18n.language, props.aiName)}
          </span>
          <button
            type="button"
            data-note-delete=""
            onClick={() => {
              done();
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

/** Placement A: above the prompt box (the Session tab draws this). */
export function SessionNoteStrip(props: SessionNoteStripProps): React.JSX.Element | null {
  return useNotePlacement() === 'prompt' ? <NotePaper {...props} variant="band" /> : null;
}

/** Placement B: a one-line strip under the card's title bar, on every tab. */
export function SessionNoteLine(props: SessionNoteStripProps): React.JSX.Element | null {
  return useNotePlacement() === 'header' ? <NotePaper {...props} variant="line" /> : null;
}

/** Placement C: a sticky over the top-right corner of the conversation. */
export function SessionNoteCorner(props: SessionNoteStripProps): React.JSX.Element | null {
  return useNotePlacement() === 'corner' ? <NotePaper {...props} variant="corner" /> : null;
}

/**
 * Placement D: a chip in the title bar holding the note's words; clicking it
 * opens the note in a popover. The popover also holds the editor, so the 📝
 * button has somewhere to open it. Its parent must be `position: relative`.
 */
export function SessionNoteChip(props: SessionNoteStripProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const placement = useNotePlacement();
  const { note, editing, open } = useSessionNote(props.cardId);
  const box = React.useRef<HTMLSpanElement>(null);
  const showPop = editing || (open && !!note);
  // The popover hangs from the chip's right edge, so it may be no wider than
  // the room between the card's left edge and there; 300px otherwise.
  const [room, setRoom] = React.useState<number | undefined>(undefined);
  React.useLayoutEffect(() => {
    if (!showPop || !box.current) return;
    const header = box.current.closest('[data-testid="card-header"]');
    if (!header) return;
    const right = box.current.getBoundingClientRect().right;
    setRoom(Math.max(160, Math.floor(right - header.getBoundingClientRect().left - 8)));
  }, [showPop]);
  // a click anywhere else closes a popover that is only being read
  React.useEffect(() => {
    if (placement !== 'chip' || !open || editing) return;
    const doc = box.current?.ownerDocument ?? document;
    const away = (e: MouseEvent): void => {
      const target = e.target as { nodeType?: number } | null;
      if (box.current && target && target.nodeType && !box.current.contains(target as Node)) {
        setNotePopoverOpen(props.cardId, false);
      }
    };
    doc.addEventListener('mousedown', away);
    return () => doc.removeEventListener('mousedown', away);
    // `box.current?.ownerDocument` too: a card popped out with its popover open
    // moves to another window's document
  }, [placement, open, editing, props.cardId, box.current?.ownerDocument]);
  if (placement !== 'chip') return null;
  if (!note && !showPop) return null;
  const ai = note?.by === 'ai';
  return (
    <span
      ref={box}
      data-note-chip-box=""
      // Esc closes a popover that is only being read, wherever focus is in it,
      // the chip included
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open && !editing) {
          e.preventDefault();
          e.stopPropagation();
          setNotePopoverOpen(props.cardId, false);
        }
      }}
      style={{ position: 'relative', display: 'flex', minInlineSize: 0, flex: '0 1 auto' }}
    >
      {note && (
        <button
          type="button"
          data-note-chip={props.cardId}
          data-no-maximize
          aria-expanded={showPop}
          aria-haspopup="dialog"
          onClick={() => setNotePopoverOpen(props.cardId, !open)}
          title={note.text}
          aria-label={t('sessionNote.chipLabel', { note: note.text })}
          style={{
            display: 'inline-block',
            flex: '0 1 auto',
            minInlineSize: 0,
            maxInlineSize: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            background: 'var(--note-paper)',
            color: 'var(--note-ink)',
            border: 'none',
            borderInlineStart: ai ? '3px solid var(--note-ai)' : undefined,
            borderRadius: 3,
            padding: '1px 8px',
            fontSize: 11.5,
            fontFamily: 'var(--font-ui)',
            cursor: 'pointer',
          }}
        >
          {note.text}
        </button>
      )}
      {showPop && (
        <NotePaper
          {...props}
          variant="popover"
          maxWidth={room}
          onClose={() => setNotePopoverOpen(props.cardId, false)}
        />
      )}
    </span>
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
