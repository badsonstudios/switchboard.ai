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
import { FEED_EXPANDER_ATTR } from '../lib/feed-keys';
import { FeedBlockRendererContribution, manifestFor } from './contributions';

/** The "still typing" cue. A glyph, not copy — nothing here to translate. */
const STREAMING_CARET = '▌';

/**
 * Marks a subtree that owns its own clicks (#91). `ToolBox` walks up from the
 * click target and stands down if it finds this, so an inner expander, a copy
 * button or a scrollable pane can never also flip the whole box.
 *
 * An attribute rather than `stopPropagation()` on every inner handler: the rule
 * then lives in ONE place and reads off the markup, instead of being a property
 * of each handler that the next renderer has to remember to repeat.
 */
const NO_TOGGLE = { 'data-no-toggle': '' };

/**
 * The one shape every expander in the feed takes (#174, §5.26).
 *
 * A REAL `<button aria-expanded>`, because that is the only honest answer for
 * "this control shows and hides that content": screen readers announce its
 * state, and Enter and Space come free from the platform. The boxes themselves
 * stay plain containers — a `role="button"` on a box that CONTAINS the Bash
 * IN/OUT buttons would be an ARIA lie, and that lie is what #174 was filed over.
 *
 * Two details carry weight:
 *
 *  - `tabIndex={-1}`: the conversation is ONE tab stop (FeedView's region) and
 *    the arrow keys move between expanders inside it. A tab stop each would put
 *    hundreds of presses between the user and the composer below. Screen-reader
 *    button quick-nav is unaffected — tabindex does not touch the a11y tree.
 *  - `data-no-toggle`: the button sits inside `ToolBox`, whose whole body is
 *    also a mouse expand target. Without this the click would toggle twice and
 *    cancel out.
 */
export function FeedExpander({
  open,
  onToggle,
  controls,
  style,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** id(s) of the element(s) this shows and hides; omit while none is rendered */
  controls?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      {...{ [FEED_EXPANDER_ATTR]: '' }}
      {...NO_TOGGLE}
      aria-expanded={open}
      // Undefined while the content is not in the document — an aria-controls
      // pointing at an id that does not exist sends a screen reader somewhere
      // there is nothing, which is worse than saying nothing at all. The caller
      // decides, because only it knows whether its region renders when shut.
      aria-controls={controls}
      tabIndex={-1}
      onClick={onToggle}
      style={{
        // an unstyled button brings a whole OS look with it; this is a header
        // line that happens to be operable, so it inherits everything
        background: 'transparent',
        border: 'none',
        padding: 0,
        margin: 0,
        color: 'inherit',
        font: 'inherit',
        textAlign: 'start',
        cursor: 'pointer',
        minInlineSize: 0,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/**
 * The container a tool block lives in (#91, §5.10).
 *
 * Dan, 2026-07-26: a tool block was a dot plus some text, and "I'd like them
 * enclosed in some sort of rectangular box to make them easy to see. That box,
 * of course, is clickable so I can expand". So: a bordered, rounded surface
 * that reads as one object in the conversation, and the WHOLE box is the
 * expand target — not just the header line it used to be.
 *
 * `--panel2` on the feed's `--panel` background: a half-step lift that carries
 * in both shipped themes (nordic #333a48 on #2b313d, daylight #f4f6f9 on white)
 * with `--border` drawing the edge in either.
 *
 * EXPORTED because renderers are contributions and may live in any module
 * (§5.23): a new tool renderer adopts the shipped container by wrapping in this
 * rather than by re-deriving a border that drifts from everyone else's.
 *
 * The box stays a plain `div` with a click handler, and that is deliberate
 * (#174): it is a MOUSE convenience that duplicates the block's header
 * `FeedExpander`, not a control in its own right. A box carrying `role="button"`
 * while containing the Bash IN/OUT buttons would be invalid ARIA — so a renderer
 * that wraps in this MUST also give its block a `FeedExpander`, or it ships with
 * no keyboard path at all.
 */
export function ToolBox({
  kind,
  onToggle,
  children,
}: {
  /** which renderer owns it — a test/debug hook, and the styling never varies */
  kind: 'bash' | 'edit' | 'tool' | 'todos' | (string & {});
  /** omitted when the block has nothing to expand (Todos): box, no toggle */
  onToggle?: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const click = onToggle
    ? (e: React.MouseEvent<HTMLDivElement>): void => {
        const target = e.target as Element | null;
        if (target?.closest?.('[data-no-toggle]')) return;
        // A drag that ended in a selection was a READ, not a click. Without
        // this, selecting a file path out of a block collapses it on mouse-up
        // and takes the thing you were reading off the screen.
        const sel = e.currentTarget.ownerDocument.defaultView?.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim() !== '') return;
        onToggle();
      }
    : undefined;
  return (
    <div
      data-feed-box={kind}
      onClick={click}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--panel2)',
        padding: '5px 8px',
        minInlineSize: 0,
        cursor: onToggle ? 'pointer' : 'default',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Assistant prose. While it is STILL ARRIVING (P2-E18-10) it renders as plain
 * text with a caret on the end, and only becomes markdown once it is complete.
 *
 * Two reasons, and both matter:
 *
 *  - Half a document is not a document. A code fence, list or table that is
 *    mid-write parses as something else entirely, so a streamed reply would
 *    reflow and re-style itself on almost every token.
 *  - Cost. `useMemo` is keyed on the text, so parsing per token means parsing
 *    the WHOLE reply once per token — quadratic in the length of the answer, on
 *    the renderer thread, times every session streaming at once.
 */
function Markdown({ text, streaming }: { text: string; streaming?: boolean }): React.JSX.Element {
  const html = React.useMemo(
    () => (streaming ? '' : DOMPurify.sanitize(marked.parse(text, { async: false }) as string)),
    [text, streaming]
  );
  if (streaming) {
    return (
      <div className="feed-md" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
        {text}
        <span style={{ color: 'var(--status-working)', opacity: 0.8 }}>{STREAMING_CARET}</span>
      </div>
    );
  }
  return <div className="feed-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Edit/Write block (E10-06): header + added/removed subtitle + shaded panes. */
function EditBlock({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(true);
  const diffId = React.useId();
  const added = (b.tool?.newString ?? '').split('\n').filter((l) => l.length > 0).length;
  const removed = (b.tool?.oldString ?? '').split('\n').filter((l) => l.length > 0).length;
  const toggle = (): void => setOpen(!open);
  return (
    // Both the box and the header toggle, and that is not the double-toggle
    // #91 removed: the header is a `FeedExpander`, which is marked
    // `data-no-toggle`, so the box stands down for a click that lands on it.
    <ToolBox kind="edit" onToggle={toggle}>
      <div style={{ fontSize: 11 }}>
        {/* the header IS the keyboard expander (#174): a real button whose
            accessible name is already the thing you'd read out — "Edit
            src/foo.ts" — so it needs no label of its own */}
        <FeedExpander
          open={open}
          onToggle={toggle}
          controls={open ? diffId : undefined}
          style={{ display: 'flex', gap: 6, alignItems: 'baseline', inlineSize: '100%' }}
        >
          <span style={{ fontWeight: 700, color: 'var(--text)' }}>{b.tool?.name}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minInlineSize: 0 }}>
            {b.tool?.filePath ?? b.tool?.summary}
          </span>
        </FeedExpander>
        <div style={{ fontSize: 9.5, color: 'var(--faint)', marginBlock: 2 }}>
          {t('feedView.editStats', { added, removed })}
        </div>
        {open && (
          // the diff is for READING: scrolling it and selecting out of it must
          // not fold the block away underneath the pointer
          <div id={diffId} {...NO_TOGGLE} style={{ display: 'flex', gap: 4, maxBlockSize: 180, overflow: 'auto' }}>
            {b.tool?.oldString && <pre style={editPane('var(--diff-removed-bg)')}>{b.tool.oldString}</pre>}
            {b.tool?.newString && <pre style={editPane('var(--diff-added-bg)')}>{b.tool.newString}</pre>}
          </div>
        )}
      </div>
    </ToolBox>
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
  const ids = React.useId();
  const inId = `${ids}in`;
  const outId = `${ids}out`;
  const section = (
    id: string,
    label: string,
    text: string,
    open: boolean,
    toggle: () => void
  ): React.JSX.Element => (
    // IN and OUT stay INDEPENDENTLY expandable inside the box (#91) — so the
    // section owns its clicks and the box stands down for them
    <div {...NO_TOGGLE} style={{ display: 'flex', gap: 6, alignItems: 'baseline', minInlineSize: 0 }}>
      <FeedExpander
        open={open}
        onToggle={toggle}
        // the <pre> is always rendered — collapsed it shows the first line —
        // so the controlled element exists in both states
        controls={id}
        style={{ fontSize: 8.5, fontWeight: 700, color: 'var(--faint)', flexShrink: 0, inlineSize: 26 }}
      >
        {open ? '▾' : '▸'} {label}
      </FeedExpander>
      <pre
        id={id}
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
  // The box's own toggle (#91) is the COARSE one: Dan's ask was "click the box
  // and see what the bash command is", so it opens both sections at once and a
  // second click puts them both away. The per-section chevrons are still there
  // for the finer moves.
  const anyOpen = inOpen || outOpen;
  const toggleAll = (): void => {
    setInOpen(!anyOpen);
    setOutOpen(!anyOpen);
  };
  const hasOut = b.tool?.out !== undefined;
  return (
    <ToolBox kind="bash" onToggle={toggleAll}>
      <div style={{ fontSize: 11 }}>
        {/* the COARSE expander (#174): same job the box body does for the
            mouse, so it reports the same coarse state — open if either
            section is, and it controls both */}
        <FeedExpander
          open={anyOpen}
          onToggle={toggleAll}
          controls={hasOut ? `${inId} ${outId}` : inId}
          style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBlockEnd: 2, inlineSize: '100%' }}
        >
          <span style={{ fontWeight: 700, color: 'var(--text)' }}>{b.tool?.name}</span>
          <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{b.tool?.description ?? ''}</span>
        </FeedExpander>
        {section(inId, t('feedView.in'), b.tool?.summary ?? '', inOpen, () => setInOpen(!inOpen))}
        {hasOut &&
          section(outId, t('feedView.out'), b.tool?.out ?? '', outOpen, () => setOutOpen(!outOpen))}
      </div>
    </ToolBox>
  );
}

/** TodoWrite checklist block (E10-06). */
function TodosBlock({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    // Boxed like every other tool block, but with NO toggle: a checklist is
    // already shown in full, so there is no expansion to offer and a pointer
    // cursor promising one would be a lie.
    <ToolBox kind="todos">
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
    </ToolBox>
  );
}

function ToolRow({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const detailId = React.useId();
  const expandable = !!b.tool?.detail;
  const toggle = (): void => setOpen(!open);
  const headerStyle: React.CSSProperties = {
    display: 'flex',
    gap: 6,
    alignItems: 'baseline',
    color: 'var(--muted)',
    padding: '1px 0',
    inlineSize: '100%',
  };
  const header = (
    <>
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
    </>
  );
  return (
    <ToolBox kind="tool" onToggle={expandable ? toggle : undefined}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>
        {/* a row with nothing to show stays a plain row: a button that toggles
            nothing would be as much of a lie as the pointer cursor is (#91) */}
        {expandable ? (
          <FeedExpander
            open={open}
            onToggle={toggle}
            controls={open ? detailId : undefined}
            style={headerStyle}
          >
            {header}
          </FeedExpander>
        ) : (
          <div style={headerStyle}>{header}</div>
        )}
        {open && b.tool?.detail && (
          <pre
            id={detailId}
            {...NO_TOGGLE}
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
    </ToolBox>
  );
}

function ThinkingRow({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const textId = React.useId();
  const label = b.durationMs
    ? t('feedView.thoughtFor', { s: Math.max(1, Math.round(b.durationMs / 1000)) })
    : t('feedView.thinking');
  return (
    <div style={{ fontSize: 10.5, color: 'var(--faint)', fontStyle: 'italic' }}>
      <FeedExpander open={open} onToggle={() => setOpen(!open)} controls={open ? textId : undefined}>
        {open ? '▾' : '▸'} {label}
      </FeedExpander>
      {open && (
        <div id={textId} style={{ whiteSpace: 'pre-wrap', margin: '2px 0 4px 14px', maxBlockSize: 240, overflow: 'auto' }}>
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
  const bodyId = React.useId();
  // a skill / slash-command invocation carries a command-name tag
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text)?.[1];
  const long = text.length > 500;
  const expandable = !!(cmd || long);
  const label = cmd ?? `${text.slice(0, 160).split(String.fromCharCode(10))[0]}…`;
  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--status-needs-input) 10%, var(--panel2))',
        border: '1px solid color-mix(in srgb, var(--status-needs-input) 28%, transparent)',
        borderRadius: 10,
        padding: '6px 10px',
        whiteSpace: 'pre-wrap',
        color: 'var(--text)',
        overflowWrap: 'break-word',
      }}
    >
      {/* The header line is the ONLY expand target now (#174). It used to be
          the whole pill, in both states — which meant an expanded prompt
          collapsed under the pointer the moment you tried to select a line out
          of it, the same read-not-a-click bug the tool boxes already guard. */}
      {expandable && (
        <FeedExpander
          open={open}
          onToggle={() => setOpen(!open)}
          controls={open ? bodyId : undefined}
          style={{ display: 'flex', gap: 6, alignItems: 'baseline', inlineSize: '100%' }}
        >
          <span style={{ fontSize: 8, color: 'var(--faint)' }}>
            {open ? t('feedView.expandedIcon') : t('feedView.collapsedIcon')}
          </span>
          <span
            style={{
              fontFamily: cmd ? 'var(--font-mono)' : 'var(--font-ui)',
              fontWeight: cmd ? 700 : 400,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minInlineSize: 0,
            }}
          >
            {label}
          </span>
          {!open && (
            <span style={{ fontSize: 9.5, color: 'var(--faint)', flexShrink: 0 }}>
              {t('feedView.expandHint')}
            </span>
          )}
        </FeedExpander>
      )}
      {(!expandable || open) && (
        <div id={expandable ? bodyId : undefined} style={{ whiteSpace: 'pre-wrap' }}>
          {text}
        </div>
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
    render: (b) => <Markdown text={b.text ?? ''} streaming={b.streaming} />,
  },
];

