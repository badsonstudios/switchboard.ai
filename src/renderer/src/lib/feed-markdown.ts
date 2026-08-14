// The feed's pass over its own sanitized markdown (#465).
//
// The counterpart of `document-render.ts` for the Session view: everything here
// runs AFTER `renderMarkdown`, which owns `marked` and DOMPurify and which
// nothing else may import (`markdown.test.tsx` asserts it).
//
// TODAY IT DOES EXACTLY ONE THING — it takes the feed's own namespace back
// before anything writes one. That is the whole of #465, and the pass exists
// now, rather than arriving with the first decoration that needs it, because
// the ORDER is the security property: #410's forgery worked on the viewer
// precisely by arriving before the decoration pass and being mistaken for its
// output. A pass whose first line is the guard cannot get that order wrong; a
// decoration added to a surface that has no pass has to remember to invent one.
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

/**
 * Sanitized HTML in, decorated HTML out — the feed's surface pass.
 *
 * `doc` is injectable for the same reason the viewer's is: a test may build the
 * tree in a document that is not the page.
 */
export function decorateFeedMarkdown(html: string, doc: Document = document): string {
  const template = doc.createElement('template');
  template.innerHTML = html;
  // FIRST, before any decoration below writes one of ours.
  stripDecorationNamespace(template.content, FEED_DECORATION);
  return template.innerHTML;
}
