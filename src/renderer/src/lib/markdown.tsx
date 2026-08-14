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
 * The ONE sanitizer configuration. §5.29 in a constant. ONE — see the `style`
 * note below, and `markdown.test.tsx`'s surface table, which pins it.
 *
 * `USE_PROFILES: { html: true }` is the base, and it is narrower than
 * DOMPurify's default, which also allows SVG and MathML. Markdown never
 * produces either — they can only arrive as RAW EMBEDDED MARKUP in a file we
 * did not write, which is precisely the input §5.30 says to distrust. §5.30
 * also settles the SVG question directly: "SVG via `<img>` and never inlined so
 * it cannot carry script". An `<img src="x.svg">` still renders under this
 * profile; an inline `<svg>` with an `onload` does not survive it. The `<style>`
 * TAG is already outside the profile, and that is the bigger of the two CSS
 * holes: a stylesheet is not scoped to the block that carried it.
 *
 * `FORBID_ATTR: ['style']` closes the other one (#436). The viewer used to strip
 * `style` on its own, in `document-render.ts`, which made TWO effective profiles
 * out of one constant — the exact drift §5.30 names as the reason the single
 * renderer is a requirement. It is settled HERE, for every surface, because:
 *
 *  - MARKDOWN CANNOT EMIT ONE. Every construct that looks like it might uses an
 *    attribute instead — GFM table alignment renders `align="right"`, not
 *    `style="text-align:right"` — and this app ships no syntax highlighter that
 *    writes colours inline. Nothing legitimate is lost; `markdown.test.tsx`
 *    renders the whole GFM surface and proves it.
 *  - SO AN INLINE STYLE IS ALWAYS RAW EMBEDDED MARKUP. Measured on the real
 *    corpus before choosing (2026-08-13): 7,553 captured transcripts, 57,700
 *    assistant text blocks, 93 MB of prose — SEVEN occurrences of `style`, all
 *    seven inside a code fence or code span, where `marked` escapes them to text
 *    and the sanitizer never sees an attribute at all. Bare in prose: zero.
 *  - AND IT IS LOAD-BEARING FOR THE VIEWER. `position:fixed;inset:0` from a file
 *    we did not write is a click-jack over the app's own chrome, and
 *    `display:none` is what hides the `<pre>` whose Copy button then puts
 *    something else on the clipboard. The feed is the same input class — an
 *    agent can be talked into emitting markup — so it gets the same answer.
 *  - AND IT FIGHTS THE THEME. `.feed-md` and `.doc-md` own how markdown looks;
 *    an inline `color:` outranks every one of their rules and survives a theme
 *    switch, so light-on-light is a thing a reply could do to itself.
 *
 * WHAT THIS DOES NOT CLOSE, so nobody reads the above as more than it is: the
 * html profile still allows the LEGACY PRESENTATIONAL attributes and tags —
 * `<font color size face>`, `<hr color size>`, `bgcolor`, `align`, `hidden`,
 * `<center>`, `<marquee>` — verified against DOMPurify 3.4.12, not assumed. So
 * "markdown can no longer colour itself" is FALSE; what is true is that it can
 * no longer do so through `style`, and can no longer POSITION itself (there is
 * no `position: fixed` rule anywhere in the renderer's CSS for a `class` to
 * borrow, and `class` does survive). The legacy set is #466.
 *
 * `decoration-guard.ts` still removes `style` in every surface's take-back pass,
 * and that is deliberate belt-and-braces for HTML that reaches a decoration pass
 * from anywhere but here — not a second profile. See the note in that file.
 *
 * `ALLOW_DATA_ATTR: false` closes the THIRD one, and it is the same argument one
 * step further out (#465). DOMPurify keeps every `data-*` attribute by default,
 * and this app's surfaces decorate with data attributes and then read them back
 * off the DOM as instructions: the viewer's `data-doc-*` (#410) and the feed's
 * `data-feed-expander` / `data-feed-seq` / `data-no-toggle` (#465). The DOM does
 * not remember who wrote an attribute, so a reply carrying a forged one is
 * giving the surface orders — it wedges the feed's arrow-key navigation on a
 * phantom expander, and captures a find jump, because `querySelector` answers
 * with the first match in document order and the forgery can sit above the real
 * block. MARKDOWN EMITS NO DATA ATTRIBUTES AT ALL — every `data-*` that reaches
 * a surface is therefore raw embedded markup, the input §5.30 says to distrust —
 * so nothing legitimate is lost, and the whole class of decoration forgery is
 * closed here, once, for surfaces that do not exist yet.
 *
 * It is the FIRST of two layers, not the only one: `decoration-guard.ts` is the
 * per-surface take-back, and it is what still covers `class` (which DOMPurify
 * keeps and no config flag filters by prefix) and any caller that builds HTML
 * without coming through this function. Consequence worth knowing before you
 * read a green test as proof: pipeline-level forgery tests that enter through
 * `renderMarkdown` now stay green even if a surface's guard is deleted, because
 * this line got there first. `decoration-guard.test.ts` and
 * `document-render.test.ts` therefore call the guard DIRECTLY, so removing it
 * still reds.
 *
 * Everything else is DOMPurify's default and deliberately so: its allow-list,
 * its `javascript:`-scheme refusal and its `on*`-attribute stripping are the
 * parts that get security review upstream, and re-deriving them here would mean
 * owning them here. What we choose is the PROFILE; what is safe inside it is
 * theirs.
 */
export const SANITIZE_CONFIG: SanitizeConfig = {
  USE_PROFILES: { html: true },
  FORBID_ATTR: ['style'],
  ALLOW_DATA_ATTR: false,
};

// FROZEN, because "one configuration" is this module's entire thesis and an
// exported mutable object is a second one waiting to be written at runtime:
// `SANITIZE_CONFIG.FORBID_ATTR.pop()` from anywhere in the renderer would
// re-open the hole for every surface at once, silently, with the source still
// reading exactly as it does here. The nested array and profile object are
// frozen too — freezing only the top level leaves the array mutable, which is
// where the policy actually lives.
//
// Frozen as statements rather than by wrapping the literal in `Object.freeze`
// so the declared type stays `SanitizeConfig`: DOMPurify's `FORBID_ATTR` is
// `string[]`, and a frozen literal infers `readonly string[]`, which would need
// a cast to assign. Runtime immutability, no cast.
Object.freeze(SANITIZE_CONFIG);
Object.freeze(SANITIZE_CONFIG.FORBID_ATTR);
Object.freeze(SANITIZE_CONFIG.USE_PROFILES);

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
 *
 * `decorate` is the surface's own pass over the sanitized HTML, run inside the
 * same `useMemo` (#465). The document viewer has had one since P2-E16-02
 * (`decorateDocument`) but does not render through this component; the feed's
 * (`decorateFeedMarkdown`) needs somewhere to hang, and this is the ONE place
 * a `<Markdown>` surface's HTML exists before it reaches the page.
 *
 * A surface that forgets to pass one is not thereby forgeable — `SANITIZE_CONFIG`
 * closes `data-*` for every surface whether it decorates or not, which is the
 * layer that does not depend on remembering. The pass is what a surface needs
 * once it decorates: it takes its OWN namespace back first (see
 * `decoration-guard.ts`), and only then writes its markup.
 */
export function Markdown({
  text,
  streaming,
  className = 'feed-md',
  decorate,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
  /** must be a stable module-level function — it is a `useMemo` dependency */
  decorate?: (html: string) => string;
}): React.JSX.Element {
  const html = React.useMemo(() => {
    if (streaming) return '';
    const sanitized = renderMarkdown(text);
    return decorate ? decorate(sanitized) : sanitized;
  }, [text, streaming, decorate]);
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
