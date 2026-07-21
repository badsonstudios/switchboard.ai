// Feed view v1 (P2-E12-06, §5.10): the rendered, READ-ONLY view of a session,
// built from transcript-derived blocks. Assistant prose renders as sanitized
// markdown; tool calls are one-line collapsed rows (click to expand); thinking
// is folded; sidechain (subagent) blocks indent behind a dashed border.
// Guardrail (§5.10 Non-Goals): no input surface of any kind lives here.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export interface FeedBlockDto {
  seq: number;
  kind: 'user' | 'assistant' | 'thinking' | 'tool';
  text?: string;
  tool?: { name: string; summary: string; detail?: string };
  sidechain: boolean;
  ts?: string;
}

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

export function FeedView(props: { sessionId: string; visible: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const [blocks, setBlocks] = React.useState<FeedBlockDto[]>([]);
  const bottom = React.useRef<HTMLDivElement | null>(null);
  const pinned = React.useRef(true); // stick to the tail unless the user scrolls up
  const scroller = React.useRef<HTMLDivElement | null>(null);

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

  return (
    <div
      ref={scroller}
      onScroll={() => {
        const el = scroller.current;
        if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      style={{
        blockSize: '100%',
        overflowY: 'auto',
        background: 'var(--card-bg)',
        fontSize: 12,
        lineHeight: 1.5,
        paddingBlock: 6,
      }}
    >
      {blocks.length === 0 && (
        <div style={{ color: 'var(--faint)', fontSize: 11, textAlign: 'center', marginBlockStart: 24 }}>
          {t('feedView.empty')}
        </div>
      )}
      {blocks.map((b) => (
        <Block key={b.seq} b={b} />
      ))}
      <div ref={bottom} />
    </div>
  );
}
