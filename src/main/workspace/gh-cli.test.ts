// The gh wrapper (#1638) with a stand-in runner: what it asks gh, and how it
// reads the answers. Nothing here runs the real `gh`.
import { describe, it, expect } from 'vitest';
import { createPr, ghSaid, prsForBranch, type GhRun, type GhRunner } from './gh-cli';

function runner(answer: (args: string[]) => GhRun): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    gh: async (args) => {
      calls.push(args);
      return answer(args);
    },
  };
}

describe('prsForBranch', () => {
  it('asks for every state of the branch and keeps only well-formed https PRs, newest first', async () => {
    const { gh, calls } = runner(() => ({
      ok: true,
      err: '',
      out: JSON.stringify([
        { number: 2, url: 'https://github.com/o/r/pull/2', state: 'MERGED', isDraft: false },
        { number: 5, url: 'https://github.com/o/r/pull/5', state: 'OPEN', isDraft: true },
        { number: 6, url: 'javascript:alert(1)', state: 'OPEN' },
        { number: 'x', url: 'https://github.com/o/r/pull/9', state: 'OPEN' },
      ]),
    }));
    const r = await prsForBranch(gh, '/repo', 'feat/x');
    expect(calls[0]).toEqual(['pr', 'list', '--head', 'feat/x', '--state', 'all', '--limit', '20', '--json', 'number,url,state,isDraft']);
    expect(r).toEqual({
      prs: [
        { number: 5, url: 'https://github.com/o/r/pull/5', state: 'OPEN', draft: true },
        { number: 2, url: 'https://github.com/o/r/pull/2', state: 'MERGED', draft: false },
      ],
    });
  });

  it('passes on why gh could not answer', async () => {
    const { gh } = runner(() => ({ ok: false, out: '', err: 'error connecting to api.github.com\n', failure: 'failed' }));
    expect(await prsForBranch(gh, '/repo', 'b')).toEqual({ failure: 'failed', detail: 'error connecting to api.github.com' });
    const bad = runner(() => ({ ok: true, out: 'not json', err: '' }));
    expect(await prsForBranch(bad.gh, '/repo', 'b')).toMatchObject({ failure: 'failed' });
  });
});

describe('createPr', () => {
  it('falls back to the URL gh printed when the read-back cannot find it', async () => {
    const { gh } = runner((args) =>
      args[1] === 'create'
        ? { ok: true, out: 'Creating pull request…\nhttps://github.com/o/r/pull/12\n', err: '' }
        : { ok: false, out: '', err: 'rate limited', failure: 'failed' }
    );
    const r = await createPr(gh, '/repo', { branch: 'b', base: 'main', title: 't', body: '', draft: false });
    expect(r).toEqual({ pr: { number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN', draft: false } });
  });

  it('says why gh refused', async () => {
    const { gh } = runner(() => ({ ok: false, out: '', err: 'a pull request for branch "b" into branch "main" already exists', failure: 'failed' }));
    const r = await createPr(gh, '/repo', { branch: 'b', base: 'main', title: 't', body: '', draft: false });
    expect(r).toMatchObject({ failure: 'failed' });
    expect('detail' in r ? r.detail : '').toContain('already exists');
  });
});

describe('ghSaid', () => {
  it('is the last non-empty line, bounded', () => {
    expect(ghSaid({ ok: false, out: '', err: 'one\n\ntwo  \n' })).toBe('two');
    expect(ghSaid({ ok: false, out: '', err: 'x'.repeat(1000) })).toHaveLength(300);
  });
});
