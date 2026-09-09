// P2-E11-03: the WIRING, driven through the real code rather than a stand-in.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// Review of #763 found that every unit in this item was tested and every line
// CONNECTING those units was not. Concretely, all of these could be deleted
// with a green suite: `mcpConfig: opts?.mcpConfigFor?.(id)` in
// `SessionManager.create`, `mcpConfigFor` / `releaseMcpFor` / `mcpHost` in
// `sessions/ipc.ts`, the `bus.unregisterSession` teardown step, and the whole
// `BusHost` block in `main/index.ts`. The feature would do nothing and nothing
// would say so.
//
// It also found the reason the gap was invisible: `start-plan-mcp.test.ts`
// claimed to cover the id plumbing but did it against a HAND-WRITTEN stand-in
// for `create`'s body — testing a reimplementation, which is the "fixture built
// from the value it claims to verify" shape exactly. So these drive the real
// `SessionManager`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { SessionManager, PtyLike } from './session-manager';
import { ContributionRegistry } from '../../shared/extensibility/registry';
import { MainContributions, SpawnOptions } from '../extensibility/contributions';
import { LogSink, createLogger } from '../log/logger';
import { summariesFrom } from './queries';
import type { SessionStatus } from '../../shared/sessions';

/** Records what `buildSpawn` was handed, so the plumbing is observable. */
const seen: SpawnOptions[] = [];

function registry(opts: { spawnThrows?: boolean } = {}): ContributionRegistry<MainContributions> {
  const r = new ContributionRegistry<MainContributions>();
  r.register('provider-adapter', {
    manifest: { id: 'fake', displayName: 'Fake', version: '0', capabilities: ['sessions.spawn'] },
    buildSpawn: (o) => {
      seen.push(o);
      if (opts.spawnThrows) throw new Error('no CLI on PATH');
      return { command: 'fake-cli', args: [], env: {} };
    },
  });
  return r;
}

class FakePtys implements PtyLike {
  constructor(private readonly failSpawn = false) {}
  spawn() {
    if (this.failSpawn) throw new Error('spawn failed');
    return {
      pid: 1,
      onExit: () => () => {},
      kill: () => {},
    };
  }
  remove(): void {}
}

let dir: string;
beforeEach(() => {
  seen.length = 0;
  dir = tempDir('sb-bus-wiring-');
});
afterEach(() => cleanupTempDirs());

function manager(reg = registry(), ptys: PtyLike = new FakePtys()): SessionManager {
  return new SessionManager(reg, ptys, createLogger(new LogSink({ dir }), 'sessions'), dir);
}

const identity = { title: 't', folder: 'C:/tmp/x', providerId: 'fake' };

describe('SessionManager.create — the mcpConfig plumbing (P2-E11-03)', () => {
  it('hands buildSpawn the config built FOR THE ID IT MINTED', () => {
    // Deleting `mcpConfig: opts?.mcpConfigFor?.(id)` fails here, and so does
    // passing it the wrong value — the id is generated inside `create`, so the
    // only way for these to agree is for the real plumbing to be intact.
    const asked: string[] = [];
    const rec = manager().create(identity, {
      mcpConfigFor: (id) => {
        asked.push(id);
        return { mcpServers: { switchboard: { forSession: id } } };
      },
    });
    expect(asked).toEqual([rec.id]);
    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId).toBe(rec.id);
    expect(seen[0].mcpConfig).toEqual({ mcpServers: { switchboard: { forSession: rec.id } } });
  });

  it('leaves mcpConfig undefined when no builder is supplied', () => {
    manager().create(identity, {});
    expect(seen[0].mcpConfig).toBeUndefined();
  });

  it('does not confuse it with the settings channel', () => {
    // Two separate files behind two separate flags. A mutant that fed the
    // settings object into `mcpConfig` (or vice versa) would pass every test
    // that checks only one of them.
    manager().create(identity, {
      settingsFor: () => ({ hooks: { Stop: [] } }),
      mcpConfigFor: () => ({ mcpServers: {} }),
    });
    expect(seen[0].settings).toEqual({ hooks: { Stop: [] } });
    expect(seen[0].mcpConfig).toEqual({ mcpServers: {} });
  });
});

describe('a FAILED start gives the bus endpoint back (#763 review, Blocker 1)', () => {
  // THE BUG THIS ITEM SHIPPED AND REVIEW CAUGHT. `mcpConfigFor` OPENS a
  // listening endpoint and mints a token as a side effect. `create` throwing
  // after that point means no record, so `tearDownLive` never runs for the id,
  // so nothing ever released it — a live socket and a live token per failed
  // start, for the life of the app. A user with no `claude` on PATH clicking
  // Start five times leaked five.
  it('releases it when buildSpawn throws', () => {
    const released: string[] = [];
    const asked: string[] = [];
    expect(() =>
      manager(registry({ spawnThrows: true })).create(identity, {
        mcpConfigFor: (id) => {
          asked.push(id);
          return { mcpServers: {} };
        },
        releaseMcpFor: (id) => released.push(id),
      })
    ).toThrow(/no CLI on PATH/);
    // The exact id that attached is the exact id given back — not merely "some
    // release happened".
    expect(released).toEqual(asked);
    expect(released).toHaveLength(1);
  });

  it('releases it when the transport spawn throws', () => {
    // The second throw site, past `buildSpawn` and past transport resolution.
    // Both go through `abandonStart`; a fix that only covered one would pass
    // the test above and leak here.
    const released: string[] = [];
    expect(() =>
      manager(registry(), new FakePtys(true)).create(identity, {
        mcpConfigFor: () => ({ mcpServers: {} }),
        releaseMcpFor: (id) => released.push(id),
      })
    ).toThrow(/spawn failed/);
    expect(released).toHaveLength(1);
  });

  it('releases the settings token TOO — one failure does not eat the other', () => {
    // They are isolated on purpose (`abandonStart`). A release that threw used
    // to be able to prevent the other from running at all.
    const order: string[] = [];
    expect(() =>
      manager(registry({ spawnThrows: true })).create(identity, {
        settingsFor: () => ({}),
        releaseSettingsFor: () => {
          order.push('settings');
          throw new Error('release blew up');
        },
        mcpConfigFor: () => ({ mcpServers: {} }),
        releaseMcpFor: () => order.push('mcp'),
      })
    ).toThrow(/no CLI on PATH/);
    expect(order).toEqual(['settings', 'mcp']);
  });

  it('does NOT release on a start that succeeded', () => {
    // The undo is for ids that will never be sessions. Calling it on a live one
    // would tear down the endpoint of a session that is about to use it.
    const released: string[] = [];
    manager().create(identity, {
      mcpConfigFor: () => ({ mcpServers: {} }),
      releaseMcpFor: (id) => released.push(id),
    });
    expect(released).toEqual([]);
  });
});

describe('summariesFrom — the mapping that used to live in index.ts (P2-E11-03)', () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    id: 'live-1',
    identity: { title: 'Alpha', folder: '/p/alpha', providerId: 'claude-code' },
    status: 'working' as SessionStatus,
    ...over,
  });

  it('maps every field to the right place', () => {
    // Extracted out of `main/index.ts` precisely because that file has no
    // tests: swapping `folder` for `providerId`, hardcoding a status, or
    // returning `[]` all survived the suite while it lived there.
    expect(summariesFrom({ list: () => [rec()] })).toEqual([
      { id: 'live-1', name: 'Alpha', folder: '/p/alpha', providerId: 'claude-code', status: 'working' },
    ]);
  });

  it('takes the NAME from the card title, not the folder', () => {
    // The two are different strings in real life and identical in a careless
    // fixture, which is how this mutation survives. `@Alpha` is what a user
    // types; the folder is not.
    const [s] = summariesFrom({
      list: () => [rec({ identity: { title: 'Alpha', folder: '/p/zzz', providerId: 'p' } })],
    });
    expect(s.name).toBe('Alpha');
    expect(s.folder).toBe('/p/zzz');
  });

  it('reports each session\u2019s OWN status rather than a constant', () => {
    const out = summariesFrom({
      list: () => [rec(), rec({ id: 'live-2', status: 'idle' })],
    });
    expect(out.map((s) => s.status)).toEqual(['working', 'idle']);
  });

  it('INCLUDES exited sessions, and says so with their status', () => {
    // Deliberate, and the comment in `queries.ts` documents it: a self-exited
    // session keeps its record until the reap (#187), so it is listable and a
    // sibling can still read what it did. What a consumer must not do is assume
    // a row can RECEIVE anything — #765 checks `status`, not membership.
    const [s] = summariesFrom({ list: () => [rec({ status: 'exited' })] });
    expect(s.status).toBe('exited');
  });

  it('passes an empty list through rather than inventing one', () => {
    expect(summariesFrom({ list: () => [] })).toEqual([]);
  });
});
