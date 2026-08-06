// The renderer's ONE markdown path (extracted for P2-E19-03).
//
// It was inline in `extensibility/feed-blocks.tsx` and had exactly one caller;
// the update dialog is the second, and two copies of a `marked` + DOMPurify
// pipeline is two sanitizer configurations that can drift apart. So it moved
// here, unchanged in behaviour, with the feed importing it.
//
// This is a DOWN PAYMENT on P2-E16-01, which specifies "one renderer-side
// markdown module with ONE sanitizer configuration" — not the whole item. E16
// still owns the shared options (gfm, link handling, code highlighting); what
// exists here is the single call site those options will eventually configure.
import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** The "still typing" cue. A glyph, not copy — nothing here to translate. */
export const STREAMING_CARET = '▌';

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
  const html = React.useMemo(
    () => (streaming ? '' : DOMPurify.sanitize(marked.parse(text, { async: false }) as string)),
    [text, streaming]
  );
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
