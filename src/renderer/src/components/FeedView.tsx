// Feed view v1 (P2-E12-06, §5.10): the rendered, READ-ONLY view of a session,
// built from transcript-derived blocks. Assistant prose renders as sanitized
// markdown; tool calls are one-line collapsed rows (click to expand); thinking
// is folded; sidechain (subagent) blocks indent behind a dashed border.
// Guardrail (§5.10 Non-Goals): no input surface of any kind lives here.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { blockVisible, FeedBlockDto, upsertBlock, Verbosity } from '../lib/feed';
import { uiGet, uiSet } from '../lib/ui-state';

export type { FeedBlockDto } from '../lib/feed';

function Markdown({ text }: { text: string }): React.JSX.Element {
  const html = React.useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text]
  );
  return <div className="feed-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Edit/Write block (E10-06): header + added/removed subtitle + shaded panes. */
function EditBlock({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(true);
  const added = (b.tool?.newString ?? '').split('\n').filter((l) => l.length > 0).length;
  const removed = (b.tool?.oldString ?? '').split('\n').filter((l) => l.length > 0).length;
  return (
    <div style={{ fontSize: 11 }}>
      <div onClick={() => setOpen(!open)} style={{ cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'baseline' }}>
        <span style={{ fontWeight: 700, color: 'var(--text)' }}>{b.tool?.name}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minInlineSize: 0 }}>
          {b.tool?.filePath ?? b.tool?.summary}
        </span>
      </div>
      <div style={{ fontSize: 9.5, color: 'var(--faint)', marginBlock: 2 }}>
        {t('feedView.editStats', { added, removed })}
      </div>
      {open && (
        <div style={{ display: 'flex', gap: 4, maxBlockSize: 180, overflow: 'auto' }}>
          {b.tool?.oldString && <pre style={editPane('var(--diff-removed-bg)')}>{b.tool.oldString}</pre>}
          {b.tool?.newString && <pre style={editPane('var(--diff-added-bg)')}>{b.tool.newString}</pre>}
        </div>
      )}
    </div>
  );
}

function editPane(background: string): React.CSSProperties {
  return {
    flex: 1,
    margin: 0,
    padding: 6,
    background,
    border: '1px solid var(--border)',
    borderRadius: 4,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    minInlineSize: 0,
  };
}

/** Bash block (E10-06): description header + independent IN/OUT sections. */
function BashBlock({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const [inOpen, setInOpen] = React.useState(false);
  const [outOpen, setOutOpen] = React.useState(false);
  const section = (
    label: string,
    text: string,
    open: boolean,
    toggle: () => void
  ): React.JSX.Element => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minInlineSize: 0 }}>
      <span
        onClick={toggle}
        style={{ fontSize: 8.5, fontWeight: 700, color: 'var(--faint)', cursor: 'pointer', flexShrink: 0, inlineSize: 26 }}
      >
        {open ? '▾' : '▸'} {label}
      </span>
      <pre
        onClick={toggle}
        style={{
          margin: 0,
          flex: 1,
          minInlineSize: 0,
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          color: 'var(--muted)',
          cursor: 'pointer',
          ...(open
            ? { whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxBlockSize: 200, overflow: 'auto', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 4, padding: 6 }
            : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }),
        }}
      >
        {open ? text : text.split(String.fromCharCode(10))[0]}
      </pre>
    </div>
  );
  return (
    <div style={{ fontSize: 11 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBlockEnd: 2 }}>
        <span style={{ fontWeight: 700, color: 'var(--text)' }}>{b.tool?.name}</span>
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{b.tool?.description ?? ''}</span>
      </div>
      {section(t('feedView.in'), b.tool?.summary ?? '', inOpen, () => setInOpen(!inOpen))}
      {b.tool?.out !== undefined &&
        section(t('feedView.out'), b.tool.out, outOpen, () => setOutOpen(!outOpen))}
    </div>
  );
}

/** TodoWrite checklist block (E10-06). */
function TodosBlock({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div style={{ fontSize: 11 }}>
      <div style={{ fontWeight: 700, color: 'var(--text)', marginBlockEnd: 2 }}>{t('feedView.updateTodos')}</div>
      {(b.todos ?? []).map((td, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline', color: 'var(--muted)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, flexShrink: 0, color: td.status === 'completed' ? 'var(--status-done)' : td.status === 'in_progress' ? 'var(--status-working)' : 'var(--faint)' }}>
            {td.status === 'completed' ? t('feedView.todoDone') : td.status === 'in_progress' ? t('feedView.todoActive') : t('feedView.todoPending')}
          </span>
          <span style={{ minInlineSize: 0, textDecoration: td.status === 'completed' ? 'line-through' : 'none' }}>
            {td.content}
          </span>
        </div>
      ))}
    </div>
  );
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
  const label = b.durationMs
    ? t('feedView.thoughtFor', { s: Math.max(1, Math.round(b.durationMs / 1000)) })
    : t('feedView.thinking');
  return (
    <div style={{ fontSize: 10.5, color: 'var(--faint)', fontStyle: 'italic' }}>
      <span onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}>
        {open ? '▾' : '▸'} {label}
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
  const inner =
    b.kind === 'todos' ? (
      <TodosBlock b={b} />
    ) : b.kind === 'tool' && b.tool?.name === 'Bash' ? (
      <BashBlock b={b} />
    ) : b.kind === 'tool' && (b.tool?.oldString !== undefined || b.tool?.newString !== undefined) ? (
      <EditBlock b={b} />
    ) : b.kind === 'tool' ? (
      <ToolRow b={b} />
    ) : b.kind === 'thinking' ? (
      <ThinkingRow b={b} />
    ) : b.kind === 'user' ? (
      <UserPill text={b.text ?? ''} />
    ) : (
      <Markdown text={b.text ?? ''} />
    );
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
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
      {/* timeline dot gutter (E10-06, extension reference) */}
      <span
        style={{
          inlineSize: 6,
          blockSize: 6,
          borderRadius: '50%',
          background: b.kind === 'user' ? 'var(--status-needs-input)' : 'var(--faint)',
          flexShrink: 0,
          marginBlockStart: 5,
        }}
      />
      <div style={{ flex: 1, minInlineSize: 0 }}>{inner}</div>
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
  /** composer options row data (E10-05) */
  autonomy?: string;
  model?: string;
  onCycleAutonomy?: () => void;
  /** held permission (E10-04) — the bar renders just above the composer */
  approval?: { requestId: string; tool: string; input: Record<string, unknown> } | null;
  onDecide?: (decision: 'allow' | 'deny', allowAll?: boolean) => void;
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
  // chip = raw TUI states only: needs-input, or a permission the inline bar
  // is NOT handling (fail-open path where the CLI shows its own prompt)
  const waiting =
    props.status === 'needs-input' || (props.status === 'needs-permission' && !props.approval);

  React.useEffect(() => {
    let cancelled = false;
    void window.switchboard.transcripts.blocks(props.sessionId).then((b) => {
      if (!cancelled) setBlocks(b as FeedBlockDto[]);
    });
    const off = window.switchboard.transcripts.onBlock((p) => {
      if (p.sessionId !== props.sessionId) return;
      // upsert: the watcher re-emits a block when its OUT / duration lands
      setBlocks((prev) => upsertBlock(prev, p.block as FeedBlockDto));
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
            title={t(`feedView.${v}Hint`)}
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
        {visibleBlocks.map((b, i) => (
          <React.Fragment key={b.seq}>
            {/* a new prompt starts a new turn — rule it off (Dan #11) */}
            {b.kind === 'user' && i > 0 && (
              <div style={{ borderBlockStart: '1px solid var(--border)', marginBlock: 8, marginInline: 8 }} />
            )}
            <Block b={b} />
          </React.Fragment>
        ))}
        <div ref={bottom} />
      </div>
      {/* prominent working indicator above the composer (Dan #6) */}
      {!props.approval && props.status === 'working' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingInline: 10,
            paddingBlock: 5,
            borderBlockStart: '1px solid var(--border)',
            background: 'color-mix(in srgb, var(--status-working) 7%, var(--panel2))',
            fontSize: 11.5,
            color: 'var(--status-working)',
            fontWeight: 600,
          }}
        >
          <span
            style={{
              inlineSize: 9,
              blockSize: 9,
              borderRadius: '50%',
              background: 'var(--status-working)',
              animation: 'sb-pulse 1.2s ease-in-out infinite',
            }}
          />
          {t('feedView.workingStrip')}
        </div>
      )}
      {props.approval && props.onDecide && (
        <ApprovalBar approval={props.approval} onDecide={props.onDecide} />
      )}
      <Composer
        sessionId={props.sessionId}
        autonomy={props.autonomy}
        model={props.model}
        status={props.status}
        onCycleAutonomy={props.onCycleAutonomy}
      />
    </div>
  );
}

/**
 * The user's prompt in a tinted pill (Dan #2). Long payloads — skill
 * invocations dump the whole skill body as a user message — collapse to a
 * header line with click-to-expand, like tool blocks (Dan #7).
 */
function UserPill({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  // a skill / slash-command invocation carries a command-name tag
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text)?.[1];
  const long = text.length > 500;
  const collapsed = (cmd || long) && !open;
  const label = cmd ?? `${text.slice(0, 160).split(String.fromCharCode(10))[0]}…`;
  return (
    <div
      onClick={collapsed || open ? () => setOpen(!open) : undefined}
      style={{
        background: 'color-mix(in srgb, var(--status-needs-input) 10%, var(--panel2))',
        border: '1px solid color-mix(in srgb, var(--status-needs-input) 28%, transparent)',
        borderRadius: 10,
        padding: '6px 10px',
        whiteSpace: 'pre-wrap',
        color: 'var(--text)',
        overflowWrap: 'break-word',
        cursor: cmd || long ? 'pointer' : 'default',
      }}
    >
      {collapsed ? (
        <span style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
          <span style={{ fontSize: 8, color: 'var(--faint)' }}>{t('feedView.collapsedIcon')}</span>
          <span style={{ fontFamily: cmd ? 'var(--font-mono)' : 'var(--font-ui)', fontWeight: cmd ? 700 : 400 }}>
            {label}
          </span>
          <span style={{ fontSize: 9.5, color: 'var(--faint)' }}>{t('feedView.expandHint')}</span>
        </span>
      ) : (
        text
      )}
    </div>
  );
}

/**
 * Inline approval bar (E10-04) — docked just above the composer (Dan's
 * 2026-07-22 feedback: it lives where the eyes already are, not at the top).
 */
function ApprovalBar({
  approval,
  onDecide,
}: {
  approval: { requestId: string; tool: string; input: Record<string, unknown> };
  onDecide: (decision: 'allow' | 'deny', allowAll?: boolean) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const btn = (primary: boolean): React.CSSProperties => ({
    background: primary ? 'var(--btn-primary-bg)' : 'var(--panel)',
    color: primary ? 'var(--btn-primary-text)' : 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    padding: '4px 14px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    fontSize: 12,
  });
  const pane = (background: string): React.CSSProperties => ({
    flex: 1,
    margin: 0,
    padding: 6,
    background,
    border: '1px solid var(--border)',
    borderRadius: 4,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    minInlineSize: 0,
  });
  return (
    <div
      style={{
        borderBlockStart: '2px solid var(--status-needs-permission)',
        background: 'color-mix(in srgb, var(--status-needs-permission) 8%, var(--panel2))',
        padding: '8px 10px',
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBlockEnd: 6 }}>
        <span style={{ fontWeight: 700, color: 'var(--status-needs-permission)' }}>
          {t('approval.title', { tool: approval.tool })}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minInlineSize: 0,
            flex: 1,
          }}
        >
          {String(approval.input.file_path ?? approval.input.command ?? approval.input.url ?? '')}
        </span>
      </div>
      {typeof approval.input.old_string === 'string' && typeof approval.input.new_string === 'string' && (
        <div style={{ display: 'flex', gap: 6, marginBlockEnd: 6, maxBlockSize: 120, overflow: 'auto' }}>
          <pre style={pane('var(--diff-removed-bg)')}>{approval.input.old_string.slice(0, 1500)}</pre>
          <pre style={pane('var(--diff-added-bg)')}>{approval.input.new_string.slice(0, 1500)}</pre>
        </div>
      )}
      {typeof approval.input.command === 'string' && (
        <pre
          style={{
            margin: '0 0 6px',
            padding: 6,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 10.5,
            maxBlockSize: 90,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {approval.input.command.slice(0, 1500)}
        </pre>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => onDecide('allow')} style={btn(true)}>
          {t('approval.allow')}
        </button>
        <button onClick={() => onDecide('allow', true)} style={btn(false)}>
          {t('approval.allowAll')}
        </button>
        <button onClick={() => onDecide('deny')} style={btn(false)}>
          {t('approval.deny')}
        </button>
      </div>
    </div>
  );
}

/**
 * Prompt composer (P2-E10-02, §5.10): an INPUT ROUTE to the real CLI — the
 * text is written to the session's PTY exactly as if typed in the terminal
 * (multiline goes as a bracketed paste so the TUI treats it as one prompt).
 */
function Composer({
  sessionId,
  autonomy,
  model,
  status,
  onCycleAutonomy,
}: {
  sessionId: string;
  autonomy?: string;
  model?: string;
  status?: string;
  onCycleAutonomy?: () => void;
}): React.JSX.Element {
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
        flexDirection: 'column',
        gap: 5,
        padding: 8,
        borderBlockStart: '1px solid var(--border)',
        background: 'var(--panel2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
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
      {/* options row (E10-05): the extension-style affordances under the box */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={onCycleAutonomy}
          title={t('feedView.autonomyHint')}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-chip)',
            color: autonomy === 'full-auto' ? 'var(--status-crashed)' : 'var(--muted)',
            fontSize: 10,
            fontFamily: 'var(--font-ui)',
            padding: '1px 8px',
            cursor: 'pointer',
          }}
        >
          {t(`autonomy.${autonomy ?? 'ask'}`)}
        </button>
        {model && (
          <span
            title={t('feedView.modelHint')}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9.5,
              color: 'var(--faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minInlineSize: 0,
            }}
          >
            {model}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {status === 'working' && (
          <span
            title={t('status.working')}
            style={{
              inlineSize: 7,
              blockSize: 7,
              borderRadius: '50%',
              background: 'var(--status-working)',
              animation: 'sb-pulse 1.2s ease-in-out infinite',
            }}
          />
        )}
      </div>
    </div>
  );
}
