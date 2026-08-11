// The renderer's ONE markdown path (P2-E19-03 extracted it; P2-E16-01 gave it
// the configuration).
//
// It was inline in `extensibility/feed-blocks.tsx` and had exactly one caller;
// the update dialog is the second, the §5.30 document viewer is the third, and
// three copies of a `marked` + DOMPurify pipeline is three sanitizer
// configurations that drift apart — the security configuration drifting with
// them. DESIGN.md §5.30 states the single renderer as a REQUIREMENT for that
// reason, so it is code, not a convention: nothing outside this file imports
// `marked` or `dompurify`, and `markdown.test.tsx` asserts that.
//
// P2-E16-01 finished the extraction by naming the options instead of inheriting
// whichever defaults the two libraries happen to ship. What the viewer adds on
// top (heading anchors, a language label and copy button on code fences, front
// matter as a chip, relative-link navigation) is P2-E16-02, and it lands HERE
// rather than beside the viewer — a second pipeline is the thing this file
// exists to prevent.
import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Config as SanitizeConfig } from 'dompurify';

/** The "still typing" cue. A glyph, not copy — nothing here to translate. */
export const STREAMING_CARET = '▌';

/**
 * The ONE parser configuration.
 *
 * Written out rather than left to `marked`'s defaults so that a version bump
 * that changes one of them is a diff on this line instead of a silent change of
 * behaviour in two surfaces at once.
 *
 *  - `async: false` — the return type is the string, not a promise. Rendering
 *    happens inside `useMemo`, which cannot await.
 *  - `gfm: true` — tables, task lists, strikethrough and autolinks. This is
 *    what agents actually emit (§5.30), and it is already `marked`'s default;
 *    naming it makes it a decision rather than an inheritance.
 *  - `breaks: false` — a single newline is not a `<br>`. GFM's own rule, and
 *    the one that keeps a hard-wrapped paragraph from rendering as a ladder.
 */
export const MARKED_OPTIONS = { async: false, gfm: true, breaks: false } as const;

/**
 * The ONE sanitizer configuration. §5.29 in a constant.
 *
 * `USE_PROFILES: { html: true }` is the whole of it, and it is narrower than
 * DOMPurify's default, which also allows SVG and MathML. Markdown never
 * produces either — they can only arrive as RAW EMBEDDED MARKUP in a file we
 * did not write, which is precisely the input §5.30 says to distrust. §5.30
 * also settles the SVG question directly: "SVG via `<img>` and never inlined so
 * it cannot carry script". An `<img src="x.svg">` still renders under this
 * profile; an inline `<svg>` with an `onload` does not survive it.
 *
 * Everything else is DOMPurify's default and deliberately so: its allow-list,
 * its `javascript:`-scheme refusal and its `on*`-attribute stripping are the
 * parts that get security review upstream, and re-deriving them here would mean
 * owning them here. What we choose is the PROFILE; what is safe inside it is
 * theirs.
 */
export const SANITIZE_CONFIG: SanitizeConfig = { USE_PROFILES: { html: true } };

/**
 * Markdown in, sanitized HTML out. The only place either library is called.
 *
 * Exported as a function as well as a component because the viewer needs the
 * HTML in its own container with its own scroll handling, and "render markdown
 * without mounting `<Markdown>`" must not be a reason to write a second
 * pipeline.
 */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, MARKED_OPTIONS), SANITIZE_CONFIG);
}

/**
 * Render markdown to sanitized HTML.
 *
 * While text is STILL ARRIVING (P2-E18-10) it renders as plain text with a
 * caret on the end, and only becomes markdown once it is complete.
 *
 * Two reasons, and both matter:
 *
 *  - Half a document is not a document. A code fence, list or table that is
 *    mid-write parses as something else entirely, so a streamed reply would
 *    reflow and re-style itself on almost every token.
 *  - Cost. `useMemo` is keyed on the text, so parsing per token means parsing
 *    the WHOLE reply once per token — quadratic in the length of the answer, on
 *    the renderer thread, times every session streaming at once.
 *
 * `className` defaults to the feed's own styling (`.feed-md` in tokens.css),
 * which is where every markdown rule in this app already lives. A second
 * surface that wants different type passes its own and adds rules of its own —
 * it does not fork the pipeline.
 */
export function Markdown({
  text,
  streaming,
  className = 'feed-md',
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}): React.JSX.Element {
  const html = React.useMemo(() => (streaming ? '' : renderMarkdown(text)), [text, streaming]);
  if (streaming) {
    return (
      <div className={className} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
        {text}
        {/* -ink, and no opacity (#246, ported here when the move landed after
            that fix): the caret is the only thing on screen saying the answer
            is still arriving, so it is information, not decoration. The raw
            hue at 0.8 opacity measured 2.08:1 on daylight, and the opacity is
            a second contrast cut nothing measures — it goes, not gets tuned. */}
        <span style={{ color: 'var(--status-working-ink)' }}>{STREAMING_CARET}</span>
      </div>
    );
  }
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
