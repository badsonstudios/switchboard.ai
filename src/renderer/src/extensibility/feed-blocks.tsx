// Feed block renderers as CONTRIBUTIONS (P2-E15-03, §5.10 + §5.23).
//
// These components used to live in FeedView.tsx behind a seven-branch ternary.
// They are unchanged; what changed is how FeedView finds them — it resolves
// `feed-block-renderer` contributions and takes the first whose `matches()`
// returns true. Adding a renderer now means adding it here (or in any other
// module) and registering it; FeedView is never edited again.
//
// ORDER IS LOAD-BEARING and mirrors the old chain exactly: bash, edit and the
// generic tool row all match `kind === 'tool'`, so the more specific ones must
// sort first, and the markdown fallback — which matches everything — sorts
// last.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { FeedBlockDto } from '../lib/feed';
import { FeedBlockRendererContribution, manifestFor } from './contributions';

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

const manifest = (id: string, displayName: string) => manifestFor(id, displayName, 'feed.render');

/** One contribution per block shape, in the order the old chain tested them. */
export const feedBlockRenderers: FeedBlockRendererContribution[] = [
  {
    manifest: manifest('feed-block-todos', 'Todo list block'),
    order: 10,
    matches: (b) => b.kind === 'todos',
    render: (b) => <TodosBlock b={b} />,
  },
  {
    manifest: manifest('feed-block-bash', 'Shell command block'),
    order: 20,
    matches: (b) => b.kind === 'tool' && b.tool?.category === 'shell',
    render: (b) => <BashBlock b={b} />,
  },
  {
    manifest: manifest('feed-block-edit', 'File edit block'),
    order: 30,
    matches: (b) =>
      b.kind === 'tool' && (b.tool?.oldString !== undefined || b.tool?.newString !== undefined),
    render: (b) => <EditBlock b={b} />,
  },
  {
    manifest: manifest('feed-block-tool', 'Generic tool row'),
    order: 40,
    matches: (b) => b.kind === 'tool',
    render: (b) => <ToolRow b={b} />,
  },
  {
    manifest: manifest('feed-block-thinking', 'Thinking block'),
    order: 50,
    matches: (b) => b.kind === 'thinking',
    render: (b) => <ThinkingRow b={b} />,
  },
  {
    manifest: manifest('feed-block-user', 'User prompt pill'),
    order: 60,
    matches: (b) => b.kind === 'user',
    render: (b) => <UserPill text={b.text ?? ''} />,
  },
  {
    // matches everything — MUST sort last, or it shadows the whole list
    manifest: manifest('feed-block-markdown', 'Assistant prose (fallback)'),
    order: 1_000,
    matches: () => true,
    render: (b) => <Markdown text={b.text ?? ''} />,
  },
];

