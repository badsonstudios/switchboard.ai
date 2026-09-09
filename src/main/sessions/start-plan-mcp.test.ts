// P2-E11-03: the `mcp` capability's half of the start plan, and the seam it
// reaches `buildSpawn` through.
//
// Three things are being pinned, and only the first is about the happy path:
//   1. a declared capability with a wired host produces a config;
//   2. EVERY other combination produces `undefined`, not `{}` — because `{}` is
//      truthy and would make the adapter write an empty config file and pass a
//      flag naming no servers;
//   3. `SessionManager.create` is still SYNCHRONOUS, which is the property this
//      whole design was shaped around and the one a later refactor is most
//      likely to spend without noticing.
import { describe, it, expect, vi } from 'vitest';
import { planSessionStart, StartPlanInput } from './start-plan';
import type {
  McpAttachmentHost,
  ProviderCapabilities,
  SpawnOptions,
} from '../extensibility/contributions';

const hookHost = {
  buildHookSettings: (id: string) => ({ hooks: { seen: id } }),
  releaseHookSettings: () => {},
};

const LAUNCH = { command: 'electron', args: ['bus.js', '--session', 'x'], env: { E: '1' } };

/** A bus that answers, and records who asked. */
function busHost(): McpAttachmentHost & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    attachSession: (id) => {
      asked.push(id);
      return LAUNCH;
    },
    releaseSession: () => {},
  };
}

function input(over: Partial<StartPlanInput> = {}): StartPlanInput {
  return {
    capabilitiesOf: () => ({}),
    isRegistered: () => true,
    defaultProviderId: () => 'p',
    folder: '/f',
    claimedNativeIds: () => [],
    ...over,
  };
}

const caps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  mcp: { configFor: (id, h) => ({ mcpServers: { switchboard: h.attachSession(id) } }) },
  ...over,
});

describe('start-plan — buildMcpConfig (P2-E11-03)', () => {
  it('builds a config when the capability is declared AND a bus is wired', () => {
    const bus = busHost();
    const plan = planSessionStart(
      input({ capabilitiesOf: () => caps(), mcpHost: bus }),
      hookHost
    );
    expect(plan.buildMcpConfig).toBeDefined();
    expect(plan.buildMcpConfig!('sess-9')).toEqual({ mcpServers: { switchboard: LAUNCH } });
    // The plan passes through the id it was called with, not the one it planned
    // for — the session id does not exist until `create` mints it.
    expect(bus.asked).toEqual(['sess-9']);
  });

  it('is UNDEFINED when the provider declares no mcp capability', () => {
    // The byte-identical-spawn guarantee starts here: no closure, so
    // `mcpConfigFor` is undefined, so `buildSpawn` gets no `mcpConfig`, so no
    // file and no flag.
    const plan = planSessionStart(
      input({ capabilitiesOf: () => ({}), mcpHost: busHost() }),
      hookHost
    );
    expect(plan.buildMcpConfig).toBeUndefined();
  });

  it('is UNDEFINED when no bus is wired, however loudly the adapter declares it', () => {
    // The e2e harness and the check scripts run with no `BusHost` at all. A
    // declared capability with no host to serve it must attach nothing rather
    // than half of something.
    const plan = planSessionStart(input({ capabilitiesOf: () => caps() }), hookHost);
    expect(plan.buildMcpConfig).toBeUndefined();
  });

  it('answers undefined — never {} — when the adapter declines', () => {
    // `{}` is TRUTHY. Returned here it would reach `buildSpawn`, which would
    // write an empty config file and pass `--mcp-config` naming no servers at
    // all. Distinguishing "nothing to attach" from "attach nothing" is the
    // whole reason this returns a union.
    const plan = planSessionStart(
      input({
        capabilitiesOf: () => caps({ mcp: { configFor: () => null } }),
        mcpHost: busHost(),
      }),
      hookHost
    );
    expect(plan.buildMcpConfig!('s')).toBeUndefined();
  });

  it('degrades to no-bus when the adapter THROWS, and says so', () => {
    // P6. A contributor that throws while shaping its config must cost the
    // session its siblings, not its existence — and it must not do so silently,
    // or "the bus tools are missing" becomes unexplainable from the logs.
    const reported: string[] = [];
    const plan = planSessionStart(
      input({
        capabilitiesOf: () =>
          caps({
            mcp: {
              configFor: () => {
                throw new Error('boom');
              },
            },
          }),
        mcpHost: busHost(),
        onDegraded: (r) => reported.push(r),
      }),
      hookHost
    );
    expect(plan.buildMcpConfig!('s')).toBeUndefined();
    expect(reported.join(' ')).toContain('mcp.configFor');
  });

  it('travels WITH its undo — the pair is present or absent together', () => {
    // ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE, and it was wrong. The reasoning
    // was that `buildMcpConfig` "registers nothing that outlives a failed
    // start". It registers a LISTENING ENDPOINT and a token, and a `create`
    // that throws never gets a record, so `tearDownLive` never runs for that id
    // — every failed start leaked one. Caught in review of #763; the test that
    // was supposed to protect the decision was instead pinning the bug.
    const withBus = planSessionStart(
      input({ capabilitiesOf: () => caps(), mcpHost: busHost() }),
      hookHost
    );
    expect(withBus.buildMcpConfig).toBeDefined();
    expect(withBus.releaseMcpConfig).toBeDefined();

    const without = planSessionStart(input({ capabilitiesOf: () => ({}) }), hookHost);
    expect(without.buildMcpConfig).toBeUndefined();
    expect(without.releaseMcpConfig).toBeUndefined();
  });

  it('the undo goes to the HOST, and names the right session', () => {
    const released: string[] = [];
    const bus = busHost();
    const plan = planSessionStart(
      input({
        capabilitiesOf: () => caps(),
        mcpHost: { ...bus, releaseSession: (id) => released.push(id) },
      }),
      hookHost
    );
    plan.releaseMcpConfig!('sess-4');
    expect(released).toEqual(['sess-4']);
  });

  it('a THROWING undo degrades rather than replacing the real error', () => {
    // It runs on the way to re-throwing whatever actually stopped the session.
    // A cleanup that threw would replace "no CLI on PATH" with a housekeeping
    // failure that tells the caller nothing.
    const reported: string[] = [];
    const plan = planSessionStart(
      input({
        capabilitiesOf: () => caps(),
        mcpHost: {
          attachSession: () => LAUNCH,
          releaseSession: () => {
            throw new Error('release blew up');
          },
        },
        onDegraded: (r) => reported.push(r),
      }),
      hookHost
    );
    expect(() => plan.releaseMcpConfig!('s')).not.toThrow();
    expect(reported.join(' ')).toContain('releaseSession');
    // ...and it blames the BUS, not a "provider capability" — the release
    // deliberately bypasses the adapter, so naming one would be a lie in the log.
    expect(reported.join(' ')).not.toContain('provider capability');
  });
});

describe('the spawn path stays SYNCHRONOUS (P2-E11-03)', () => {
  it('buildMcpConfig returns a value, never a promise', () => {
    // The design constraint in one assertion. `SessionManager.create` is
    // synchronous end to end; making it async would let two lazy-spawn calls
    // both pass the reap in `sessions:create` and break one-live-session-per-
    // card (P2-E15-08), which is why the bus DERIVES its endpoint paths instead
    // of waiting to discover them.
    const plan = planSessionStart(
      input({ capabilitiesOf: () => caps(), mcpHost: busHost() }),
      hookHost
    );
    const out = plan.buildMcpConfig!('s');
    expect(out).not.toBeInstanceOf(Promise);
    expect(out).toEqual({ mcpServers: { switchboard: LAUNCH } });
  });

  it('an adapter receives mcpConfig synchronously, in the same call', () => {
    // End to end through the real seam shape: whatever `mcpConfigFor` answers
    // must be in `SpawnOptions` by the time `buildSpawn` runs, with no tick in
    // between for anything else to interleave.
    const seen: SpawnOptions[] = [];
    const buildSpawn = vi.fn((o: SpawnOptions) => {
      seen.push(o);
      return { command: 'c', args: [], env: {} };
    });
    // Stand in for `create`'s body: the id is minted, the config is built for
    // it, and the recipe is asked for — all before this function returns.
    const create = (mcpConfigFor?: (id: string) => Record<string, unknown> | undefined) => {
      const id = 'minted-id';
      return buildSpawn({ cwd: '/f', sessionId: id, stateDir: '/st', mcpConfig: mcpConfigFor?.(id) });
    };
    const plan = planSessionStart(
      input({ capabilitiesOf: () => caps(), mcpHost: busHost() }),
      hookHost
    );
    create(plan.buildMcpConfig);
    expect(seen).toHaveLength(1);
    expect(seen[0].mcpConfig).toEqual({ mcpServers: { switchboard: LAUNCH } });
    // ...and the config was built for the id `create` minted, not for anything
    // the plan captured earlier.
    expect(seen[0].sessionId).toBe('minted-id');
  });

  it('a provider with no capability leaves mcpConfig undefined at the adapter', () => {
    const seen: SpawnOptions[] = [];
    const plan = planSessionStart(input({ capabilitiesOf: () => ({}) }), hookHost);
    seen.push({
      cwd: '/f',
      sessionId: 'i',
      stateDir: '/st',
      mcpConfig: plan.buildMcpConfig?.('i'),
    });
    expect(seen[0].mcpConfig).toBeUndefined();
    // Not `{}`, not `null` — absent. `buildSpawn` branches on truthiness.
    expect('mcpConfig' in seen[0] && seen[0].mcpConfig).toBeFalsy();
  });
});
