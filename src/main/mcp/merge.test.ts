import { describe, expect, it } from 'vitest';
import { enrichRuntime, matchConfig, notLoaded } from './merge';
import type { McpRuntimeScope, McpRuntimeServer, McpScope, McpServerWire } from '../../shared/mcp';

const runtime = (
  name: string,
  scope: McpRuntimeScope,
  extra: Partial<McpRuntimeServer> = {}
): McpRuntimeServer => ({
  name,
  scope,
  status: 'connected',
  target: 'npx',
  tools: [],
  readOnly: true,
  envKeys: [],
  headerKeys: [],
  ...extra,
});

const config = (name: string, scope: McpScope, extra: Partial<McpServerWire> = {}): McpServerWire => ({
  name,
  scope,
  transport: 'stdio',
  approval: 'n/a',
  target: 'npx',
  args: [],
  envKeys: [],
  headerKeys: [],
  source: `${scope}.json`,
  ...extra,
});

describe('what a config file vouches for becomes mutable', () => {
  it('pairs an exact scope+name match', () => {
    const [s] = enrichRuntime([runtime('sentry', 'local')], [config('sentry', 'local')]);
    expect(s.readOnly).toBe(false);
    expect(s.removeScope).toBe('local');
  });

  it('leaves a row no file declares read-only — the connector case', () => {
    // Every claude.ai connector and every plugin server lands here, which on the
    // reporting machine is 13 of the 16 rows.
    const [s] = enrichRuntime([runtime('Slack', 'dynamic')], [config('sentry', 'local')]);
    expect(s.readOnly).toBe(true);
    expect(s.removeScope).toBeUndefined();
  });

  it('carries the env and header KEY NAMES back from the file', () => {
    // The three facts that flow file -> runtime row. `mcp_status` has no field
    // for any of them, so "is my API key configured?" is answerable only here.
    const [s] = enrichRuntime(
      [runtime('sentry', 'local')],
      [config('sentry', 'local', { envKeys: ['SENTRY_TOKEN'], headerKeys: ['Authorization'] })]
    );
    expect(s.envKeys).toEqual(['SENTRY_TOKEN']);
    expect(s.headerKeys).toEqual(['Authorization']);
  });
});

describe('the scope disagreement that must NOT become a Remove button', () => {
  it('refuses a name match when both scopes are ones a config file can express', () => {
    // `mcp_status` resolved it as `project`; the only config entry is `user`.
    // Both are real config scopes, so the CLI has TOLD us which it resolved —
    // overriding that would put a button on the row that deletes the OTHER
    // definition, the one the user is not looking at.
    const [s] = enrichRuntime([runtime('sentry', 'project')], [config('sentry', 'user')]);
    expect(s.readOnly).toBe(true);
  });

  it('REFUSES an org policy shadowing a user entry — the case that would delete the wrong file', () => {
    // THE COUNTER-EXAMPLE THAT KILLED THE NAME-ONLY FALLBACK, found in review.
    // `enterprise` and `managed` ARE file-backed and outrank user scope, so an
    // org policy defining `github` over the user's own produces ONE runtime row.
    // A draft matched it to the single `user` entry by name and put a Remove
    // button on it — clicking which deleted the user's copy, left the row on
    // screen (it was the enterprise one) and reported "Removed github."
    const [s] = enrichRuntime([runtime('github', 'enterprise')], [config('github', 'user')]);
    expect(s.readOnly).toBe(true);
    expect(s.removeScope).toBeUndefined();
  });

  it.each<McpRuntimeScope>(['builtin', 'dynamic', 'skills', 'managed', 'unknown'])(
    'refuses a name match for runtime scope `%s`',
    (scope) => {
      // The exact match covers every removable row already, because
      // `readInventory` produces exactly project/local/user. Anything reaching
      // here is a scope the files cannot express, so a same-name config entry
      // is by construction a SHADOWED definition rather than this row's source.
      // `unknown` is the sharpest case: it exists because we do not know what
      // the scope is, so it cannot be asserted as not-file-backed.
      const [s] = enrichRuntime([runtime('sentry', scope)], [config('sentry', 'user')]);
      expect(s.readOnly).toBe(true);
    }
  );

  it('still prefers the EXACT match when a duplicate name exists elsewhere', () => {
    const [s] = enrichRuntime(
      [runtime('sentry', 'user')],
      [config('sentry', 'local', { source: 'wrong.json' }), config('sentry', 'user')]
    );
    expect(s.removeScope).toBe('user');
  });
});

describe('one match function, so the button and the scope cannot disagree', () => {
  it('derives readOnly from exactly the pairing matchConfig reports', () => {
    const rows = [runtime('a', 'local'), runtime('b', 'builtin'), runtime('c', 'dynamic')];
    const files = [config('a', 'local'), config('c', 'user')];
    const matches = matchConfig(rows, files);
    const enriched = enrichRuntime(rows, files);
    // The invariant an earlier two-function draft could break: a row is
    // removable if and only if a config entry backs it, with THAT entry's scope.
    enriched.forEach((s, i) => {
      expect(s.readOnly).toBe(matches[i] === null);
      expect(s.removeScope).toBe(matches[i]?.scope);
    });
  });

  it('is stable across repeated runs — it mutates neither input', () => {
    const rows = [runtime('a', 'local')];
    const files = [config('a', 'local')];
    const once = enrichRuntime(rows, files);
    const twice = enrichRuntime(rows, files);
    expect(once).toEqual(twice);
    // the inputs are untouched, so a second render cannot see the first's output
    expect(rows[0].readOnly).toBe(true);
  });

  it('pairs by index even when the lists are different lengths', () => {
    const rows = [runtime('x', 'builtin'), runtime('a', 'local'), runtime('y', 'skills')];
    const out = enrichRuntime(rows, [config('a', 'local')]);
    expect(out.map((s) => s.readOnly)).toEqual([true, false, true]);
  });

  it('carries the approval state across, so `pending` survives the runtime path', () => {
    // `mcp_status` has no approval field — it is derived from two lists on the
    // project entry. Without this, "waiting for your approval" would vanish on
    // the path most sessions are on and an unapproved server would report "not
    // connecting": the symptom instead of the cause.
    const [s] = enrichRuntime(
      [runtime('shared', 'project')],
      [config('shared', 'project', { approval: 'pending' })]
    );
    expect(s.approval).toBe('pending');
  });
});

describe('notLoaded — the servers the session has not picked up', () => {
  // MEASURED, NOT ASSUMED (`spike/probes/721/probe-mcp-add-live.mjs`):
  // `mcp_status` is frozen at session start. A server added while a session ran
  // never appeared in its answer across three polls over ten seconds, and one
  // removed never disappeared. Without this list, Add succeeds and the pane does
  // not change — the regression review caught in #729 PR 1.
  it('lists a config entry no runtime row accounts for', () => {
    const out = notLoaded([runtime('old', 'local')], [config('old', 'local'), config('new', 'local')]);
    expect(out.map((s) => s.name)).toEqual(['new']);
  });

  it('is empty when the session has loaded everything', () => {
    expect(notLoaded([runtime('a', 'local')], [config('a', 'local')])).toEqual([]);
  });

  it('does NOT list a server the CLI resolved under a scope the files cannot express', () => {
    // The org-policy shadow again, from the other side: `github` IS loaded, it
    // just came back as `enterprise`. Listing it as "not loaded" would put a
    // second, wrong row on screen for one server.
    expect(notLoaded([runtime('github', 'enterprise')], [config('github', 'user')])).toEqual([]);
  });

  it('lists everything when the session loaded nothing', () => {
    const files = [config('a', 'local'), config('b', 'user')];
    expect(notLoaded([], files).map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('empty inputs', () => {
  it('answers an empty list for no runtime rows', () => {
    expect(enrichRuntime([], [config('a', 'local')])).toEqual([]);
  });

  it('marks everything read-only when no config file could be read at all', () => {
    // The unreadable-`.mcp.json` case: the inventory floor is empty, so nothing
    // can be vouched for. The pane still shows every server the session has —
    // it just cannot offer to remove any of them, which is the truth.
    const out = enrichRuntime([runtime('a', 'local'), runtime('b', 'user')], []);
    expect(out.every((s) => s.readOnly)).toBe(true);
  });
});
