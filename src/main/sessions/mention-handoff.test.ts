// The ORDER a send with self-written handoffs happens in (#1126).
//
// Each part has its own tests. This is the composition, and it is here because
// the three mistakes review found in it — asking sessions on a draft that was
// going to be refused, describing a session by a conversation that now ended
// with the app's own request, and doing that even for a session that never
// delivered — were all mistakes of order, in code that then lived inline in
// `main/index.ts` where nothing could reach it.
//
// A REAL `SessionQueries` over real transcript files, so "the session's
// conversation changed while we waited" is a file that was appended to, not a
// mock that was told what to say.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionQueries, type DiffSource } from './queries';
import { quoted, renderOutput } from '../bus/bus-tools';
import type { SessionSummary } from '../../shared/sessions';
import type { HandoffOutcome } from './handoff-request';
import { resolveMentionsWithHandoffs, type MentionHandoffDeps } from './mention-handoff';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mention-handoff-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const summary = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x',
  name: 'x',
  folder: 'C:/p/x',
  providerId: 'claude-code',
  status: 'done',
  exited: false,
  ...over,
});
const OWN = summary({ id: 'live-b', name: 'Beta', folder: 'C:/p/beta' });
const ALPHA = summary({ id: 'live-a', name: 'Alpha', folder: 'C:/p/alpha' });
const GAMMA = summary({ id: 'live-c', name: 'Gamma', folder: 'C:/p/gamma' });

const assistantLine = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const noDiff: DiffSource = { diff: async () => ({ isRepo: false, text: '' }) };
const fileOf = (id: string): string => path.join(dir, `${id}.jsonl`);

function host(
  sessions: SessionSummary[],
  outcome: (sourceId: string) => HandoffOutcome | Promise<HandoffOutcome>
) {
  for (const s of sessions) fs.writeFileSync(fileOf(s.id), assistantLine(`${s.name} said this before`) + '\n');
  const requested: Array<[string, string, string]> = [];
  const order: string[] = [];
  const deps: MentionHandoffDeps = {
    queries: new SessionQueries({ list: () => sessions, transcriptFor: (id) => fileOf(id), git: noDiff }),
    render: renderOutput,
    request: async (sourceId, readerId, askedBy) => {
      requested.push([sourceId, readerId, askedBy]);
      order.push(`request:${sourceId}`);
      return outcome(sourceId);
    },
    lookup: async () => {
      order.push('lookup');
      return { git: () => undefined, tree: () => undefined };
    },
    mint: () => 'ref-1',
    fence: quoted,
  };
  return { deps, requested, order };
}

/** the session takes the turn: the request and its answer land in its conversation */
function wrote(id: string, text: string): HandoffOutcome {
  fs.appendFileSync(
    fileOf(id),
    userLine('[switchboard: handoff request] The user is about to pick this work up') + '\n' + assistantLine(text) + '\n'
  );
  return { kind: 'written', text, truncated: false };
}

const send = (h: ReturnType<typeof host>, text: string, selfWritten = true) =>
  resolveMentionsWithHandoffs(h.deps, text, OWN.id, { selfWritten });

describe('without the switch', () => {
  it('asks nobody and reports nothing — it is the send it always was', async () => {
    const h = host([OWN, ALPHA], () => {
      throw new Error('must not be asked');
    });
    const r = await send(h, 'take @Alpha from here', false);
    expect(h.requested).toEqual([]);
    expect(r.ok && r.prompt).toContain('Alpha said this before');
    expect(r.ok && r.handoffs).toBeUndefined();
    expect(r.ok && r.prompt).toContain('no model wrote it');
  });

  it('asks nobody when the draft names no other session, switch or no switch', async () => {
    const h = host([OWN, ALPHA], () => {
      throw new Error('must not be asked');
    });
    const r = await send(h, 'just words, and @Beta is me');
    expect(h.requested).toEqual([]);
    expect(r).toEqual({ ok: true, prompt: 'just words, and @Beta is me' });
  });
});

describe('with the switch', () => {
  it('asks each named session ONCE, on behalf of this one, by its name', async () => {
    const h = host([OWN, ALPHA, GAMMA], (id) => wrote(id, `${id} handoff`));
    await send(h, 'compare @Alpha with @Gamma, and @Alpha again');
    expect(h.requested).toEqual([
      ['live-a', 'live-b', 'Beta'],
      ['live-c', 'live-b', 'Beta'],
    ]);
  });

  it('puts what the session wrote at the top of its brief, and says how each came out', async () => {
    const h = host([OWN, ALPHA], (id) => wrote(id, 'ALPHA_HANDOFF: half done'));
    const r = await send(h, 'take @Alpha from here');
    if (!r.ok) throw new Error('expected a send');
    expect(r.handoffs).toEqual([{ name: 'Alpha', outcome: 'written' }]);
    expect(r.prompt).toContain('## Handoff, written by that session');
    expect(r.prompt).toContain('ALPHA_HANDOFF: half done');
    expect(r.prompt).not.toContain('no model wrote it');
  });

  it('describes the session AS IT WAS BEFORE IT WAS ASKED — the request is not quoted back', async () => {
    const h = host([OWN, ALPHA], (id) => wrote(id, 'ALPHA_HANDOFF'));
    const r = await send(h, 'take @Alpha from here');
    if (!r.ok) throw new Error('expected a send');
    // what it had said is there...
    expect(r.prompt).toContain('Alpha said this before');
    // ...the app's own request is not presented as part of its conversation...
    expect(r.prompt).not.toContain('[switchboard: handoff request]');
    // ...and the handoff appears once, in its own section, not again under the conversation
    expect(r.prompt.split('ALPHA_HANDOFF').length - 1).toBe(1);
  });

  it('does the same for a session that was asked and did NOT deliver', async () => {
    // A timeout leaves the request in that session's conversation just the same.
    const h = host([OWN, ALPHA], (id) => {
      fs.appendFileSync(fileOf(id), userLine('[switchboard: handoff request] The user is about to') + '\n');
      return { kind: 'fallback', reason: 'timeout', asked: true };
    });
    const r = await send(h, 'take @Alpha from here');
    if (!r.ok) throw new Error('expected a send');
    expect(r.handoffs).toEqual([{ name: 'Alpha', outcome: 'timeout' }]);
    expect(r.prompt).not.toContain('[switchboard: handoff request]');
    expect(r.prompt).toContain('Alpha said this before');
    // and it is today's brief: no handoff section, the app's own claim intact
    expect(r.prompt).not.toContain('## Handoff, written by that session');
    expect(r.prompt).toContain('no model wrote it');
  });

  it('reads a session that was NEVER TOUCHED as it is now — exactly as with the switch off', async () => {
    const h = host([OWN, ALPHA], (id) => {
      // it is busy, and it says something more while we are here
      fs.appendFileSync(fileOf(id), assistantLine('Alpha said this just now') + '\n');
      return { kind: 'fallback', reason: 'busy', asked: false };
    });
    const r = await send(h, 'take @Alpha from here');
    if (!r.ok) throw new Error('expected a send');
    expect(r.handoffs).toEqual([{ name: 'Alpha', outcome: 'busy' }]);
    expect(r.prompt).toContain('Alpha said this just now');
  });

  it('keeps each session`s outcome its own when one writes and another is busy', async () => {
    const h = host([OWN, ALPHA, GAMMA], (id) =>
      id === 'live-a' ? wrote(id, 'ALPHA_HANDOFF') : { kind: 'fallback', reason: 'busy', asked: false }
    );
    const r = await send(h, 'compare @Alpha with @Gamma');
    if (!r.ok) throw new Error('expected a send');
    expect(r.handoffs).toEqual([
      { name: 'Alpha', outcome: 'written' },
      { name: 'Gamma', outcome: 'busy' },
    ]);
    expect(r.prompt).toContain('ALPHA_HANDOFF');
    expect(r.prompt).toContain('Gamma said this before');
  });

  it('looks up git AFTER the wait, so the facts are current when the brief is built', async () => {
    const h = host([OWN, ALPHA], (id) => wrote(id, 'x'));
    await send(h, 'take @Alpha from here');
    expect(h.order).toEqual(['request:live-a', 'lookup']);
  });

  it('⚠️ asks NOBODY when the send is going to be refused anyway', async () => {
    // Two sessions share a name: the whole draft is refused. Finding that out
    // after every OTHER session named in it had spent a turn writing would be
    // the app burning a subscription to say "retype that name".
    const twin = summary({ id: 'live-z', name: 'Alpha', folder: 'C:/p/alpha2' });
    const h = host([OWN, ALPHA, twin, GAMMA], () => {
      throw new Error('must not be asked');
    });
    const r = await send(h, 'compare @Gamma with @Alpha');
    expect(r.ok).toBe(false);
    expect(h.requested).toEqual([]);
  });

  it('never loses the send to a request that rejects — it is told it could not ask', async () => {
    const h = host([OWN, ALPHA], () => Promise.reject(new Error('the manager is gone')));
    const r = await send(h, 'take @Alpha from here');
    if (!r.ok) throw new Error('expected a send');
    expect(r.handoffs).toEqual([{ name: 'Alpha', outcome: 'unreachable' }]);
    expect(r.prompt).toContain('Alpha said this before');
  });
});
