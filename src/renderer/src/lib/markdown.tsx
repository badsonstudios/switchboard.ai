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
 * `style` in `FORBID_ATTR` closes the other one (#436). The viewer used to strip
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
 * `ALLOW_ARIA_ATTR: false` plus `role` in `FORBID_ATTR` closes the FOURTH, and
 * it is the accessibility half of the same argument (#509). DOMPurify keeps
 * every `aria-*` attribute by default — `ALLOW_ARIA_ATTR` defaults to `true` —
 * and `role` is not covered by that flag at all: it is an ordinary member of the
 * html profile's attribute allow-list, so turning the flag off and stopping
 * there would drop `aria-label` and keep `role="alert"`. Both go, and they go
 * together, because they are ONE decision: WAI-ARIA is what a screen reader
 * reads, and `role` is the half of it with teeth.
 *
 * ANNOUNCED, BUT NEVER OBEYED. Nothing in this app acts on ARIA that arrived in
 * content. There is no live region wired to authored markup, no focus manager
 * reading an authored `aria-controls`, and — since `ALLOW_DATA_ATTR: false` —
 * no interactive semantics that survive at all. So an authored `aria-*` reached
 * exactly one audience: the screen reader, which announced it as though the app
 * meant it. That is a channel that exists FOR AT USERS ONLY, and every payload
 * on it is a lie the sighted reader cannot see:
 *
 *  - `aria-live="assertive"` on a reply is a region that interrupts whatever the
 *    user was being told, on content's own schedule — including the app's own
 *    `role="status"` announcements (§5.10's feed, the approval bar), which it
 *    can talk over.
 *  - `aria-label` on visible text REPLACES that text in the accessible name. A
 *    `<span aria-label="Cancel">Approve</span>` reads as the opposite of what is
 *    on screen, which is the approvals surface's whole trust model inverted for
 *    one class of user.
 *  - `aria-hidden="true"` removes real content from the accessibility tree
 *    entirely — the sighted reader sees `rm -rf /`, the screen-reader user is
 *    told nothing is there. `role="presentation"` does the same to a table.
 *  - `role="link"` is not merely announced: `DocumentViewer.tsx` reads it back
 *    off the live DOM in its keydown handler (`getAttribute('role') === 'link'`
 *    gates Enter/Space activation), because `decorateLinks` writes it to put the
 *    affordance back on links whose `href` it removed. That is the #410 shape
 *    exactly — a surface's own protocol, speakable by its input — and it is the
 *    reason `role` could not be left as "harmless noise".
 *
 * MARKDOWN EMITS NEITHER. Not one construct in GFM produces an `aria-*` or a
 * `role`; the accessible structure of rendered markdown comes from the TAGS
 * (`<table>`, `<h1>`, `<ul>`), which is exactly where it belongs. So every one
 * that reaches a surface is raw embedded markup. Measured the same way #436
 * measured `style`, on the same machine's corpus (2026-08-19): 7,475 captured
 * transcripts, 17,908 assistant text blocks, 10 MB of prose — 39 occurrences of
 * `aria-*=` and 92 of `role=`, and NOT ONE of them was an attribute on a tag.
 * All 39 aria hits and 91 of the role hits were inside a code fence or code
 * span, where `marked` escapes them to text and the sanitizer never sees an
 * attribute; the 92nd was prose ABOUT a dialog ("`AboutPanel` (role=dialog,
 * Escape/click-away…)"), which is likewise text. Bare on a tag: zero.
 *
 * WHAT STILL CARRIES ARIA, and this is the part worth knowing before reading a
 * screen reader's output: everything the surfaces write themselves. The
 * decoration passes run AFTER this function — `decorateLinks`' `role="link"`,
 * `decorateTables`' `role="group"`, `decorateImages`' `aria-hidden` icon,
 * `decorateFeedCodeFences`' `aria-label` on the Copy button — and React writes
 * the chrome's own. The rule this line establishes is therefore not "rendered
 * content has no ARIA"; it is that EVERY piece of ARIA in a rendered surface is
 * ours. `decoration-guard.ts` does NOT take these back (they are not in any
 * surface's `data-`/class namespace), so unlike `data-*` this has no second
 * layer: the profile is the whole policy, which is why its test block is
 * profile-level and why a surface that renders markdown some other way is
 * caught by the surface table in the `style` block rather than by a guard.
 *
 * NOT closed here, so this is not read as more than it is: `hidden` and the rest
 * of the legacy presentational set are #466's, and `hidden` has an accessibility
 * edge of its own. `tabindex` also survives the html profile — authored content
 * can still put itself in the keyboard tab order, which is a focus-order
 * nuisance rather than a forgery now that `role` is gone, and it is not this
 * item's scope. Neither was widened here; both are named so the next reader
 * knows they were seen and left.
 *
 * Everything else is DOMPurify's default and deliberately so: its allow-list,
 * its `javascript:`-scheme refusal and its `on*`-attribute stripping are the
 * parts that get security review upstream, and re-deriving them here would mean
 * owning them here. What we choose is the PROFILE; what is safe inside it is
 * theirs.
 */
export const SANITIZE_CONFIG: SanitizeConfig = {
  USE_PROFILES: { html: true },
  // `role` rides in `FORBID_ATTR` rather than in a flag because no flag covers
  // it: it is in the html profile's allow-list, and `ALLOW_ARIA_ATTR` governs
  // only the `aria-*` pattern. `FORBID_ATTR` is checked FIRST in DOMPurify
  // 3.4.12 (`_isValidAttribute`), ahead of both the allow-list and the aria
  // branch, so this wins wherever the two could disagree — verified against the
  // shipped source, not assumed.
  FORBID_ATTR: ['style', 'role'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
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
