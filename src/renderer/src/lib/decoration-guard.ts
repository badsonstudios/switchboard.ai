// ONE guard for every decoration protocol in the renderer (#465, §5.29/§5.30).
//
// THE DECORATION IS A PROTOCOL, AND CONTENT WE DID NOT WRITE MUST NOT BE ABLE
// TO SPEAK IT.
//
// A surface that decorates sanitized HTML writes attributes and classes that
// its own handlers then read back as INSTRUCTIONS. The document viewer writes
// `data-doc-*` / `doc-*`; the feed writes `data-feed-*` and `data-no-toggle`.
// Both read them off the live DOM — `querySelectorAll`, `querySelector`,
// `closest` — and neither can tell "an attribute I wrote" from "an attribute
// that arrived in the input", because the DOM does not remember who wrote what.
//
// So content that arrives with the answers already filled in is giving the
// surface orders. #410 proved it on the viewer:
//
//   <a href="javascript:…" data-doc-external="https://exfil.test/?leak">click</a>
//
// — classified `blocked` and rendered inert by `decorateLinks`, and then opened
// in the browser anyway by the handler's earlier `[data-doc-external]` branch.
// The fix was never to reorder the handler's branches: it is that NO attribute
// in a surface's own namespace may survive from its input, and the take-back
// must run FIRST, before anything writes one.
//
// THIS FILE EXISTS BECAUSE THAT FIX WAS WRITTEN ONCE, FOR ONE SURFACE, AND THE
// NEXT SURFACE DID NOT GET IT. `stripOurNamespace` lived in `document-render.ts`
// with the whole justification in its comment, and the feed — same input class,
// same DOM-as-protocol design, three handlers reading three forgeable
// attributes — had no equivalent pass at all (#465, found by #436's worker).
// One guard, parameterized by namespace, is the shape that makes the next
// surface's version a two-line constant instead of a rediscovery.
//
// It is the SECOND of two layers, and deliberately so:
//
//  1. `markdown.tsx`'s `SANITIZE_CONFIG` sets `ALLOW_DATA_ATTR: false`, so no
//     `data-*` reaches any surface at all. That is the layer that closes the
//     class of bug, because it cannot be forgotten by a surface that never
//     calls this function.
//  2. This one assumes nothing about where its input has been. It takes the
//     classes too (which DOMPurify keeps and no config flag filters by prefix),
//     and it protects a surface that builds HTML some way other than through
//     `renderMarkdown`.

/** One surface's DOM protocol: what it writes, and therefore what it takes back. */
export interface DecorationNamespace {
  /** the surface, for the tests and for whoever reads a stack trace */
  readonly label: string;
  /** attributes whose NAME starts with one of these */
  readonly attrPrefixes: readonly string[];
  /** attributes taken back by exact name — a protocol member outside the prefix */
  readonly attrs: readonly string[];
  /** classes whose name starts with one of these */
  readonly classPrefixes: readonly string[];
}

function ns(v: DecorationNamespace): DecorationNamespace {
  // Frozen for the reason `SANITIZE_CONFIG` is (#436): a security constant that
  // any renderer module could `push` to at runtime is a second policy waiting to
  // be written, with the source still reading exactly as it does here.
  Object.freeze(v.attrPrefixes);
  Object.freeze(v.attrs);
  Object.freeze(v.classPrefixes);
  return Object.freeze(v);
}

/**
 * The document viewer's protocol (§5.30) — `document-render.ts` writes it and
 * `DocumentViewer.tsx`'s click/key handlers read it.
 *
 * `data-doc` rather than `data-doc-`: the prefix is the namespace, and a bare
 * `data-doc` is as much ours as `data-doc-copy` is.
 */
export const DOC_DECORATION = ns({
  label: 'document viewer',
  attrPrefixes: ['data-doc'],
  attrs: [],
  classPrefixes: ['doc-'],
});

/**
 * The feed's protocol (§5.10, §5.32) — the block renderers write it and
 * `FeedView` reads it back off the DOM.
 *
 * `data-no-toggle` is the one member outside the prefix: it is `ToolBox`'s
 * stand-down mark (`closest('[data-no-toggle]')`), and it is as much part of
 * the feed's protocol as the rest. `feed-` covers the class half — the feed has
 * only `.feed-md` today and it is applied by React, outside the sanitized HTML,
 * but the guard's whole job is to be the answer BEFORE the surface needs one.
 */
export const FEED_DECORATION = ns({
  label: 'feed',
  attrPrefixes: ['data-feed'],
  attrs: ['data-no-toggle'],
  classPrefixes: ['feed-'],
});

/**
 * Take back everything in `namespace` — plus `style`, always.
 *
 * `style` is not part of any surface's protocol; it is here because this
 * function's job is to assume nothing about where its input has been, and
 * `style` is the attribute that makes a forgery INVISIBLE (`display:none` on
 * the `<pre>` whose Copy button then puts something else on the clipboard) and
 * makes it a click-jack (`position:fixed;inset:0` over the app's own chrome).
 * The policy lives in `markdown.tsx`'s `FORBID_ATTR` (#436); this is
 * the belt to that pair of braces, and dropping it here would make `style` the
 * one attribute in this list whose safety is somebody else's file.
 *
 * Runs on an INERT tree (a `<template>`'s content), never on the live page —
 * see the note at the top of `document-render.ts` for why that matters.
 */
export function stripDecorationNamespace(root: ParentNode, namespace: DecorationNamespace): void {
  const { attrPrefixes, attrs, classPrefixes } = namespace;
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name;
      if (
        name === 'style' ||
        attrs.includes(name) ||
        attrPrefixes.some((prefix) => name.startsWith(prefix))
      ) {
        el.removeAttribute(name);
      }
    }
    for (const cls of [...el.classList]) {
      if (classPrefixes.some((prefix) => cls.startsWith(prefix))) el.classList.remove(cls);
    }
  }
}
