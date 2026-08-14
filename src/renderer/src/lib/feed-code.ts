// The copy affordance on code in the Session view (P2-E10-11, #477).
//
// Dan, 2026-08-13: "whenever session output contains code — fenced code blocks
// in assistant prose, Bash blocks' IN/OUT sections — show a small copy button
// at the right, like VS Code: one click copies that code to the clipboard."
//
// ONE AFFORDANCE, NOT A SECOND STYLE. The document viewer has shipped exactly
// this since P2-E16-02 (`document-render.ts` → `decorateCodeFences`): a header
// strip above the fence carrying the language on the left and a Copy button on
// the right, always visible rather than hover-revealed. The feed gets the same
// shape, the same words and the same "Copied" flash, in the feed's own type
// scale — `.feed-code*` in tokens.css mirrors `.doc-code*`. What is deliberately
// NOT shared is the markup-writing code itself: the two surfaces have different
// namespaces (that is #465's whole point) and different type, so what is shared
// is the DECISION and the behaviour, which live here.
//
// THE TWO ENTRY POINTS ARE DIFFERENT BY NECESSITY, and the shape below is what
// keeps them one affordance anyway:
//
//  - fenced code in assistant prose is sanitized HTML, so its button is written
//    into the DOM by `decorateFeedCodeFences` and answered by a DELEGATED click
//    handler, which reads the code back off the `<pre>` at click time;
//  - a Bash IN/OUT section is a React component, so its button is a React
//    `<button>` with the text already in hand.
//
// Both mark themselves `FEED_COPY_ATTR` (so the arrow keys reach them — see
// `feed-keys.ts`), both wrap their code in `[data-feed-code]`, and both flash
// through `runCopy`.
import { FEED_COPY_ATTR } from './feed-keys';

/** Copy this module holds no English of its own. */
export interface FeedCodeLabels {
  /** the button's word — "Copy" */
  copy: string;
  /** what it says for a moment after a click — "Copied" */
  copied: string;
  /** the accessible name, because "Copy" alone does not say copy WHAT (§5.32) */
  copyCode: string;
}

/**
 * The container a copy button reads its code out of.
 *
 * An attribute rather than the `.feed-code` class the styling uses: `class`
 * survives the sanitizer and `data-*` no longer does (#465), so this is the
 * half of the pair that content cannot forge. The viewer resolves the same
 * relationship through `.doc-code`, which is why #410 had to strip `doc-`
 * classes to close it.
 */
export const FEED_CODE_ATTR = 'data-feed-code';

/** How long the button says "Copied" — the viewer's number, so both agree. */
export const COPIED_MS = 1200;

/**
 * Fenced code gets a header: the language, and a copy button.
 *
 * Mirrors `decorateCodeFences` (§5.30) including the reason its button carries
 * no copy of the code: the handler reads the `<pre>` at the moment of the
 * click, so a re-render can never leave a button copying a stale snippet.
 *
 * MUST run after `stripDecorationNamespace` — see `feed-markdown.ts`. Every
 * `<pre>` in the sanitized HTML is wrapped, forged wrapper or not, because the
 * guard has already removed anything that claimed to be one of ours.
 */
export function decorateFeedCodeFences(root: ParentNode, labels: FeedCodeLabels): void {
  for (const pre of [...root.querySelectorAll('pre')]) {
    const doc = pre.ownerDocument;
    const wrap = doc.createElement('div');
    wrap.className = 'feed-code';
    wrap.setAttribute(FEED_CODE_ATTR, '');
    const head = doc.createElement('div');
    head.className = 'feed-code-head';
    const lang = doc.createElement('span');
    lang.className = 'feed-code-lang';
    lang.textContent = fenceLanguage(pre.querySelector('code'));
    const copy = doc.createElement('button');
    copy.type = 'button';
    copy.className = 'feed-code-copy';
    copy.textContent = labels.copy;
    copy.setAttribute('aria-label', labels.copyCode);
    copy.setAttribute(FEED_COPY_ATTR, '');
    // the conversation is one tab stop and the arrows move inside it (#174)
    copy.setAttribute('tabindex', '-1');
    head.append(lang, copy);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}

/**
 * The language of a fence, from the class `marked` writes (`language-ts`).
 *
 * The viewer's `fenceLanguage` says the same thing; it is four lines and it
 * lives in a module the feed has no other reason to import — `document-render.ts`
 * is the VIEWER's decoration layer, and one surface importing the other's is
 * how two surfaces become one tangle.
 */
export function fenceLanguage(code: Element | null): string {
  if (!code) return '';
  for (const cls of code.classList) {
    if (cls.startsWith('language-')) return cls.slice('language-'.length);
  }
  return '';
}

/**
 * The code a rendered copy button is FOR, read at click time.
 *
 * `null` when the button is not inside one of our wrappers — which is not a
 * defensive nicety: it is what a copy button that survived some future
 * decoration change does instead of putting the wrong thing on the clipboard.
 */
export function codeForCopyButton(button: Element): string | null {
  const pre = button.closest(`[${FEED_CODE_ATTR}]`)?.querySelector('pre');
  return pre ? (pre.textContent ?? '') : null;
}

/**
 * Put `text` on the clipboard and flash the button.
 *
 * THE WINDOW COMES FROM THE BUTTON, not from the module's `window`, and that is
 * the popped-out card working (§5.14). dockview moves a group's DOM into a
 * separate `popout.html` window while the JavaScript keeps running in the main
 * renderer's context — so the bare `navigator` here is the MAIN window's, whose
 * document is not the focused one when the user clicks in the popout, and
 * `writeText` rejects on an unfocused document. Reading the clipboard off the
 * button's own document targets the window the click actually happened in.
 *
 * Failure is swallowed on purpose (fail-open, PHILOSOPHY §3): a clipboard the
 * platform refused is not a reason to throw inside a click handler in the middle
 * of a conversation. The button simply does not flash.
 */
export function runCopy(button: HTMLElement, text: string, copiedLabel: string): void {
  const view = button.ownerDocument.defaultView;
  void view?.navigator?.clipboard?.writeText(text).catch(() => {});
  const before = button.textContent;
  button.textContent = copiedLabel;
  view?.setTimeout(() => {
    // the block may have streamed away, collapsed or re-rendered underneath us
    if (button.isConnected) button.textContent = before;
  }, COPIED_MS);
}
