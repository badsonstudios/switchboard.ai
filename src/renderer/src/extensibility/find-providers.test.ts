// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ContributionRegistry } from '../../../shared/extensibility/registry';
import type { FindContext, FindSurface, RendererContributions } from './contributions';
import { manifestFor } from './contributions';
import type { RendererRegistry } from './registry-instance';
import { registerBuiltinContributions } from '../bootstrap';
import {
  changesFindProvider,
  documentFindProvider,
  findMode,
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
  it('registers all four of §5.31’s named registrants (#533)', () => {
    // Three of four for two milestones; the fourth was blocked on the dispatch
    // half rather than on this file — see `find-providers.ts`'s closing note.
    const ids = listFindProviders(fresh()).map((p) => p.manifest.id);
    expect(ids).toEqual(['find-session', 'find-changes', 'find-terminal', 'find-document']);
  });

  it('resolves a provider BY PANEL, which is how one Ctrl+F serves every view', () => {
    const r = fresh();
    expect(findProviderFor(r, 'feed')?.manifest.id).toBe('find-session');
    expect(findProviderFor(r, 'diff')?.manifest.id).toBe('find-changes');
    expect(findProviderFor(r, 'terminal')?.manifest.id).toBe('find-terminal');
    expect(findProviderFor(r, 'document')?.manifest.id).toBe('find-document');
  });

  it('answers null for a panel with no provider — the greyed bar’s input', () => {
    // History is a placeholder panel and has none. §5.31 says the bar greys
    // with a reason rather than silently searching the wrong surface.
    const r = fresh();
    expect(findProviderFor(r, 'history')).toBeNull();
  });

  it('every registrant NAMES its group — labelKey is required now that it is read', () => {
    // P2-E17-03 made it required at the same time it started reading it: a
    // group with no name is a number the user cannot attribute, and the label
    // is where a surface declares its DEPTH (the Terminal's says
    // "scrollback only").
    for (const p of listFindProviders(fresh())) {
      expect(p.labelKey, p.manifest.id).toBeTruthy();
    }
    expect(findProviderFor(fresh(), 'terminal')?.labelKey).toBe('find.group.terminal');
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

  it('gives every hit a DISTINCT id, even several matches in one long field', () => {
    // `matchStart` is an offset into the SNIPPET, and the engine's context
    // window pins it at 121 for every match past the first 120 characters of a
    // field — so an id built from it collides for exactly the case find exists
    // for: several matches in one long tool output. They are React keys.
    const res = hitsFromTranscript(
      result({
        hits: [
          hit({ blockIndex: 12, field: 'tool.out', matchStart: 121 }),
          hit({ blockIndex: 12, field: 'tool.out', matchStart: 121 }),
          hit({ blockIndex: 12, field: 'tool.out', matchStart: 121 }),
        ],
      }),
      's1',
    );
    expect(new Set(res.hits.map((h) => h.id)).size).toBe(3);
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
      { sessionId: 's1', surface: { kind: 'monaco', ready: () => true, openFind } as FindSurface },
      { term: 'ENOENT' },
    );
    expect(ok).toBe(true);
    expect(openFind).toHaveBeenCalledWith('ENOENT');
  });

  it('greys with a reason until there is a FILE open, not merely an editor', () => {
    // The pane builds its editor on mount and selects no file, so "a surface
    // exists" is the state the tab is in by default. Reading only that would
    // delegate into a model-less editor, close our bar and open nothing —
    // Ctrl+F doing visibly nothing at all.
    const notReady = { kind: 'monaco', ready: () => false, openFind: () => false } as FindSurface;
    const ready = { kind: 'monaco', ready: () => true, openFind: () => true } as FindSurface;
    expect(changesFindProvider.unavailableKey({ sessionId: 's1', surface: null })).toBe(
      'find.unavailable.diffNotReady',
    );
    expect(changesFindProvider.unavailableKey({ sessionId: 's1', surface: notReady })).toBe(
      'find.unavailable.diffNotReady',
    );
    expect(changesFindProvider.unavailableKey({ sessionId: 's1', surface: ready })).toBeNull();
  });
});

describe('find-document — the §5.30 viewer (#533)', () => {
  /** A stand-in viewer. `view` is what makes one surface two providers. */
  const surfaceFor = (
    view: 'rendered' | 'source' | 'none',
    over: Partial<Record<string, unknown>> = {}
  ): FindSurface =>
    ({
      kind: 'document',
      view: () => view,
      search: () => ({ matches: [], truncated: false }),
      reveal: () => true,
      clear: () => {},
      openFind: () => true,
      ...over,
    }) as unknown as FindSurface;

  const ctxFor = (surface: FindSurface | null): FindContext => ({ sessionId: '', cardId: 'doc-1', surface });

  it('drives our bar over rendered markdown and DELEGATES over the source body', () => {
    // The reason `modeFor` exists: one panel, one provider, two bodies —
    // and §5.31 says Monaco's find is not to be reimplemented, so the half
    // that IS a Monaco editor is handed over whole.
    expect(findMode(documentFindProvider, ctxFor(surfaceFor('rendered')))).toBe('bar');
    expect(findMode(documentFindProvider, ctxFor(surfaceFor('source')))).toBe('delegated');
  });

  it('falls back to the declared mode when modeFor throws', () => {
    const angry = surfaceFor('rendered', {
      view: () => {
        throw new Error('the viewer exploded');
      },
    });
    expect(findMode(documentFindProvider, ctxFor(angry))).toBe('bar');
  });

  it('greys with a REASON when there is no document, or not one yet', () => {
    expect(findUnavailableKey(documentFindProvider, ctxFor(null))).toBe('find.unavailable.noDocument');
    expect(findUnavailableKey(documentFindProvider, ctxFor(surfaceFor('none')))).toBe(
      'find.unavailable.documentNotReady'
    );
    expect(findUnavailableKey(documentFindProvider, ctxFor(surfaceFor('rendered')))).toBeNull();
    // the source body is searchable — by Monaco, which is the delegation above
    expect(findUnavailableKey(documentFindProvider, ctxFor(surfaceFor('source')))).toBeNull();
  });

  it('turns marked matches into hits the bar can show and step', async () => {
    const surface = surfaceFor('rendered', {
      search: () => ({
        matches: [
          { text: 'the needle is here', offset: 4, length: 6 },
          { text: 'another needle', offset: 8, length: 6 },
        ],
        truncated: false,
      }),
    });
    const res = await documentFindProvider.search!(ctxFor(surface), { term: 'needle' });
    expect(res.total).toBe(2);
    expect(res.hits.map((h) => h.snippet)).toEqual(['the needle is here', 'another needle']);
    expect(res.hits.map((h) => h.matchStart)).toEqual([4, 8]);
    // every match is a `<mark>` in the body, so all of them are reachable —
    // the transcript's evicted-block boundary has no equivalent here
    expect(res.hits.every((h) => h.jumpable)).toBe(true);
    expect(res.hits.map((h) => h.ref)).toEqual([0, 1]);
  });

  it('calls the total a FLOOR when it stopped marking at the cap', async () => {
    const surface = surfaceFor('rendered', {
      search: () => ({ matches: [{ text: 'x', offset: 0, length: 1 }], truncated: true }),
    });
    const res = await documentFindProvider.search!(ctxFor(surface), { term: 'x' });
    expect(res.truncated).toBe(true);
    expect(res.totalIsFloor).toBe(true);
    expect(res.notice?.key).toBe('find.notice.truncated');
  });

  it('reveals by the provider’s own ref, and clears what it painted', () => {
    const reveal = vi.fn().mockReturnValue(true);
    const clear = vi.fn();
    const ctx = ctxFor(surfaceFor('rendered', { reveal, clear }));
    const hit = { id: 'd1', snippet: 'x', matchStart: 0, matchLength: 1, jumpable: true, earlierThanLoaded: false, ref: 1 };
    expect(documentFindProvider.reveal!(ctx, hit)).toBe(true);
    expect(reveal).toHaveBeenCalledWith(1);
    documentFindProvider.clear!(ctx);
    expect(clear).toHaveBeenCalled();
  });

  it('hands the source body’s find to Monaco, seeded', () => {
    const openFind = vi.fn().mockReturnValue(true);
    const ctx = ctxFor(surfaceFor('source', { openFind }));
    expect(documentFindProvider.delegate!(ctx, { term: 'ENOENT' })).toBe(true);
    expect(openFind).toHaveBeenCalledWith('ENOENT');
  });

  it('never reaches a surface belonging to another panel', () => {
    // the guarantee the whole point rests on, stated for the newest registrant:
    // a feed surface handed to this provider is not a document
    expect(findUnavailableKey(documentFindProvider, ctxFor({ kind: 'feed' } as FindSurface))).toBe(
      'find.unavailable.noDocument'
    );
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
