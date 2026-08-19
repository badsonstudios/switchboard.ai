// Resolving a transcript block to its renderer (P2-E15-03).
//
// Pure and separate from FeedView so the ordering rule — and what happens when
// nothing matches — are testable without mounting a component.
import type React from 'react';
import { FeedBlockDto } from '../lib/feed';
import { FeedBlockRendererContribution } from './contributions';
import { RendererRegistry } from './registry-instance';

// The feed re-renders on every streamed chunk and calls this once per visible
// block, so sorting the renderer list per block per frame is real work where
// the old ternary was a handful of comparisons. Cached per registry, keyed on
// the list length so a late registration still invalidates it.
const sortedCache = new WeakMap<object, { size: number; ordered: FeedBlockRendererContribution[] }>();

function orderedRenderers(registry: RendererRegistry): FeedBlockRendererContribution[] {
  const all = registry.list('feed-block-renderer');
  const hit = sortedCache.get(registry);
  if (hit && hit.size === all.length) return hit.ordered;
  const ordered = [...all].sort((a, b) => a.order - b.order);
  sortedCache.set(registry, { size: all.length, ordered });
  return ordered;
}

/**
 * First registered renderer whose `matches()` accepts the block, in `order`.
 *
 * FAIL-OPEN, like every other seam: a renderer that throws while deciding is
 * skipped rather than taking the whole feed down, and a block nothing claims
 * renders as nothing rather than crashing the view. The built-in markdown
 * renderer matches everything at order 1000, so "nothing claimed it" only
 * happens if that contribution is removed — but a transcript is untrusted
 * input from another process, and this is the last place we want a throw.
 */
export function renderFeedBlock(
  registry: RendererRegistry,
  block: FeedBlockDto,
  onError: (id: string, err: unknown) => void = defaultReport
): React.ReactNode {
  return resolveFeedBlock(registry, block, onError).node;
}

/** Which contribution claimed a block, and what it produced. */
export interface ResolvedFeedBlock {
  /**
   * Null ONLY when nothing claimed the block (then `node` is null too). A
   * renderer that claimed it and threw while building still reports its id, so
   * the id a given block resolves to is stable across renders even while that
   * renderer is failing — `ContributionBoundary` reads a changed id as a
   * different contribution and clears its failure streak, which a flip-flopping
   * id would turn into an unbounded retry loop.
   */
  id: string | null;
  node: React.ReactNode;
}

/**
 * `renderFeedBlock`, plus the name of whoever produced the output.
 *
 * The try/catch below only covers BUILDING the node — the renderer function
 * returning. A returned ELEMENT that throws when React renders it escapes
 * every try/catch in this file, because React is the caller and none of this
 * is on the stack; with no error boundary above the feed that white-screens
 * the window — every session's terminal, over one malformed block. That is the
 * fail-open violation `ContributionBoundary` exists to stop, and the boundary
 * names the contribution in its log line, which is the id `renderFeedBlock`
 * throws away. `FeedView`'s `Block` is the caller that needs both (#594).
 */
export function resolveFeedBlock(
  registry: RendererRegistry,
  block: FeedBlockDto,
  onError: (id: string, err: unknown) => void = defaultReport
): ResolvedFeedBlock {
  const ordered = orderedRenderers(registry);
  for (const r of ordered) {
    let claimed = false;
    try {
      claimed = r.matches(block);
    } catch (err) {
      onError(r.manifest.id, err);
      continue;
    }
    if (!claimed) continue;
    try {
      return { id: r.manifest.id, node: r.render(block) };
    } catch (err) {
      onError(r.manifest.id, err);
      // it claimed the block and failed — don't hand it to another
      return { id: r.manifest.id, node: null };
    }
  }
  return { id: null, node: null };
}

function defaultReport(id: string, err: unknown): void {
  console.error(`[feed] block renderer "${id}" threw`, err);
}
