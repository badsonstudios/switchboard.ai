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
import { FeedBlockDto } from '../lib/feed';
import { commandInvocation, isCommandPlumbing } from '../../../shared/command-invocation';
import {
  codeForCopyButton,
  FEED_CODE_ATTR,
  runCopy,
  type FeedCodeLabels,
} from '../lib/feed-code';
import { FEED_COPY_ATTR, FEED_EXPANDER_ATTR } from '../lib/feed-keys';
import { srOnly } from '../components/sr-only';
import {
  ASK_USER_QUESTION_TOOL,
  pickedFor,
  readAskResult,
  type AskAnswerRead,
  type AskQuestion,
} from '../../../shared/ask-user-question';
import { useRevealed } from '../lib/feed-reveal';
import { ownWords } from '../lib/prompt-history';
import { FeedBlockRendererContribution, manifestFor } from './contributions';
import { decorateFeedMarkdown } from '../lib/feed-markdown';
import {
  capFeedImage,
  chipForFailedFeedImage,
  FEED_OPEN_PATH_ATTR,
  type FeedImageLabels,
} from '../lib/feed-images';
import { rememberImageSize } from '../lib/document-render';
import { useFeedSurface } from '../lib/feed-surface';
import { FEED_THUMB_HEIGHT, FEED_THUMB_WIDTH, feedPictureUrl } from '../../../shared/feed-picture';
import { Markdown } from '../lib/markdown';
import { handleMarkdownLinkClick, openExternalBridge } from '../lib/markdown-links';
import { briefingRefOf, dividerCopy, earlierTurnsCopy } from '../lib/ai-switch-view';
import { compactionCopy } from '../lib/compaction-view';
import { BriefingDialog } from '../components/BriefingDialog';

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
 * The one shape every expander in the feed takes (#174, §5.32).
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
  title,
  style,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** id(s) of the element(s) this shows and hides; omit while none is rendered */
  controls?: string;
  /** the hover, when the label alone does not say enough */
  title?: string;
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
      title={title}
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

/** The copy affordance's words, memoised so `decorate` stays a stable dep. */
function useCodeLabels(): FeedCodeLabels {
  const { t } = useTranslation();
  return React.useMemo(
    () => ({
      copy: t('feedView.copy'),
      copied: t('feedView.copied'),
      copyCode: t('feedView.copyCode'),
    }),
    [t]
  );
}

/** The words for a picture in a reply (#1235): the viewer's own, plus the feed's three. */
function useImageLabels(): FeedImageLabels {
  const { t } = useTranslation();
  return React.useMemo(
    () => ({
      copy: t('feedView.copy'),
      image: t('document.image'),
      openInBrowser: t('document.openInBrowser'),
      mediaOmitted: t('document.mediaOmitted'),
      openPicture: (name: string) => t('feedView.openPicture', { name }),
      openPage: t('document.openInBrowser'),
      notShown: t('feedView.pictureNotShown'),
      openPageNamed: (name: string) => t('feedView.openPageNamed', { name }),
      pagePicture: (name: string) => t('feedView.pagePicture', { name }),
      pageNote: t('feedView.pageNote'),
    }),
    [t]
  );
}

/** Ask main to open a picture or a page in whatever the system uses for it.
 *  THE NARROW ROUTE (`fs:openViewable`), never `openPath`: this is reached
 *  from markup an agent wrote, and main decides what kind of file it really
 *  is. A refusal is a log line, like a refused link. */
function openLocalFile(path: string): void {
  const files = (
    window as unknown as { switchboard?: { files?: { openViewable?: (p: string) => Promise<unknown> } } }
  ).switchboard?.files;
  void files?.openViewable?.(path)?.catch?.(() => undefined);
}

/** Ask main to open a picture from the conversation at full size (#1240).
 *  By HANDLE: main wrote the handle, holds the picture, and decides.
 *  Resolves false when main no longer holds it (or there is no bridge). */
async function openFeedPicture(id: string): Promise<boolean> {
  const transcripts = (
    window as unknown as { switchboard?: { transcripts?: { openPicture?: (id: string) => Promise<unknown> } } }
  ).switchboard?.transcripts;
  try {
    return (await transcripts?.openPicture?.(id)) === true;
  } catch {
    return false;
  }
}

/**
 * One picture from the conversation, small (#1240): a thumbnail that is a
 * button, or the placeholder when main no longer holds the picture.
 *
 * THE BOX IS THE SAME SIZE EITHER WAY, and before the picture arrives: the
 * `width` and `height` are the box's, not the picture's, and the stylesheet
 * fits the picture inside whole. So nothing below a thumbnail moves when it
 * loads, or when it turns out not to.
 *
 * The three attributes are `FeedCopyButton`'s contract: `data-feed-picture`
 * puts it in the arrow-key list, `tabIndex={-1}` keeps the conversation one
 * tab stop, and `data-no-toggle` stops the click folding the box it sits on.
 */
function FeedThumbnail({ id, name }: { id: string; name: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [gone, setGone] = React.useState(false);
  if (gone) {
    return (
      <span className="feed-thumb feed-thumb-gone" data-feed-picture-gone="" title={t('feedView.pictureGoneHint')}>
        {/* the words, not a glyph: the name says which one, the rest says why */}
        <span className="feed-thumb-gone-name">{name}</span>
        <span>{t('feedView.pictureGone')}</span>
      </span>
    );
  }
  const open = t('feedView.openPicture', { name });
  return (
    <button
      type="button"
      className="feed-thumb"
      data-feed-picture={id}
      {...NO_TOGGLE}
      tabIndex={-1}
      aria-label={open}
      title={open}
      onClick={() => {
        // A press that opens nothing must not look like one that did: main
        // has let the picture go since the thumbnail was drawn, so the box
        // says so from now on.
        void openFeedPicture(id).then((opened) => {
          if (!opened) setGone(true);
        });
      }}
    >
      <img
        src={feedPictureUrl(id)}
        alt={name}
        width={FEED_THUMB_WIDTH}
        height={FEED_THUMB_HEIGHT}
        decoding="async"
        draggable={false}
        onError={() => setGone(true)}
      />
    </button>
  );
}

/**
 * The pictures of one message, in a row that wraps (#1240).
 *
 * `name` gives each its text alternative, from its place in the row: a
 * picture a tool returned has no file name and no caption, so "Picture 2 from
 * Read" is the most that can honestly be said of it.
 */
export function FeedPictureStrip({
  ids,
  name,
}: {
  ids: readonly string[];
  name: (n: number, count: number) => string;
}): React.JSX.Element | null {
  if (ids.length === 0) return null;
  return (
    <div className="feed-thumbs" data-feed-pictures={String(ids.length)} {...NO_TOGGLE}>
      {ids.map((id, i) => (
        // keyed by the handle, which is unique for ever: a thumbnail's "gone"
        // state must not pass to whichever picture lands in its slot
        <FeedThumbnail key={id} id={id} name={name(i + 1, ids.length)} />
      ))}
    </div>
  );
}

/** The pictures a tool's result carried, under whatever its box shows. */
function ToolPictures({ b }: { b: FeedBlockDto }): React.JSX.Element | null {
  const { t } = useTranslation();
  const ids = b.tool?.pictures;
  const tool = b.tool?.name ?? '';
  if (!ids || ids.length === 0) return null;
  return (
    <FeedPictureStrip
      ids={ids}
      name={(n, count) =>
        count === 1 ? t('feedView.pictureFromTool', { tool }) : t('feedView.pictureFromToolNth', { n, tool })
      }
    />
  );
}

/**
 * Copy this block of code (#477) — the React half of the one affordance.
 *
 * The other half is written into sanitized HTML by `decorateFeedCodeFences` and
 * answered by a delegated handler; this is for the blocks that are components
 * (Bash IN/OUT), where the text is already in hand and reading it back off the
 * DOM would be a worse answer than passing it.
 *
 * `text` is a FUNCTION so the click reads the current value, for the same reason
 * the rendered button reads its `<pre>` at click time: a section whose content
 * changed under a memoised button must not copy what it used to say.
 *
 * The three attributes are the contract, not decoration: `data-feed-copy` puts
 * it in the arrow-key list (`feed-keys.ts`), `tabIndex={-1}` keeps the
 * conversation one tab stop, and `data-no-toggle` stops the click also folding
 * the tool box it sits in. EXPORTED because renderers are contributions and may
 * live in any module (§5.23) — a new renderer with code in it adopts this rather
 * than growing a second copy button.
 */
export function FeedCopyButton({
  text,
  name,
  style,
}: {
  text: () => string;
  /**
   * The accessible name, when "Copy this code" would be ambiguous. A Bash box
   * holds TWO of these six pixels apart, and #196's lesson is that several
   * controls with one name is the same failure as no name at all — a screen
   * reader's button quick-nav would read "Copy this code, Copy this code" and
   * leave the user to guess which was the command and which the output.
   */
  name?: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  const labels = useCodeLabels();
  return (
    <button
      type="button"
      className="feed-code-copy"
      aria-label={name ?? labels.copyCode}
      {...{ [FEED_COPY_ATTR]: '' }}
      {...NO_TOGGLE}
      tabIndex={-1}
      onClick={(e) => runCopy(e.currentTarget, text(), labels.copied)}
      style={{ flexShrink: 0, alignSelf: 'flex-start', ...style }}
    >
      {labels.copy}
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

// `Markdown` and `STREAMING_CARET` used to live here; they moved to
// `lib/markdown.tsx` when the update dialog (P2-E19-03) became the second
// caller — one `marked` + DOMPurify pipeline, one sanitizer configuration.

/**
 * "failed", IN WORDS and in the failure ink (#1200; every kind of call since
 * #1271).
 *
 * A call that failed is never folded away: it stands between two folds as a
 * row of its own. That only helps if the row SAYS it failed. A command's did;
 * an edit's and an MCP call's did not, so the one row left standing in a run
 * of twenty looked like an ordinary row somebody forgot to fold. Red is for
 * failures (§5.32).
 */
function FailedMark(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      data-feed-failed
      style={{
        marginInlineStart: 'auto',
        fontSize: 9.5,
        fontWeight: 700,
        fontFamily: 'var(--font-ui)',
        color: 'var(--status-crashed-ink)',
        whiteSpace: 'nowrap',
      }}
    >
      {t('feedView.failed')}
    </span>
  );
}

/**
 * WHY it failed: the result the call came back with (#1271).
 *
 * Only for a failed call, and only on the two rows that had nowhere to show
 * a result at all. "String to replace not found in file" and an MCP server's
 * own error are the whole reason the row is standing there.
 */
function FailedReason({ b }: { b: FeedBlockDto }): React.JSX.Element | null {
  const why = b.tool?.failed ? (b.tool.out ?? '').trim() : '';
  if (why === '') return null;
  return (
    <pre
      data-feed-failed-reason
      {...NO_TOGGLE}
      style={{
        margin: '2px 0 2px 14px',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--status-crashed-ink)',
        maxBlockSize: 120,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {why}
    </pre>
  );
}

/** Edit/Write block (E10-06): header + added/removed subtitle + shaded panes. */
function EditBlock({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(true);
  // find jumped here: the block opens whatever the user had folded (§5.31 —
  // "jumping to a hit expands that block"). See lib/feed-reveal. Read into a
  // const, never inlined into the `||` below: short-circuiting past a hook
  // call is a conditional hook.
  const revealed = useRevealed(b.seq);
  const open = expanded || revealed;
  const diffId = React.useId();
  const added = (b.tool?.newString ?? '').split('\n').filter((l) => l.length > 0).length;
  const removed = (b.tool?.oldString ?? '').split('\n').filter((l) => l.length > 0).length;
  const toggle = (): void => setExpanded(!open);
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
          <span style={{ fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>
            <span>{b.tool?.name}</span>
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minInlineSize: 0 }}>
            {b.tool?.filePath ?? b.tool?.summary}
          </span>
          {b.tool?.failed && <FailedMark />}
        </FeedExpander>
        <FailedReason b={b} />
        <div style={{ fontSize: 9.5, color: 'var(--muted)', marginBlock: 2 }}>
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
      <ToolPictures b={b} />
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
  const [inExpanded, setInExpanded] = React.useState(false);
  const [outExpanded, setOutExpanded] = React.useState(false);
  // find jumped here — both sections open (§5.31). A bash block's OUT is where
  // the error strings the user is hunting actually live, so opening only the
  // header would be the useless half of the gesture.
  const revealed = useRevealed(b.seq);
  const inOpen = inExpanded || revealed;
  const outOpen = outExpanded || revealed;
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
    //
    // `data-feed-code` marks the `<pre>` this section's copy button is for
    // (#477), the same relationship a rendered fence expresses around its own
    // wrapper — one rule for "which code does this button copy", both halves.
    <div
      {...NO_TOGGLE}
      {...{ [FEED_CODE_ATTR]: '' }}
      style={{ display: 'flex', gap: 6, alignItems: 'baseline', minInlineSize: 0 }}
    >
      <FeedExpander
        open={open}
        onToggle={toggle}
        // the <pre> is always rendered — collapsed it shows the first line —
        // so the controlled element exists in both states
        controls={id}
        style={{ fontSize: 8.5, fontWeight: 700, color: 'var(--muted)', flexShrink: 0, inlineSize: 26 }}
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
      {/* Only while the section is OPEN (#477). A collapsed section shows its
          first line, so a copy button beside it would either copy something the
          reader cannot see or copy the one line it can — and neither is the
          command they meant. It also keeps the arrow-key walk the length the
          conversation looks: shut sections add no stops. */}
      {open && <FeedCopyButton text={() => text} name={t('feedView.copySection', { section: label })} />}
    </div>
  );
  // The box's own toggle (#91) is the COARSE one: Dan's ask was "click the box
  // and see what the bash command is", so it opens both sections at once and a
  // second click puts them both away. The per-section chevrons are still there
  // for the finer moves.
  const anyOpen = inOpen || outOpen;
  const toggleAll = (): void => {
    setInExpanded(!anyOpen);
    setOutExpanded(!anyOpen);
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
          <span style={{ fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>
            <span>{b.tool?.name}</span>
          </span>
          <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{b.tool?.description ?? ''}</span>
          {/* IN WORDS, and in the failure ink (#1200). A command that failed is
              never folded into "Ran N commands", so this is the row that has
              to say so; until now nothing on it did, and you opened OUT to
              find the exit code. Red is for failures (§5.32). */}
          {b.tool?.failed && <FailedMark />}
        </FeedExpander>
        {section(inId, t('feedView.in'), b.tool?.summary ?? '', inOpen, () => setInExpanded(!inOpen))}
        {hasOut &&
          section(outId, t('feedView.out'), b.tool?.out ?? '', outOpen, () => setOutExpanded(!outOpen))}
      </div>
      <ToolPictures b={b} />
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
        <div style={{ fontWeight: 700, color: 'var(--text)', marginBlockEnd: 2, whiteSpace: 'nowrap' }}>
          <span>{t('feedView.updateTodos')}</span>
        </div>
        {(b.todos ?? []).map((td, i) => (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline', color: 'var(--muted)' }}>
            {/* -ink on both arms (#246): a checklist marker is 10px TEXT on the
                tool box's --panel2, where the two raw hues it uses measure
                2.33-2.35:1 on daylight and 4.49-4.52:1 on nordic */}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, flexShrink: 0, color: td.status === 'completed' ? 'var(--status-done-ink)' : td.status === 'in_progress' ? 'var(--status-working-ink)' : 'var(--muted)' }}>
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

/**
 * A turn the harness injected, as a row rather than as a prompt (#704).
 *
 * WHAT IT REPLACES. A background task that emits an event or ends makes the CLI
 * write a turn into the conversation to re-invoke the model. It arrives with
 * `role: user`, so the feed gave it the full prompt treatment: a NEW PROMPT
 * divider — louder since #640 — over a pill of raw XML that the person reading
 * had never typed. Every block here is the same furniture the tool rows already
 * use, deliberately: this is an event the session had, and it should read as one.
 *
 * THE COLLAPSED ROW IS THE SUMMARY AND NOTHING ELSE. The payload also carries
 * the harness's instruction to the model ("If this event is something the user
 * would act on now, send a PushNotification…"), and that sentence in the row
 * would read as the app telling its user what to do. It is in the expansion,
 * with the task id and the output-file path — which is also what keeps the
 * summary checkable rather than a claim.
 */
/**
 * Where this card was switched from one AI to another (#1294). A rule across the
 * conversation with the two AIs and the time, in the "conversation cleared"
 * marker's look — the other divider the Feed draws. Words only, so it reads
 * without colour; #1295 adds "handed a summary of N turns" and "see what it was
 * told", and `dividerCopy` claims a briefing only when the mark records one.
 */
function AiSwitchDivider({ b }: { b: FeedBlockDto }): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const [viewing, setViewing] = React.useState(false);
  const mark = b.aiSwitch;
  if (!mark) return null;
  const copy = dividerCopy(mark, Date.now(), i18n.language);
  const text = t(copy.key, copy.vars);
  // #1295: the briefing's exact text, offered only when one was sent AND kept
  const ref = briefingRefOf(mark);
  // …and the faint line for the turns that happened with the other AI. Not
  // drawn: they are that AI's conversation, and switching back shows them.
  const earlier = earlierTurnsCopy(mark);
  return (
    <div data-ai-switch-divider={mark.id} data-from={mark.from.providerId} data-to={mark.to.providerId}>
      {earlier && (
        <div
          data-ai-switch-earlier
          style={{
            textAlign: 'center',
            marginBlockStart: 8,
            color: 'var(--muted)',
            fontSize: 10,
            fontFamily: 'var(--font-ui)',
          }}
        >
          {t(earlier.key, earlier.vars)}
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBlock: 10,
          marginInline: 10,
          color: 'var(--muted)',
          fontSize: 10.5,
          fontFamily: 'var(--font-ui)',
        }}
      >
        <span aria-hidden style={{ flex: 1, borderBlockStart: '1px solid var(--border)' }} />
        <span
          role="separator"
          aria-label={text}
          title={new Date(mark.at).toLocaleString(i18n.language || undefined)}
          data-ai-switch-label
        >
          <span aria-hidden>{text}</span>
        </span>
        {ref && (
          // A stop on the conversation's arrow-key walk, not a Tab stop of its
          // own (#1439, §5.32): `FEED_STOP_SELECTOR` names it, and the dialog
          // hands focus back here on close, so the walk resumes where it was.
          <button
            type="button"
            data-ai-switch-see-briefing
            aria-haspopup="dialog"
            tabIndex={-1}
            title={t('aiSwitch.seeBriefingHint', { to: mark.to.name })}
            onClick={() => setViewing(true)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              color: 'var(--text)',
              textDecoration: 'underline',
              cursor: 'pointer',
              font: 'inherit',
            }}
          >
            {t('aiSwitch.seeBriefing')}
          </button>
        )}
        <span aria-hidden style={{ flex: 1, borderBlockStart: '1px solid var(--border)' }} />
      </div>
      {viewing && ref && <BriefingDialog mark={mark} briefingRef={ref} onClose={() => setViewing(false)} />}
    </div>
  );
}

/**
 * Where the conversation was compacted (#1259): a rule across it, in the
 * "conversation cleared" marker's look. Above it the AI now has only a
 * summary; the hover says so.
 *
 * THE SUMMARY ITSELF, ON REQUEST (#1374). It is never drawn into the
 * conversation (#1026: the CLI's own live view hides it, and as a block it
 * read as a prompt the user typed). When main kept one for this divider the
 * mark carries a handle, and "Show summary" asks for the text by it and shows
 * it under the rule, verbatim, in a `<pre>`: what the reader came to see is
 * what the AI now remembers, word for word. Collapsed by default; a plain
 * button, so Tab and Enter reach it in a popout exactly as in the main window.
 */
function CompactionDivider({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const copy = compactionCopy(b.compaction);
  const text = t(copy.key, copy.vars);
  const summaryId = b.compaction?.summaryId;
  const [open, setOpen] = React.useState(false);
  const [summary, setSummary] = React.useState<CompactionSummaryState>({ state: 'loading' });
  const regionId = React.useId();

  React.useEffect(() => {
    if (!open || !summaryId) return;
    let live = true;
    setSummary({ state: 'loading' });
    // a missing bridge, a refusal, a rejection: all "no longer available"
    const call = window.switchboard?.transcripts?.compactionSummary?.(summaryId);
    Promise.resolve(call)
      .then((r) => {
        if (!live) return;
        setSummary(r && r.ok === true && typeof r.text === 'string' ? { state: 'text', text: r.text } : { state: 'gone' });
      })
      .catch(() => live && setSummary({ state: 'gone' }));
    return () => {
      live = false;
    };
  }, [open, summaryId]);

  return (
    <div data-compaction-divider data-trigger={b.compaction?.trigger ?? 'unknown'}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBlock: 10,
          marginInline: 10,
          color: 'var(--muted)',
          fontSize: 10.5,
          fontFamily: 'var(--font-ui)',
        }}
      >
        <span aria-hidden style={{ flex: 1, borderBlockStart: '1px solid var(--border)' }} />
        <span role="separator" aria-label={text} title={t('feedView.compaction.hint')} data-compaction-label>
          <span aria-hidden>{text}</span>
        </span>
        {summaryId && (
          // A feed expander like every other (#174): reached with the arrow
          // keys inside the conversation, not a Tab stop of its own, so a long
          // session's dividers never stand between the user and the composer.
          <FeedExpander
            open={open}
            onToggle={() => setOpen(!open)}
            controls={open ? regionId : undefined}
            title={t('feedView.compaction.summaryHint')}
            style={{ flex: 'none', color: 'var(--text)', textDecoration: 'underline' }}
          >
            {open ? t('feedView.compaction.hideSummary') : t('feedView.compaction.showSummary')}
          </FeedExpander>
        )}
        <span aria-hidden style={{ flex: 1, borderBlockStart: '1px solid var(--border)' }} />
      </div>
      {open && summaryId && (
        <div
          id={regionId}
          role="region"
          aria-label={t('feedView.compaction.summaryLabel')}
          data-compaction-summary
          style={{
            marginInline: 10,
            marginBlockEnd: 10,
            maxBlockSize: 320,
            overflow: 'auto',
            padding: '8px 10px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--panel2)',
          }}
        >
          {summary.state === 'loading' && (
            <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-ui)' }}>
              {t('feedView.compaction.summaryLoading')}
            </div>
          )}
          {summary.state === 'gone' && (
            <div data-compaction-summary-gone style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'var(--font-ui)' }}>
              {t('feedView.compaction.summaryGone')}
            </div>
          )}
          {summary.state === 'text' && (
            <pre
              data-compaction-summary-text
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
              {summary.text}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

type CompactionSummaryState = { state: 'loading' } | { state: 'text'; text: string } | { state: 'gone' };

function NoticeBlock({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  // find jumped here — the payload unfolds (§5.31). The summary is a fifth of
  // what the block holds, and the task id someone searched for is in the rest.
  const revealed = useRevealed(b.seq);
  const open = expanded || revealed;
  const rawId = React.useId();
  const toggle = (): void => setExpanded(!open);
  const notice = b.notice;
  // `completed` and `failed` are the CLI's own words and are translated; an
  // `<event>` payload has no such word, so `injected.ts` hands over `event`.
  // ANYTHING ELSE IS SHOWN VERBATIM rather than dropped — a status the CLI grows
  // tomorrow is still the truest thing we have to put in the chip, and hiding it
  // because we had no translation for it would be losing the one field that says
  // whether the thing worked.
  const statusKey = `feedView.notice.status.${notice?.status ?? ''}`;
  const status = notice?.status
    ? t(statusKey, { defaultValue: notice.status })
    : undefined;
  // `killed` and `stopped` are the CLI's other two ENDED-BADLY words (its own
  // enums are `["completed","failed","stopped"]` and `["pending","running",
  // "completed","failed","killed","paused"]`). A task the user killed is not a
  // failure, but neither is it the quiet "it finished" the faint ink promises —
  // both are things that did not run to the end, and the row is the only place
  // that is ever said.
  const wrong = notice?.status === 'failed' || notice?.status === 'killed';
  return (
    <ToolBox kind="notice" onToggle={toggle}>
      <div style={{ fontSize: 11 }}>
        <FeedExpander
          open={open}
          onToggle={toggle}
          controls={open ? rawId : undefined}
          style={{ display: 'flex', gap: 6, alignItems: 'baseline', inlineSize: '100%' }}
        >
          <span style={{ fontSize: 8, color: 'var(--muted)', flexShrink: 0 }}>
            {open ? t('feedView.expandedIcon') : t('feedView.collapsedIcon')}
          </span>
          {/* The kind of thing this is, said in words. The row is otherwise a
              sentence from a background process, and without this the reader
              has no way to tell it from the session's own prose. */}
          <span style={{ fontWeight: 700, color: 'var(--text)', flexShrink: 0 }}>
            {t('feedView.notice.backgroundTask')}
          </span>
          <span
            style={{
              color: 'var(--muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minInlineSize: 0,
            }}
          >
            {notice?.summary}
          </span>
          {status && (
            // -ink on the failure arm for the same reason every other status
            // word in the feed uses it (#246): this is 9.5px text on the tool
            // box's --panel2, where the raw hue does not carry in daylight.
            <span
              data-notice-status={notice?.status}
              style={{
                fontSize: 9.5,
                fontFamily: 'var(--font-ui)',
                color: wrong ? 'var(--status-crashed-ink)' : 'var(--muted)',
                // ELLIPSISED, not `flexShrink: 0`. A status is whatever word
                // the CLI wrote, capped at the summary budget rather than at a
                // chip's width — an unshrinkable one would push the summary it
                // is annotating off the row.
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minInlineSize: 0,
                maxInlineSize: '8em',
              }}
            >
              {status}
            </span>
          )}
        </FeedExpander>
        {open && (
          <pre
            id={rawId}
            {...NO_TOGGLE}
            style={{
              margin: '2px 0 4px 14px',
              padding: 6,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              color: 'var(--muted)',
              maxBlockSize: 240,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {notice?.raw}
          </pre>
        )}
      </div>
    </ToolBox>
  );
}

function ToolRow({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  // find jumped here — the detail unfolds (§5.31). See lib/feed-reveal.
  const revealed = useRevealed(b.seq);
  const open = expanded || revealed;
  const detailId = React.useId();
  const expandable = !!b.tool?.detail;
  const toggle = (): void => setExpanded(!open);
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
      <span style={{ color: 'var(--muted)', fontSize: 8 }}>{open ? '▾' : '▸'}</span>
      {/* the tool's NAME — the header of every tool block in the feed, and the
          most-repeated status-coloured word in the app after the pill. -ink
          because the hue is 2.33:1 on daylight's tool box and 4.52:1 on
          nordic's; the ink is 5.47:1 and 5.75:1 (#246). */}
      <span style={{ color: 'var(--status-working-ink)', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {/* THE NAME KEEPS A SPAN OF ITS OWN, and that is not tidiness (found in
            review of #757). Find-in-conversation only paints a match on a text
            node that is its parent's ONLY child (`lib/feed-marks.ts`), so the
            name must not share its element with anything. The picture that
            used to sit beside it is in the timeline gutter now (#1207). */}
        <span>{b.tool?.name}</span>
      </span>
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
      {b.tool?.failed && <FailedMark />}
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
        <FailedReason b={b} />
      </div>
      <ToolPictures b={b} />
    </ToolBox>
  );
}

/**
 * A question the session asked, read back (#1201).
 *
 * The owner: "when you go back into the session and scroll up to where the
 * questions were asked, it's displayed in what looks like JSON … I need nice
 * output formatting so we can easily read it in English."
 *
 * While a question is OPEN it has its own panel above the prompt box (#733).
 * This is what is left in the conversation afterwards, and what a resumed
 * session replays: each question as a sentence, what was offered, and what was
 * chosen, typed, or skipped. Both come from the transcript's own blocks: the
 * questions from the call, the answers from the CLI's result (the reading rule
 * is `shared/ask-user-question`'s `readAskResult`). Nothing here is remembered
 * from the live panel, which is what makes a replay look the same.
 *
 * THE RAW CALL IS STILL ONE CLICK AWAY, behind the same expander every other
 * tool row has. It is what you want when the reading above looks wrong.
 */
function QuestionBlock({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  // find jumped here: the raw call unfolds (§5.31), as on every tool row
  const revealed = useRevealed(b.seq);
  const open = expanded || revealed;
  const rawId = React.useId();
  const toggle = (): void => setExpanded(!open);
  const questions = b.tool?.questions ?? [];
  const outcome = readAskResult(questions, b.tool?.out);
  const hasRaw = !!b.tool?.detail;
  const header = (
    <>
      {hasRaw && (
        <span style={{ color: 'var(--muted)', fontSize: 8, flexShrink: 0 }}>
          {open ? t('feedView.expandedIcon') : t('feedView.collapsedIcon')}
        </span>
      )}
      <span style={{ color: 'var(--status-working-ink)', fontWeight: 600, whiteSpace: 'nowrap' }}>
        <span>{t('feedView.question.title', { count: questions.length })}</span>
      </span>
      <span
        data-question-state={outcome.state}
        style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}
      >
        {t(`feedView.question.state.${outcome.state}`)}
      </span>
    </>
  );
  const headerStyle: React.CSSProperties = {
    display: 'flex',
    gap: 6,
    alignItems: 'baseline',
    padding: '1px 0',
    inlineSize: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: 10.5,
  };
  return (
    <ToolBox kind="question" onToggle={hasRaw ? toggle : undefined}>
      {hasRaw ? (
        <FeedExpander
          open={open}
          onToggle={toggle}
          controls={open ? rawId : undefined}
          style={headerStyle}
        >
          {header}
        </FeedExpander>
      ) : (
        <div style={headerStyle}>{header}</div>
      )}
      {/* NOT A TOGGLE: reading and selecting an answer must not fold the box */}
      <div {...NO_TOGGLE} style={{ cursor: 'auto', paddingBlock: '2px 3px', fontSize: 11.5 }}>
        {questions.map((q, i) => (
          <QuestionAnswer
            // by position: one call can carry the same question text twice
            key={i}
            q={q}
            read={outcome.state === 'answered' ? outcome.answers[i] : undefined}
            cut={outcome.state === 'answered' && outcome.cut}
          />
        ))}
        {outcome.state === 'declined' && outcome.reason !== '' && (
          <div
            data-question-reason
            style={{ marginBlockStart: 4, color: 'var(--muted)', whiteSpace: 'pre-wrap' }}
          >
            {outcome.reason}
          </div>
        )}
        {/* answered in their own words rather than through the choices */}
        {outcome.state === 'responded' && (
          <div data-question-responded style={{ marginBlockStart: 4, color: 'var(--text)' }}>
            <span style={{ color: 'var(--muted)' }}>{t('feedView.question.other')}</span>
            <span style={{ fontWeight: 600, whiteSpace: 'pre-wrap' }}>{outcome.text}</span>
          </div>
        )}
      </div>
      {open && hasRaw && (
        <pre
          id={rawId}
          {...NO_TOGGLE}
          style={{
            margin: '2px 0 4px 14px',
            padding: 6,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            color: 'var(--muted)',
            maxBlockSize: 240,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {b.tool?.detail}
        </pre>
      )}
      <ToolPictures b={b} />
    </ToolBox>
  );
}

/** One question of the call: the sentence, what was offered, what came back. */
function QuestionAnswer({
  q,
  read: got,
  cut,
}: {
  q: AskQuestion;
  /** what came back for it; null = not in the result; undefined = the call
   *  has no per-question answers at all */
  read: AskAnswerRead | null | undefined;
  /** the result was cut short, so "not in the result" is not "skipped" */
  cut: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const answer = got === undefined ? undefined : (got?.answer ?? null);
  const read = typeof answer === 'string' ? pickedFor(q, answer) : null;
  // absent from a result that was cut short may only mean "past the cut"
  const lost = got === null && cut;
  return (
    <div data-question style={{ paddingBlock: 3 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
        {q.header && (
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              color: 'var(--muted)',
              border: '1px solid var(--control-edge)',
              borderRadius: 'var(--radius-chip)',
              padding: '0 5px',
              whiteSpace: 'nowrap',
            }}
          >
            {q.header}
          </span>
        )}
        <span data-question-text style={{ fontWeight: 600, color: 'var(--text)' }}>
          {q.question}
        </span>
      </div>
      <ul style={{ listStyle: 'none', margin: '3px 0 0', padding: 0 }}>
        {q.options.map((o, i) => {
          const chosen = read?.picked.includes(o.label) ?? false;
          return (
            <li
              // by position: labels are the CLI's words and are not ours to
              // assume unique once shown
              key={i}
              data-question-option={chosen ? 'chosen' : 'offered'}
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'baseline',
                paddingBlock: 1,
                // what was NOT chosen stays readable (--muted is the readable
                // grey); what was chosen is full ink and bold, and has a mark
                // and a word beside it, so it never rests on weight alone
                color: chosen ? 'var(--text)' : 'var(--muted)',
                fontWeight: chosen ? 600 : 400,
              }}
            >
              <span aria-hidden style={{ inlineSize: 10, flexShrink: 0 }}>
                {chosen ? t('feedView.question.chosenMark') : t('feedView.question.offeredMark')}
              </span>
              <span style={{ minInlineSize: 0 }}>
                <span>{o.label}</span>
                {chosen && <span style={srOnly}>{t('feedView.question.chosenWord')}</span>}
                {o.description && (
                  <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                    {t('feedView.question.descriptionJoin')}
                    {o.description}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {read?.other != null && (
        <div data-question-other style={{ marginBlockStart: 2, color: 'var(--text)' }}>
          <span style={{ color: 'var(--muted)' }}>{t('feedView.question.other')}</span>
          <span style={{ fontWeight: 600, whiteSpace: 'pre-wrap' }}>{read.other}</span>
        </div>
      )}
      {got?.notes && (
        <div data-question-notes style={{ marginBlockStart: 2, color: 'var(--text)' }}>
          <span style={{ color: 'var(--muted)' }}>{t('feedView.question.notes')}</span>
          <span style={{ whiteSpace: 'pre-wrap' }}>{got.notes}</span>
        </div>
      )}
      {answer === null && !lost && (
        <div data-question-skipped style={{ marginBlockStart: 2, color: 'var(--muted)' }}>
          {t('feedView.question.skipped')}
        </div>
      )}
      {lost && (
        <div data-question-cut style={{ marginBlockStart: 2, color: 'var(--muted)' }}>
          {t('feedView.question.cut')}
        </div>
      )}
    </div>
  );
}

function ThinkingRow({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  // find jumped here — thinking unfolds (§5.31). It is folded to one line by
  // default AND hidden outright below `firehose`, so this is the block the
  // reveal mechanism was really built for. See lib/feed-reveal.
  const revealed = useRevealed(b.seq);
  const open = expanded || revealed;
  const textId = React.useId();
  const label = b.durationMs
    ? t('feedView.thoughtFor', { s: Math.max(1, Math.round(b.durationMs / 1000)) })
    : t('feedView.thinking');
  return (
    <div style={{ fontSize: 10.5, color: 'var(--muted)', fontStyle: 'italic' }}>
      <FeedExpander open={open} onToggle={() => setExpanded(!open)} controls={open ? textId : undefined}>
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
 * Which of the three messages a given pair of counts calls for.
 *
 * Spelled out rather than built as `feedView.attached.${key}`, so that each key
 * is findable by grepping for the string a translator or a key-extraction check
 * would search for.
 */
const ATTACHED_KEY = {
  images: 'feedView.attached.images',
  documents: 'feedView.attached.documents',
  both: 'feedView.attached.both',
} as const;

/**
 * What rode with this prompt, on the prompt (#491).
 *
 * A COUNT, WITH THE THUMBNAILS UNDER IT SINCE #1240. This used to be the whole
 * of it, because nothing kept the bytes: the composer lets go of an attachment
 * at the send, and still does. What changed is that main now keeps the
 * pictures of the messages it reads, in memory, for the conversation to show
 * (`main/feed/pictures.ts`), so the prompt can show what it carried. The count
 * stays because it says what a thumbnail cannot: how many DOCUMENTS rode
 * along, and that a picture was there even once main has let it go.
 *
 * NO FILENAMES, and that is a choice rather than an omission. A `document`
 * block carries a `title` straight off `File.name`, which is attacker-adjacent
 * text (#499 is open on bidi characters in exactly that field). Digits and the
 * app's own words cannot carry any of it. When #499 settles how a title is
 * safely displayed, this is where a name would go.
 *
 * ALWAYS VISIBLE, above the header line: a long prompt collapses to one row,
 * and a marker that collapsed with it would hide the very evidence this block
 * exists to keep.
 *
 * NO `title=` ATTRIBUTE, on purpose. On a generic element a `title` becomes the
 * computed accessible NAME, so a hint there would be announced INSTEAD of "1
 * image attached" — the opposite of the point. The visible words are the whole
 * message, and they are the whole message for everyone.
 *
 * KNOWN BOUNDARY: this is an element whose only child is a text node, which is
 * the shape `lib/feed-marks.ts` is free to split — so a session find for
 * "image" can paint a highlight on these words even though the engine, which
 * searches the transcript rather than the DOM, never counted them. Cosmetic,
 * and the same is already true of `feedView.expandHint` beside it.
 */
function AttachmentMarker({
  attachments,
}: {
  attachments: NonNullable<FeedBlockDto['attachments']>;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { images, documents } = attachments;
  if (images <= 0 && documents <= 0) return null;
  // Three whole messages rather than two clauses glued together: "2 images" and
  // "1 file" do not compose into a sentence the same way in every language, and
  // a translator handed a separator to join cannot fix that.
  const key = images > 0 && documents > 0 ? 'both' : images > 0 ? 'images' : 'documents';
  return (
    <div
      data-feed-attachments={String(images + documents)}
      style={{
        fontSize: 9.5,
        fontFamily: 'var(--font-ui)',
        color: 'var(--muted)',
        marginBlockEnd: 3,
      }}
    >
      {t(ATTACHED_KEY[key], { images, documents })}
    </div>
  );
}

/**
 * One stretch of a sent prompt that this app injected: another session's recent
 * output, resolved from an `@Name` mention (#830).
 *
 * A COLLAPSED ROW, in the same furniture as every other foldable thing in the
 * feed — `ToolBox` for the container and its read-not-a-click guard,
 * `FeedExpander` for the keyboard path and `aria-expanded`. It is deliberately
 * not a variant of the user pill: what it holds is not the user's words.
 *
 * ⚠️ THE ROW DOES NOT DECIDE WHAT IS INJECTED. It renders the ranges main put on
 * the block, and main puts one there only for a marker it minted (`main/feed/
 * context-refs.ts`). A pasted transcript containing the marker text arrives with
 * no ranges at all and renders as the plain prose it is — which is the whole
 * reason this could not be done with a regex in the renderer.
 */
function InjectedContextRow({
  name,
  body,
  revealed,
}: {
  name: string;
  body: string;
  /** find jumped into this turn — unfold, §5.31, like every other row */
  revealed: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = React.useState(false);
  const open = expanded || revealed;
  const bodyId = React.useId();
  const toggle = (): void => setExpanded(!open);
  return (
    <ToolBox kind="context" onToggle={toggle}>
      <div style={{ fontSize: 11 }}>
        <FeedExpander
          open={open}
          onToggle={toggle}
          controls={open ? bodyId : undefined}
          style={{ display: 'flex', gap: 6, alignItems: 'baseline', inlineSize: '100%' }}
        >
          <span style={{ fontSize: 8, color: 'var(--muted)', flexShrink: 0 }}>
            {open ? t('feedView.expandedIcon') : t('feedView.collapsedIcon')}
          </span>
          <span
            style={{
              fontWeight: 700,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minInlineSize: 0,
            }}
          >
            {t('feedView.injectedContext.label', { name })}
          </span>
          <span style={{ fontSize: 9.5, color: 'var(--muted)', flexShrink: 0 }}>
            {t('feedView.injectedContext.hint')}
          </span>
        </FeedExpander>
        {open && (
          // `NO_TOGGLE` for the reason every other expanded payload carries it:
          // this is for READING, and selecting a line out of it must not fold it
          // away under the pointer.
          <pre
            id={bodyId}
            {...NO_TOGGLE}
            style={{
              margin: '2px 0 4px 14px',
              padding: 6,
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              color: 'var(--muted)',
              maxBlockSize: 240,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {body}
          </pre>
        )}
      </div>
    </ToolBox>
  );
}

/**
 * The user's prompt in a tinted pill (Dan #2). Long payloads — skill
 * invocations dump the whole skill body as a user message — collapse to a
 * header line with click-to-expand, like tool blocks (Dan #7).
 *
 * ── WHAT `b.context` CHANGES (#830) ────────────────────────────────────────
 *
 * A prompt that mentioned another session carries that session's output ahead of
 * the prose. Before this, the pill saw one very long string: it collapsed, and
 * the header line it showed was the first 160 characters of SOMEBODY ELSE'S
 * transcript, with the user's actual question hidden behind an expander. Now the
 * injected stretches fold into their own rows and the question stands on its
 * own — so `long`, `cmd` and the label are all computed from the PROSE, which is
 * the text the user typed.
 *
 * Nothing changes for a block with no ranges: the prose IS the text, byte for
 * byte, and every pinned shape in the suite still holds.
 *
 * THE ROWS RENDER FIRST, not interleaved. Every injected section is built ahead
 * of the prose (`buildMentionPrompt`), so in practice this IS document order;
 * the flattening would only show if a future caller injected mid-prose, and it
 * would cost ordering rather than content.
 */
function UserPill({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const { t } = useTranslation();
  const full = b.text ?? '';
  const sections = b.context;
  // The user's own words: everything outside the injected ranges. `slice` on
  // main's offsets, never a re-parse of the markers — the renderer is not where
  // "is this really ours" gets decided. Memoised on `b.context` itself, not on a
  // `?? []` default, which would be a fresh array and a fresh computation every
  // render for the overwhelmingly common block that has none.
  // (the slicing is `ownWords`, shared with the prompt list so the two cannot
  // disagree about what the user typed, #1203)
  const text = React.useMemo(() => {
    if (sections === undefined || sections.length === 0) return full;
    return ownWords(full, sections);
  }, [full, sections]);
  const [expanded, setExpanded] = React.useState(false);
  // find jumped here — a long prompt (a skill body dumped as a user message)
  // unfolds (§5.31). See lib/feed-reveal. (This used to take a bare `text` and
  // a bare `seq`; #491 needs a third field off the block, and three loose
  // arguments is the point where the block itself is the cheaper thing to
  // pass — as every other renderer in this file already does.)
  const revealed = useRevealed(b.seq);
  const open = expanded || revealed;
  const bodyId = React.useId();
  // A skill / slash-command invocation carries a command-name tag. The rule is
  // SHARED with the prompt readers that skip these blocks (#846) — this used to
  // be a private regex here, and two copies of "what is a command" is how the
  // Feed and the history picker would come to disagree about the same line. It
  // also now shows the args, so `/next-item 818` reads as itself rather than as
  // a bare `/next-item`.
  // ...and it must AGREE with the prompt readers about what a command is. The
  // tags are matched anywhere in the text, so without this guard a message that
  // merely QUOTES the markup — the owner's own bug report for #846 does exactly
  // that — would be collapsed into a `/clear` chip with the real sentence hidden
  // behind the expander. `isCommandPlumbing` anchors at the start, which is the
  // rule main uses to skip these blocks; asking it first is what makes "one
  // rule, both readers" true rather than merely intended.
  const cmd = isCommandPlumbing(text) ? (commandInvocation(text) ?? undefined) : undefined;
  const long = text.length > 500;
  const expandable = !!(cmd || long);
  const label = cmd ?? `${text.slice(0, 160).split(String.fromCharCode(10))[0]}…`;
  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--text) 7%, var(--panel2))',
        border: '1px solid color-mix(in srgb, var(--text) 22%, transparent)',
        borderRadius: 10,
        padding: '6px 10px',
        whiteSpace: 'pre-wrap',
        color: 'var(--text)',
        overflowWrap: 'break-word',
      }}
    >
      {b.attachments && <AttachmentMarker attachments={b.attachments} />}
      {/* ...and the pictures themselves (#1240), under the count. The count
          stays: it also covers documents, and a picture past the limit. */}
      {b.pictures && b.pictures.length > 0 && (
        <FeedPictureStrip
          ids={b.pictures}
          name={(n, count) =>
            count === 1 ? t('feedView.pictureAttached') : t('feedView.pictureAttachedNth', { n })
          }
        />
      )}
      {/* Injected context (#830), each stretch in its own collapsed row. Keyed
          by the ref, which is unique per section by construction — an index key
          would hand a row's open/shut state to whatever section landed in its
          slot when the block was re-emitted. */}
      {sections?.map((s) => (
        <div key={s.ref} style={{ marginBlockEnd: 4 }}>
          <InjectedContextRow name={s.name} body={full.slice(s.start, s.end)} revealed={revealed} />
        </div>
      ))}
      {/* The header line is the ONLY expand target now (#174). It used to be
          the whole pill, in both states — which meant an expanded prompt
          collapsed under the pointer the moment you tried to select a line out
          of it, the same read-not-a-click bug the tool boxes already guard. */}
      {expandable && (
        <FeedExpander
          open={open}
          onToggle={() => setExpanded(!open)}
          controls={open ? bodyId : undefined}
          style={{ display: 'flex', gap: 6, alignItems: 'baseline', inlineSize: '100%' }}
        >
          <span style={{ fontSize: 8, color: 'var(--muted)' }}>
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
            <span style={{ fontSize: 9.5, color: 'var(--muted)', flexShrink: 0 }}>
              {t('feedView.expandHint')}
            </span>
          )}
        </FeedExpander>
      )}
      {/* `text !== ''` is the attachment-only turn (#491): a screenshot sent
          with nothing typed is a real prompt and gets a real pill, but an
          empty body under the marker would be a blank line pretending to be
          words. Every other user block has non-empty text by construction —
          `blocks.ts` only emits one for content that trims to something. */}
      {(!expandable || open) && text !== '' && (
        <div id={expandable ? bodyId : undefined} style={{ whiteSpace: 'pre-wrap' }}>
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * Assistant prose (the fallback renderer), and the surface pass that goes with
 * it.
 *
 * A component rather than a bare `<Markdown>` because both halves of #477 need
 * something a contribution's `render(b)` cannot have: the copy button's WORDS
 * (i18n is a hook) and a place for the delegated click to land.
 *
 * `decorate` is the feed's surface pass (#465): it takes the feed's own DOM
 * protocol back from the reply BEFORE writing any of ours, which is the order
 * that stops a forged copy button ever being read as one of the real ones.
 *
 * THE CLICK IS DELEGATED because the button lives in HTML React does not own —
 * `<Markdown>` sets it with `dangerouslySetInnerHTML`, so there is no JSX to
 * hang an `onClick` on. One listener on the wrapper is also the right shape for
 * a conversation: a long reply can carry a dozen fences, and a listener each
 * would be a dozen per block, times every block on screen.
 *
 * IT IS ALSO WHERE LINKS ARE ANSWERED (#527), and for the same reason: an
 * `<a>` in a reply is markup this component did not write either. The decision
 * itself is `lib/markdown-links.ts` — one guard, and the surfaces that do not
 * share this policy are named there.
 */
function MarkdownBlock({ b }: { b: FeedBlockDto }): React.JSX.Element {
  const labels = useCodeLabels();
  // `b.streaming` is a dependency because it changes what the pass DOES (the
  // fence chrome waits for the turn to end — see `decorateFeedMarkdown`), and
  // because `<Markdown>` memoises on this callback's identity: a stale one
  // would leave a finished fence without its Copy button.
  const streaming = b.streaming === true;
  // PICTURES (#1235): a path in a reply is relative to the session's folder,
  // which this block is not told and reads from the surface it is in.
  const imageLabels = useImageLabels();
  const { folder, pages } = useFeedSurface();
  // only a reply that could name a page is told which pages there are
  // (#1278): a page written re-decorates the replies that mention one, not
  // the whole conversation
  const named = b.kind === 'assistant' && /[.]htm/i.test(b.text ?? '') ? pages : undefined;
  const at = named ? b.seq : undefined;
  const decorate = React.useCallback(
    (html: string) =>
      decorateFeedMarkdown(html, labels, { streaming, images: { labels: imageLabels, folder, pages: named, at } }),
    [labels, streaming, imageLabels, folder, named, at]
  );
  const onClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>): void => {
      const button = (e.target as Element | null)?.closest?.<HTMLElement>(`[${FEED_COPY_ATTR}]`);
      if (button) {
        const code = codeForCopyButton(button);
        // `null` = a button outside any wrapper of ours. Doing nothing beats
        // putting the wrong text on the clipboard.
        if (code !== null) runCopy(button, code, labels.copied);
        return;
      }
      // A picture, or a link to a local HTML file (#1235): open the file. The
      // attribute is ours (the pass takes the feed's namespace back before it
      // writes one), so a reply cannot arrive with a path already on it.
      // A REMOTE picture's chip: its button opens the address in the browser,
      // which is the only thing "show it" can honestly mean for one. Asked
      // FIRST: the chip can sit inside a link to a local page
      // (`[![far](https://…)](page.html)`), and the nearer control is the one
      // that was pressed.
      const remote = (e.target as Element | null)?.closest?.<HTMLElement>('[data-doc-external]');
      if (remote) {
        e.preventDefault();
        void openExternalBridge()?.(remote.getAttribute('data-doc-external') ?? '');
        return;
      }
      const local = (e.target as Element | null)?.closest?.<HTMLElement>(`[${FEED_OPEN_PATH_ATTR}]`);
      if (local) {
        e.preventDefault();
        openLocalFile(local.getAttribute(FEED_OPEN_PATH_ATTR) ?? '');
        return;
      }
      // A link in a reply goes to the OS browser (#527). `void`, because the
      // answer is a log line either way: this handler has nothing to tell the
      // user that main's own refusal line does not already say.
      void handleMarkdownLinkClick(e, { openExternal: openExternalBridge() });
    },
    [labels]
  );
  // Chromium dispatches `auxclick`, not `click`, for the middle button, so a
  // middle-click on a link would miss `onClick` entirely and fall through to
  // main's much broader window-open rule (#527). The update dialog's notes
  // learned this first; the same two listeners, for the same reason.
  const onAuxClick = React.useCallback((e: React.MouseEvent<HTMLDivElement>): void => {
    void handleMarkdownLinkClick(e, { openExternal: openExternalBridge() });
  }, []);
  // `minInlineSize: 0` so the wrapper shrinks the way `<Markdown>`'s own
  // container did when it was the flex child — without it a wide fence stops
  // the block ellipsising and pushes the conversation sideways.
  // `load` and `error` do not bubble, so they are caught on the way DOWN. A
  // picture that loaded has its size remembered, so the next render of this
  // reply reserves its room before the bytes arrive; one that failed becomes
  // the chip, never the broken-picture glyph.
  const onLoad = React.useCallback((e: React.SyntheticEvent<HTMLDivElement>): void => {
    if (rememberImageSize(e.target)) capFeedImage(e.target as Element);
  }, []);
  const onError = React.useCallback(
    (e: React.SyntheticEvent<HTMLDivElement>): void => {
      chipForFailedFeedImage(e.target, imageLabels);
    },
    [imageLabels]
  );
  return (
    <div
      onClick={onClick}
      onAuxClick={onAuxClick}
      onLoadCapture={onLoad}
      onErrorCapture={onError}
      style={{ minInlineSize: 0 }}
    >
      <Markdown text={b.text ?? ''} streaming={b.streaming} decorate={decorate} />
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
    // BEFORE the generic row, which is what a question used to fall through
    // to. Only when the questions came through structured: a payload the CLI's
    // own shape does not describe stays a generic row, raw and honest.
    manifest: manifest('feed-block-question', 'Question and answer block'),
    order: 35,
    matches: (b) =>
      b.kind === 'tool' &&
      b.tool?.name === ASK_USER_QUESTION_TOOL &&
      (b.tool.questions?.length ?? 0) > 0,
    render: (b) => <QuestionBlock b={b} />,
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
    // BEFORE the user pill, and the order is documentation rather than
    // mechanism: the kinds are disjoint, so nothing depends on it — but this
    // block used to BE a user pill, and a reader chasing that bug should meet
    // the two renderers next to each other (#704).
    manifest: manifest('feed-block-ai-switch', 'AI switch divider'),
    order: 54,
    matches: (b) => b.kind === 'ai-switch',
    render: (b) => <AiSwitchDivider b={b} />,
  },
  {
    manifest: manifest('feed-block-compaction', 'Compaction divider'),
    order: 56,
    matches: (b) => b.kind === 'compaction',
    render: (b) => <CompactionDivider b={b} />,
  },
  {
    manifest: manifest('feed-block-notice', 'Harness notification row'),
    order: 55,
    matches: (b) => b.kind === 'notice',
    render: (b) => <NoticeBlock b={b} />,
  },
  {
    manifest: manifest('feed-block-user', 'User prompt pill'),
    order: 60,
    matches: (b) => b.kind === 'user',
    render: (b) => <UserPill b={b} />,
  },
  {
    // matches everything — MUST sort last, or it shadows the whole list
    manifest: manifest('feed-block-markdown', 'Assistant prose (fallback)'),
    order: 1_000,
    matches: () => true,
    render: (b) => <MarkdownBlock b={b} />,
  },
];

