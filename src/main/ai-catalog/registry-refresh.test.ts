// "Check for new AIs" (#1291): the diff, and the fetch against FIXTURES. No
// test here reaches the network: every `checkRegistry` gets a fake fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RegistryAgent } from '../../shared/ais';
import { REGISTRY_URL } from './catalog';
import { checkRegistry, diffRegistry, lastRegistryCheck, parseRegistry, readRegistryAgent, REGISTRY_CHECK_FILE } from './registry-refresh';

const a = (id: string, version = '1.0.0'): RegistryAgent => ({ id, name: id.toUpperCase(), version, distributions: ['npx'] });

const FIXTURE = {
  version: '1.0.0',
  agents: [
    {
      id: 'gemini',
      name: 'Gemini CLI',
      version: '0.65.0',
      description: "Google's official CLI for Gemini",
      authors: ['Google'],
      license: 'Apache-2.0',
      distribution: { npx: { package: '@google/gemini-cli@0.65.0', args: ['--acp'] } },
    },
    {
      id: 'brand-new',
      name: 'Brand New',
      version: '0.1.0',
      authors: ['Someone <a@b.c>'],
      distribution: { binary: {}, npx: { package: 'x' } },
    },
    { id: 'broken' },
  ],
};

function fakeFetch(body: string, status = 200) {
  return vi.fn(() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-registry-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reading the registry', () => {
  it('trims an agent to what the list and the diff need', () => {
    expect(readRegistryAgent(FIXTURE.agents[1])).toEqual({
      id: 'brand-new',
      name: 'Brand New',
      version: '0.1.0',
      maker: 'Someone',
      distributions: ['binary', 'npx'],
    });
    expect(readRegistryAgent({ id: 'x' })).toBeNull();
  });

  it('skips what is not an agent, and rejects what is not a registry', () => {
    expect(parseRegistry(FIXTURE)?.map((x) => x.id)).toEqual(['gemini', 'brand-new']);
    expect(parseRegistry({ agents: 'no' })).toBeNull();
    expect(parseRegistry(null)).toBeNull();
  });
});

describe('diffRegistry', () => {
  it('added, changed (version), removed', () => {
    const shipped = [a('gemini', '0.64.0'), a('goose', '1.54.0'), a('gone')];
    const fetched = [a('gemini', '0.65.0'), a('goose', '1.54.0'), a('brand-new')];
    expect(diffRegistry(shipped, fetched)).toEqual({
      added: [a('brand-new')],
      changed: [{ id: 'gemini', name: 'GEMINI', from: '0.64.0', to: '0.65.0' }],
      removed: [{ id: 'gone', name: 'GONE' }],
    });
  });

  it('the same list is no difference', () => {
    expect(diffRegistry([a('x')], [a('x')])).toEqual({ added: [], changed: [], removed: [] });
  });
});

describe('checkRegistry (user-pressed)', () => {
  it('fetches the registry URL once, diffs against the shipped snapshot, and caches the diff', async () => {
    const fetchImpl = fakeFetch(JSON.stringify(FIXTURE));
    const r = await checkRegistry({ userDataDir: dir, fetchImpl, now: () => 1234, shipped: [a('gemini', '0.64.0'), a('goose')] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe(REGISTRY_URL);
    expect(r).toMatchObject({ ok: true, fetchedAt: 1234, total: 2 });
    if (!r.ok) throw new Error('unreachable');
    expect(r.diff.added.map((x) => x.id)).toEqual(['brand-new']);
    expect(r.diff.changed).toEqual([{ id: 'gemini', name: 'Gemini CLI', from: '0.64.0', to: '0.65.0' }]);
    expect(r.diff.removed).toEqual([{ id: 'goose', name: 'GOOSE' }]);
    // the cache holds the diff, and reading it back touches no network
    expect(fs.existsSync(path.join(dir, REGISTRY_CHECK_FILE))).toBe(true);
    expect(lastRegistryCheck({ userDataDir: dir })).toEqual(r);
  });

  it('against the REAL shipped snapshot, the fixture shows Gemini’s new version', async () => {
    const r = await checkRegistry({ userDataDir: dir, fetchImpl: fakeFetch(JSON.stringify(FIXTURE)) });
    if (!r.ok) throw new Error(r.error);
    expect(r.diff.changed).toContainEqual({ id: 'gemini', name: 'Gemini CLI', from: '0.64.0', to: '0.65.0' });
    expect(r.diff.removed.length).toBe(41); // the fixture has two of the 42
  });

  it.each([
    ['a server error', fakeFetch('oops', 503), /answered 503/],
    ['not JSON', fakeFetch('<html>'), /not a registry/],
    ['JSON that is not a registry', fakeFetch('{"agents":3}'), /not a registry/],
    ['a network failure', vi.fn(() => Promise.reject(new Error('ENOTFOUND'))) as unknown as typeof fetch, /could not reach the registry: Error: ENOTFOUND/],
  ])('%s is a plain answer, and nothing is cached', async (_what, fetchImpl, why) => {
    const r = await checkRegistry({ userDataDir: dir, fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(why);
    expect(lastRegistryCheck({ userDataDir: dir })).toBeNull();
  });

  it('a registry that does not answer in time is aborted', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))
    ) as unknown as typeof fetch;
    const r = await checkRegistry({ userDataDir: dir, fetchImpl, timeoutMs: 20 });
    expect(r).toEqual({ ok: false, error: 'the registry did not answer in time' });
  });

  it('an unreadable cache is no cache', () => {
    fs.writeFileSync(path.join(dir, REGISTRY_CHECK_FILE), '{nope');
    expect(lastRegistryCheck({ userDataDir: dir })).toBeNull();
  });
});
