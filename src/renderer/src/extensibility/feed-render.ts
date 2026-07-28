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
      return r.render(block);
    } catch (err) {
      onError(r.manifest.id, err);
      return null; // it claimed the block and failed — don't hand it to another
    }
  }
  return null;
}

function defaultReport(id: string, err: unknown): void {
  console.error(`[feed] block renderer "${id}" threw`, err);
}
