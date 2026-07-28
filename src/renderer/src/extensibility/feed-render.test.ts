import { describe, it, expect } from 'vitest';
import { ContributionRegistry } from '../../../shared/extensibility/registry';
import { RendererContributions } from './contributions';
import { renderFeedBlock } from './feed-render';
import { FeedBlockDto } from '../lib/feed';

function block(over: Partial<FeedBlockDto> = {}): FeedBlockDto {
  return { seq: 1, kind: 'assistant', text: 'hi', ...over } as FeedBlockDto;
}

function renderer(id: string, order: number, matches: (b: FeedBlockDto) => boolean) {
  return {
    manifest: { id, displayName: id, version: '1.0.0', capabilities: ['feed.render'] },
    order,
    matches,
    render: () => id, // the id stands in for "this renderer produced the output"
  };
}

function withRenderers(...rs: ReturnType<typeof renderer>[]) {
  const r = new ContributionRegistry<RendererContributions>();
  for (const x of rs) r.register('feed-block-renderer', x);
  return r;
}

describe('renderFeedBlock', () => {
  it('takes the first match in ORDER, not registration order', () => {
    // registered late-first on purpose: the old ternary chain's precedence is
    // now carried by `order`, and nothing else must be able to imply it
    const reg = withRenderers(
      renderer('generic', 40, (b) => b.kind === 'tool'),
      renderer('specific', 20, (b) => b.kind === 'tool' && b.tool?.category === 'shell')
    );
    expect(renderFeedBlock(reg, block({ kind: 'tool', tool: { name: 'Bash', category: 'shell', summary: 'ls' } }))).toBe(
      'specific'
    );
    expect(renderFeedBlock(reg, block({ kind: 'tool', tool: { name: 'Read', summary: 'x.ts' } }))).toBe('generic');
  });

  it('a catch-all at a high order is the fallback, not a shadow', () => {
    const reg = withRenderers(
      renderer('fallback', 1000, () => true),
      renderer('todos', 10, (b) => b.kind === 'todos')
    );
    expect(renderFeedBlock(reg, block({ kind: 'todos' }))).toBe('todos');
    expect(renderFeedBlock(reg, block({ kind: 'assistant' }))).toBe('fallback');
  });

  it('a block nothing claims renders as nothing, not a crash', () => {
    const reg = withRenderers(renderer('todos', 10, (b) => b.kind === 'todos'));
    expect(renderFeedBlock(reg, block({ kind: 'assistant' }))).toBeNull();
  });

  it('a renderer that throws while MATCHING is skipped, and the rest still run', () => {
    const problems: string[] = [];
    const bad = {
      manifest: { id: 'bad', displayName: 'bad', version: '1.0.0', capabilities: [] },
      order: 5,
      matches: () => {
        throw new Error('boom');
      },
      render: () => 'bad',
    };
    const reg = new ContributionRegistry<RendererContributions>();
    reg.register('feed-block-renderer', bad);
    reg.register('feed-block-renderer', renderer('good', 10, () => true));
    expect(renderFeedBlock(reg, block(), (id) => problems.push(id))).toBe('good');
    expect(problems).toEqual(['bad']);
  });

  it('a renderer that throws while RENDERING does not fall through to another', () => {
    // it claimed the block; handing the same block to the next renderer would
    // show the user a block rendered by something that never matched it
    const problems: string[] = [];
    const reg = new ContributionRegistry<RendererContributions>();
    reg.register('feed-block-renderer', {
      manifest: { id: 'claims-then-throws', displayName: 'x', version: '1.0.0', capabilities: [] },
      order: 5,
      matches: () => true,
      render: () => {
        throw new Error('boom');
      },
    });
    reg.register('feed-block-renderer', renderer('next', 10, () => true));
    expect(renderFeedBlock(reg, block(), (id) => problems.push(id))).toBeNull();
    expect(problems).toEqual(['claims-then-throws']);
  });
});
