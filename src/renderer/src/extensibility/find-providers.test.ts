// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ContributionRegistry } from '../../../shared/extensibility/registry';
import type { FindSurface, RendererContributions } from './contributions';
import { manifestFor } from './contributions';
import type { RendererRegistry } from './registry-instance';
import { registerBuiltinContributions } from '../bootstrap';
import {
  changesFindProvider,
  findProviderFor,
  findUnavailableKey,
  hitsFromTranscript,
  listFindProviders,
  sessionFindProvider,
} from './find-providers';
import type { TranscriptSearchResult } from '../../../shared/transcripts';

function fresh(): RendererRegistry {
  const r = new ContributionRegistry<RendererContributions>();
  registerBuiltinContributions(r);
  return r;
}

function result(over: Partial<TranscriptSearchResult> = {}): TranscriptSearchResult {
  return {
    hits: [],
    total: 0,
    truncated: false,
    groups: [{ sessionId: 's1', hits: 0, blocks: 10, searched: true, aligned: true }],
    elapsedMs: 1,
    longestBlockMs: 1,
    ...over,
  };
}

function hit(over: Partial<TranscriptSearchResult['hits'][number]> = {}): TranscriptSearchResult['hits'][number] {
  return {
    sessionId: 's1',
    blockIndex: 12,
    seq: 12,
    earlierThanLoaded: false,
    kind: 'tool',
    field: 'tool.out',
    snippet: 'npm ERR! ENOENT no such file',
    matchStart: 9,
    matchLength: 6,
    ...over,
  };
}

describe('the find-provider point (P2-E17-02, §5.23)', () => {
  it('registers the three-of-four shipped registrants', () => {
    const ids = listFindProviders(fresh()).map((p) => p.manifest.id);
    expect(ids).toEqual(['find-session', 'find-changes']);
  });

  it('resolves a provider BY PANEL, which is how one Ctrl+F serves every view', () => {
    const r = fresh();
    expect(findProviderFor(r, 'feed')?.manifest.id).toBe('find-session');
    expect(findProviderFor(r, 'diff')?.manifest.id).toBe('find-changes');
  });

  it('answers null for a panel with no provider — the greyed bar’s input', () => {
    // Both are REAL cases today: History is a placeholder, and the Terminal's
    // provider is E17-03's item. §5.31 says the bar greys with a reason rather
    // than silently searching the wrong surface.
    const r = fresh();
    expect(findProviderFor(r, 'terminal')).toBeNull();
    expect(findProviderFor(r, 'history')).toBeNull();
  });

  it('takes a new provider with no edit to any consumer (the point is real)', () => {
    const r = fresh();
    r.register('find-provider', {
      manifest: manifestFor('find-invented', 'Invented', 'find.provide'),
      panelId: 'invented',
      labelKey: 'x',
      order: 5,
      mode: 'bar',
      unavailableKey: () => null,
    });
    expect(findProviderFor(r, 'invented')?.manifest.id).toBe('find-invented');
    expect(listFindProviders(r)[0].manifest.id).toBe('find-invented'); // order respected
  });

  it('a provider whose unavailableKey() THROWS greys the bar instead of taking the window down', () => {
    const thrower = {
      manifest: manifestFor('find-bad', 'Bad', 'find.provide'),
      panelId: 'bad',
      labelKey: 'x',
      order: 1,
      mode: 'bar' as const,
      unavailableKey: (): string | null => {
        throw new Error('boom');
      },
    };
    expect(findUnavailableKey(thrower, { sessionId: 's1', surface: null })).toBe('find.unavailable.failed');
  });
});

describe('the Session view provider (the E17-01 engine behind the bar)', () => {
  beforeEach(() => {
    (window as unknown as { switchboard: unknown }).switchboard = {
      transcripts: { search: vi.fn().mockResolvedValue(result()) },
    };
  });

  it('searches EXACTLY ONE session — the focused card’s', async () => {
    // §5.31's load-bearing done-when. `webContents.findInPage` searches the
    // whole webContents and would match the other three cards on screen; the
    // scope here is a list of one, built from the context the bar was handed.
    await sessionFindProvider.search?.({ sessionId: 's1', cardId: 'c1', surface: null }, { term: 'x' });
    const call = (window.switchboard.transcripts.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.sessionIds).toEqual(['s1']);
  });

  it('passes the case and whole-word options through, and never asks for regex', () => {
    // Deliberate: E17-01 measured a backtracking pattern holding the MAIN
    // thread for 146 seconds, and its header names moving the scan to a
    // terminable worker as the condition for exposing the switch.
    void sessionFindProvider.search?.(
      { sessionId: 's1', surface: null },
      { term: 'x', caseSensitive: true, wholeWord: true },
    );
    const call = (window.switchboard.transcripts.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.query).toEqual({ term: 'x', caseSensitive: true, wholeWord: true });
    expect(call.query.regex).toBeUndefined();
  });

  it('reports a search that could not run, rather than reporting no matches', async () => {
    // A refused IPC call RESOLVES with a branded refusal (shared/ipc/refusal),
    // so "not the shape we asked for" must never be read as "nothing found".
    (window.switchboard.transcripts.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      __ipcRefused: true,
    });
    const res = await sessionFindProvider.search?.({ sessionId: 's1', surface: null }, { term: 'x' });
    expect(res?.notice).toEqual({ key: 'find.notice.failed', tone: 'error' });
    expect(res?.total).toBe(0);
  });

  it('jumps through the mounted feed’s surface, and only for a hit that HAS a seq', () => {
    const jumpTo = vi.fn().mockReturnValue(true);
    const ctx = { sessionId: 's1', surface: { kind: 'feed', jumpTo, clear: vi.fn() } };
    const jumpable = hitsFromTranscript(result({ hits: [hit({ seq: 12 })] }), 's1').hits[0];
    const evicted = hitsFromTranscript(
      result({ hits: [hit({ seq: undefined, earlierThanLoaded: true })] }),
      's1',
    ).hits[0];

    expect(sessionFindProvider.reveal?.(ctx, jumpable)).toBe(true);
    expect(jumpTo).toHaveBeenCalledWith(12);
    expect(sessionFindProvider.reveal?.(ctx, evicted)).toBe(false);
    expect(jumpTo).toHaveBeenCalledTimes(1);
  });

  it('reveals nothing when the panel has not published a surface', () => {
    const h = hitsFromTranscript(result({ hits: [hit()] }), 's1').hits[0];
    expect(sessionFindProvider.reveal?.({ sessionId: 's1', surface: null }, h)).toBe(false);
  });
});

describe('mapping the engine’s answer into the bar’s vocabulary', () => {
  it('a hit with a seq is jump-to-able; one without is not', () => {
    const res = hitsFromTranscript(result({ hits: [hit({ seq: 4 }), hit({ seq: undefined })] }), 's1');
    expect(res.hits.map((h) => h.jumpable)).toEqual([true, false]);
  });

  it('reads "cannot jump" off the MISSING SEQ, not off earlierThanLoaded', () => {
    // E17-01's contract, and the trap it warns about: a hit can be
    // un-jumpable for three different reasons and only ONE of them is
    // "earlier in the session". Marking the others would be a confident lie
    // about where the user is standing.
    const newerThanDrained = hitsFromTranscript(
      result({ hits: [hit({ seq: undefined, earlierThanLoaded: false })] }),
      's1',
    ).hits[0];
    expect(newerThanDrained.jumpable).toBe(false);
    expect(newerThanDrained.earlierThanLoaded).toBe(false);
  });

  it('counts the session’s TOTAL, not the page of hits it returned', () => {
    const res = hitsFromTranscript(
      result({
        hits: [hit()],
        truncated: true,
        groups: [{ sessionId: 's1', hits: 402, blocks: 900, searched: true, aligned: true }],
      }),
      's1',
    );
    expect(res.total).toBe(402);
    expect(res.truncated).toBe(true);
  });

  it('drops hits belonging to another session in the scope', () => {
    const res = hitsFromTranscript(result({ hits: [hit(), hit({ sessionId: 'other' })] }), 's1');
    expect(res.hits).toHaveLength(1);
  });

  it('says a partial scan is partial rather than showing its count as a total', () => {
    const res = hitsFromTranscript(
      result({ hits: [hit()], error: { code: 'timed-out', message: 'slow' } }),
      's1',
    );
    expect(res.notice).toEqual({ key: 'find.notice.timedOut', tone: 'error' });
  });

  it('says a session with no transcript has nothing to search — not "no results"', () => {
    const res = hitsFromTranscript(
      result({ groups: [{ sessionId: 's1', hits: 0, blocks: 0, searched: false, aligned: true }] }),
      's1',
    );
    expect(res.notice?.key).toBe('find.notice.noTranscript');
  });

  it('says so when a session’s hits are readable but not reachable', () => {
    // Today this is the NORMAL case for a Direct (stream) session: E17-01
    // records that `StreamFeed` stamps blocks with their arrival time rather
    // than the CLI's, so the file and the feed cannot be lined up.
    const res = hitsFromTranscript(
      result({
        hits: [hit({ seq: undefined })],
        groups: [{ sessionId: 's1', hits: 1, blocks: 40, searched: true, aligned: false }],
      }),
      's1',
    );
    expect(res.notice?.key).toBe('find.notice.cannotJump');
  });
});

describe('the Changes provider delegates to Monaco (§5.31: do not reimplement it)', () => {
  it('is a delegated provider, so our bar never draws over the editor', () => {
    expect(changesFindProvider.mode).toBe('delegated');
    expect(changesFindProvider.search).toBeUndefined();
  });

  it('opens the editor’s OWN find, seeded with the sticky term', () => {
    const openFind = vi.fn().mockReturnValue(true);
    const ok = changesFindProvider.delegate?.(
      { sessionId: 's1', surface: { kind: 'monaco', openFind } as FindSurface },
      { term: 'ENOENT' },
    );
    expect(ok).toBe(true);
    expect(openFind).toHaveBeenCalledWith('ENOENT');
  });

  it('greys with a reason while the editor has not built yet', () => {
    expect(changesFindProvider.unavailableKey({ sessionId: 's1', surface: null })).toBe(
      'find.unavailable.diffNotReady',
    );
    expect(changesFindProvider.unavailableKey({ sessionId: 's1', surface: { kind: 'monaco' } })).toBeNull();
  });
});

describe('the primitive this feature must not reach for', () => {
  it('`webContents.findInPage` appears NOWHERE in the tree', () => {
    // §5.31 names it explicitly: it searches the whole webContents, so on a
    // four-card grid it matches text in the three sessions you are not looking
    // at. The plan says out loud that it is "the obvious thing for someone to
    // reach for later" — so this is the pin, not a comment.
    const root = path.resolve(__dirname, '..', '..', '..');
    // Comments are stripped first, because half the point is that the modules
    // in this feature explain IN PROSE why they don't use it. What is banned
    // is the API reaching code, not the name reaching a reader.
    const code = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else if (/\.(ts|tsx)$/.test(e.name) && p !== __filename) {
          if (code(fs.readFileSync(p, 'utf8')).includes('findInPage')) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
