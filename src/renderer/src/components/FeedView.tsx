// Feed view v1 (P2-E12-06, §5.10): the rendered, READ-ONLY view of a session,
// built from transcript-derived blocks. Assistant prose renders as sanitized
// markdown; tool calls are one-line collapsed rows (click to expand); thinking
// is folded; sidechain (subagent) blocks indent behind a dashed border.
// Guardrail (§5.10 Non-Goals): no input surface of any kind lives here.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { blockVisible, FeedBlockDto, Verbosity } from '../lib/feed';
import { uiGet, uiSet } from '../lib/ui-state';

export type { FeedBlockDto } from '../lib/feed';

function Markdown({ text }: { text: string }): React.JSX.Element {
  const html = React.useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text]
  );
  return <div className="feed-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolRow({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
      <div
        onClick={() => b.tool?.detail && setOpen(!open)}
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'baseline',
          cursor: b.tool?.detail ? 'pointer' : 'default',
          color: 'var(--muted)',
          padding: '1px 0',
        }}
      >
        <span style={{ color: 'var(--faint)', fontSize: 8 }}>{open ? '▾' : '▸'}</span>
        <span style={{ color: 'var(--status-working)', fontWeight: 600 }}>{b.tool?.name}</span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minInlineSize: 0,
          }}
        >
          {b.tool?.summary}
        </span>
      </div>
      {open && b.tool?.detail && (
        <pre
          style={{
            margin: '2px 0 4px 14px',
            padding: 6,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 10,
            maxBlockSize: 240,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {b.tool.detail}
        </pre>
      )}
    </div>
  );
}

function ThinkingRow({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ fontSize: 10.5, color: 'var(--faint)', fontStyle: 'italic' }}>
      <span onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}>
        {open ? '▾' : '▸'} {t('feedView.thinking')}
      </span>
      {open && (
        <div style={{ whiteSpace: 'pre-wrap', margin: '2px 0 4px 14px', maxBlockSize: 240, overflow: 'auto' }}>
          {b.text}
        </div>
      )}
    </div>
  );
}

function Block({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const inner =
    b.kind === 'tool' ? (
      <ToolRow b={b} />
    ) : b.kind === 'thinking' ? (
      <ThinkingRow b={b} />
    ) : b.kind === 'user' ? (
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
        <span
          style={{
            fontSize: 8.5,
            fontWeight: 700,
            letterSpacing: 0.5,
            color: 'var(--status-needs-input)',
            textTransform: 'uppercase',
            flexShrink: 0,
          }}
        >
          {t('feedView.you')}
        </span>
        <div style={{ whiteSpace: 'pre-wrap', minInlineSize: 0, color: 'var(--text)' }}>{b.text}</div>
      </div>
    ) : (
      <Markdown text={b.text ?? ''} />
    );
  return (
    <div
      style={{
        padding: '4px 8px',
        ...(b.sidechain
          ? {
              marginInlineStart: 14,
              borderInlineStart: '1px dashed var(--faint)',
              opacity: 0.85,
            }
          : {}),
      }}
    >
      {inner}
    </div>
  );
}

export function FeedView(props: {
  sessionId: string;
  /** durable key for per-card preferences (the live id churns on resume) */
  cardId?: string;
  visible: boolean;
  /** current session status — needs-input/needs-permission shows the chip */
  status?: string;
  /** the Feed never accepts input; this jumps to the Terminal tab (§5.10) */
  onJumpToTerminal?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [blocks, setBlocks] = React.useState<FeedBlockDto[]>([]);
  const [verbosity, setVerbosity] = React.useState<Verbosity>(() => {
    const v = uiGet<string>(`feedVerbosity.${props.cardId ?? ''}`, 'normal');
    return v === 'quiet' || v === 'firehose' ? v : 'normal';
  });
  const pickVerbosity = (v: Verbosity): void => {
    setVerbosity(v);
    if (props.cardId) uiSet(`feedVerbosity.${props.cardId}`, v);
  };
  const bottom = React.useRef<HTMLDivElement | null>(null);
  const pinned = React.useRef(true); // stick to the tail unless the user scrolls up
  const scroller = React.useRef<HTMLDivElement | null>(null);
  const waiting = props.status === 'needs-input' || props.status === 'needs-permission';

  React.useEffect(() => {
    let cancelled = false;
    void window.switchboard.transcripts.blocks(props.sessionId).then((b) => {
      if (!cancelled) setBlocks(b as FeedBlockDto[]);
    });
    const off = window.switchboard.transcripts.onBlock((p) => {
      if (p.sessionId !== props.sessionId) return;
      setBlocks((prev) => {
        const next = [...prev, p.block as FeedBlockDto];
        return next.length > 1000 ? next.slice(-1000) : next;
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [props.sessionId]);

  React.useEffect(() => {
    if (props.visible && pinned.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [blocks, props.visible]);

  const visibleBlocks = blocks.filter((b) => blockVisible(b, verbosity));
  return (
    <div style={{ blockSize: '100%', display: 'flex', flexDirection: 'column', background: 'var(--card-bg)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          paddingInline: 8,
          paddingBlock: 3,
          borderBlockEnd: '1px solid var(--border)',
        }}
      >
        {waiting && (
          <button
            onClick={props.onJumpToTerminal}
            style={{
              background: 'color-mix(in srgb, var(--status-needs-input) 16%, transparent)',
              border: '1px solid var(--status-needs-input)',
              color: 'var(--text)',
              borderRadius: 'var(--radius-chip)',
              fontSize: 10,
              padding: '1px 8px',
              cursor: 'pointer',
              fontFamily: 'var(--font-ui)',
            }}
          >
            {t('feedView.waiting')}
          </button>
        )}
        <span style={{ flex: 1 }} />
        {(['quiet', 'normal', 'firehose'] as const).map((v) => (
          <button
            key={v}
            onClick={() => pickVerbosity(v)}
            style={{
              background: verbosity === v ? 'var(--chip)' : 'transparent',
              border: '1px solid var(--border)',
              color: verbosity === v ? 'var(--text)' : 'var(--faint)',
              borderRadius: 'var(--radius-chip)',
              fontSize: 9.5,
              padding: '0 6px',
              cursor: 'pointer',
              fontFamily: 'var(--font-ui)',
            }}
          >
            {t(`feedView.${v}`)}
          </button>
        ))}
      </div>
      <div
        ref={scroller}
        onScroll={() => {
          const el = scroller.current;
          if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        style={{ flex: 1, minBlockSize: 0, overflowY: 'auto', fontSize: 12, lineHeight: 1.5, paddingBlock: 6 }}
      >
        {visibleBlocks.length === 0 && (
          <div style={{ color: 'var(--faint)', fontSize: 11, textAlign: 'center', marginBlockStart: 24 }}>
            {t('feedView.empty')}
          </div>
        )}
        {visibleBlocks.map((b) => (
          <Block key={b.seq} b={b} />
        ))}
        <div ref={bottom} />
      </div>
      <Composer sessionId={props.sessionId} />
    </div>
  );
}

/**
 * Prompt composer (P2-E10-02, §5.10): an INPUT ROUTE to the real CLI — the
 * text is written to the session's PTY exactly as if typed in the terminal
 * (multiline goes as a bracketed paste so the TUI treats it as one prompt).
 */
function Composer({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = React.useState('');
  const box = React.useRef<HTMLTextAreaElement | null>(null);

  const submit = (): void => {
    const text = draft.replace(/\r\n/g, '\n').trimEnd();
    if (!text) return;
    // multiline goes as one bracketed paste so the TUI treats it as a single
    // prompt; built from char codes -- no control bytes in source
    const ESC = String.fromCharCode(27);
    const CR = String.fromCharCode(13);
    const payload = text.includes(String.fromCharCode(10))
      ? ESC + '[200~' + text + ESC + '[201~' + CR
      : text + CR;
    window.switchboard.pty.input(sessionId, payload);
    setDraft('');
    box.current?.focus();
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 6,
        padding: 8,
        borderBlockStart: '1px solid var(--border)',
        background: 'var(--panel2)',
      }}
    >
      <textarea
        ref={box}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t('feedView.composerPlaceholder')}
        rows={Math.min(6, Math.max(1, draft.split('\n').length))}
        style={{
          flex: 1,
          resize: 'none',
          background: 'var(--panel)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '7px 10px',
          fontSize: 12,
          fontFamily: 'var(--font-ui)',
          lineHeight: 1.45,
          outline: 'none',
        }}
      />
      <button
        onClick={submit}
        disabled={!draft.trim()}
        title={t('feedView.send')}
        style={{
          background: draft.trim() ? 'var(--btn-primary-bg)' : 'var(--chip)',
          color: draft.trim() ? 'var(--btn-primary-text)' : 'var(--faint)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          inlineSize: 30,
          blockSize: 30,
          cursor: draft.trim() ? 'pointer' : 'default',
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        {t('feedView.sendIcon')}
      </button>
    </div>
  );
}
