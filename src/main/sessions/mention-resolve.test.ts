// P2-E11-08: the composer's `@Name` → the prompt that is sent.
//
// Against a REAL `SessionQueries` and the REAL `renderOutput`, because the claim
// this item makes is that the composer and the bus tools give the same answer —
// a stubbed query core would only prove the composition calls something.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionQueries, type DiffSource } from './queries';
import { quoted, renderOutput, CONTENT_FENCE } from '../bus/bus-tools';
import { mentionedSessions, resolveMentions } from './mention-resolve';
import { AT_ESCAPE_NOTE } from '../../shared/at-mentions';
import { findContextSections } from '../../shared/injected-context';
import type { SessionSummary } from '../../shared/sessions';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mention-resolve-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const summary = (over: Partial<SessionSummary>): SessionSummary => ({
  id: 'x',
  name: 'x',
  folder: 'C:/p/x',
  providerId: 'claude-code',
  status: 'idle',
  exited: false,
  ...over,
});

const assistantLine = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const noDiff: DiffSource = { diff: async () => ({ isRepo: false, text: '' }) };

const OWN = summary({ id: 'live-b', name: 'Beta', folder: 'C:/p/beta' });
const TRADING = summary({ id: 'live-a', name: 'TradingApp', folder: 'C:/p/trading' });

/** A query core over `sessions`, where each id's transcript holds `outputs[id]` (absent = none yet). */
function queries(sessions: SessionSummary[], outputs: Record<string, string[]> = {}): SessionQueries {
  const files = new Map<string, string>();
  for (const [id, lines] of Object.entries(outputs)) {
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map(assistantLine).join('\n') + '\n');
    files.set(id, file);
  }
  return new SessionQueries({ list: () => sessions, transcriptFor: (id) => files.get(id) ?? null, git: noDiff });
}

// The real wiring's fence (`main/index.ts`), so a brief is marked as DATA here
// exactly as it is in the app.
const run = (q: SessionQueries, text: string) =>
  resolveMentions(q, renderOutput, text, OWN.id, { fence: quoted });

describe('resolveMentions — a live session', () => {
  it('injects a BRIEF on that session ahead of the prose — fenced, attributed, facts first (#1092)', () => {
    const q = queries([OWN, TRADING], { 'live-a': ['the fix was a null check in parse()'] });
    const r = run(q, "take @TradingApp's fix and apply it here");
    if (!r.ok) throw new Error(r.refusals.join('; '));

    const [block, prose] = [r.prompt.slice(0, r.prompt.lastIndexOf('\n\n')), r.prompt.slice(r.prompt.lastIndexOf('\n\n') + 2)];
    expect(block.startsWith('# Brief on "TradingApp" (session)')).toBe(true);
    // The app's FACTS come first and sit OUTSIDE the data fence; what the
    // session said is inside it. A reader can tell which is which.
    const fence = block.indexOf(CONTENT_FENCE);
    expect(block.indexOf('## Facts')).toBeLessThan(fence);
    expect(fence).toBeLessThan(block.indexOf('## Recent conversation'));
    expect(block.indexOf('the fix was a null check in parse()')).toBeGreaterThan(fence);
    expect(block).toContain('- **Session:** TradingApp (claude-code) — id live-a');
    expect(block).toContain('- **Folder:** C:/p/trading');
    expect(block).toContain('- **State:** finished its turn and is idle');
    // …what it said is there, and so is the way to get more
    expect(block).toContain('the fix was a null check in parse()');
    expect(block).toContain('`get_session_output`');
    // the prose: every word the user typed, with the mention out of `@` shape
    expect(prose).toBe(`take "TradingApp" (session)'s fix and apply it here`);
  });

  it('a session with NO transcript yet is an ok answer that says so — not a throw, not silence', () => {
    const r = run(queries([OWN, TRADING]), 'what is @TradingApp doing');
    if (!r.ok) throw new Error('expected a send');
    expect(r.prompt).toContain('Nothing has been said in this session yet.');
    expect(r.prompt.endsWith('what is "TradingApp" (session) doing')).toBe(true);
  });

  it('resolves case-insensitively, the way `resolve` does, and prints back what the user typed', () => {
    const r = run(queries([OWN, TRADING], { 'live-a': ['done'] }), 'ask @tradingapp');
    // The BLOCK names the session as the list spells it; the prose keeps the
    // user's own words, minus the `@` shape.
    expect(r.ok && r.prompt.includes('# Brief on "TradingApp" (session)')).toBe(true);
    expect(r.ok && r.prompt.endsWith('ask "tradingapp" (session)')).toBe(true);
  });

  it('says so, loudly, when the mentioned session shares the READER\'s folder', () => {
    // The one fact that can break the reader: two sessions in one working tree
    // share a branch and each other's uncommitted changes.
    // same case, different separators: true on every filesystem
    const twin = summary({ id: 'live-c', name: 'Twin', folder: 'C:\\p\\beta\\' });
    const shared = run(queries([OWN, twin], { 'live-c': ['x'] }), 'see @Twin');
    expect(shared.ok && shared.prompt.includes('It shares your folder')).toBe(true);
    const apart = run(queries([OWN, TRADING], { 'live-a': ['x'] }), 'see @TradingApp');
    expect(apart.ok && apart.prompt.includes('shares your folder')).toBe(false);
  });

  it('…and when it shares the reader’s WORKING TREE from a different folder (#1098)', () => {
    // `C:/p/beta` (the reader) and `C:/p/beta/packages/api`: two folder names,
    // one checkout. The folder comparison said nothing here.
    const inner = summary({ id: 'live-d', name: 'Inner', folder: 'C:/p/beta/packages/api' });
    const q = queries([OWN, inner], { 'live-d': ['x'] });
    const withTree = (tree: (folder: string) => string | undefined) =>
      resolveMentions(q, renderOutput, 'see @Inner', OWN.id, { fence: quoted, tree });
    const shared = withTree(() => 'C:/p/beta');
    expect(shared.ok && shared.prompt.includes('It shares your working tree')).toBe(true);
    // the READER's own tree is asked for too, by its own folder
    const asked: string[] = [];
    withTree((folder) => (asked.push(folder), 'C:/p/beta'));
    expect(asked.sort()).toEqual(['C:/p/beta', 'C:/p/beta/packages/api']);
    // nothing known, nothing claimed — and a lookup that throws is nothing known
    const unknown = withTree(() => undefined);
    expect(unknown.ok && unknown.prompt.includes('shares your')).toBe(false);
    const threw = withTree(() => {
      throw new Error('lookup broke');
    });
    expect(threw.ok && threw.prompt.includes('shares your')).toBe(false);
  });

  it('states the branch and the uncommitted count the caller looked up — and nothing when it could not', () => {
    const q = queries([OWN, TRADING], { 'live-a': ['x'] });
    const asked: string[] = [];
    const known = resolveMentions(q, renderOutput, 'see @TradingApp', OWN.id, {
      git: (folder) => {
        asked.push(folder);
        return { branch: 'feature/x', changed: 3, untracked: 0 };
      },
    });
    expect(asked).toEqual(['C:/p/trading']);
    expect(known.ok && known.prompt.includes('- **Git:** on branch `feature/x`, 3 tracked files with uncommitted changes')).toBe(true);

    const unknown = resolveMentions(q, renderOutput, 'see @TradingApp', OWN.id, { git: () => undefined });
    expect(unknown.ok && unknown.prompt.includes('**Git:**')).toBe(false);
    // a lookup that THROWS is a fact we do not have, never a refused send
    const thrown = resolveMentions(q, renderOutput, 'see @TradingApp', OWN.id, {
      git: () => {
        throw new Error('git exploded');
      },
    });
    expect(thrown.ok && thrown.prompt.includes('# Brief on')).toBe(true);
    expect(thrown.ok && thrown.prompt.includes('**Git:**')).toBe(false);
  });

  it('a wiring WITHOUT the handoff package still sends the plain recent output (#764)', () => {
    const q = queries([OWN, TRADING], { 'live-a': ['the old way'] });
    const narrow = {
      listSessions: q.listSessions.bind(q),
      resolve: q.resolve.bind(q),
      sessionOutput: q.sessionOutput.bind(q),
    };
    const r = resolveMentions(narrow, renderOutput, 'see @TradingApp', OWN.id);
    const direct = q.sessionOutput('live-a');
    if (!r.ok || !direct.ok) throw new Error('expected a send');
    expect(r.prompt.startsWith(renderOutput(direct.value))).toBe(true);
    expect(r.prompt).toContain('Recent output from TradingApp [id live-a]');
  });

  it('mentionedSessions names the OTHER sessions a draft resolves to, once each', () => {
    const q = queries([OWN, TRADING]);
    expect(mentionedSessions(q, 'ask @TradingApp and @tradingapp, not @Beta or @nobody', OWN.id).map((x) => x.id)).toEqual(['live-a']);
    expect(mentionedSessions(q, 'no mentions here', OWN.id)).toEqual([]);
  });

  it('a SESSION ID resolves too — the escape hatch the ambiguous refusal offers', () => {
    const r = run(queries([OWN, TRADING], { 'live-a': ['by id'] }), 'ask @live-a about it');
    expect(r.ok && r.prompt.includes('by id')).toBe(true);
    expect(r.ok && r.prompt.endsWith('ask "live-a" (session) about it')).toBe(true);
  });
});

// THE REVIEW BLOCKER. Two sessions whose titles differ only in case are the
// ordinary result of two checkouts, and the finder matches case-insensitively —
// so resolving the LIST's spelling instead of the user's handed back whichever
// session sorted first, silently, while an agent asking the bus for the same
// name got the other one.
describe('resolveMentions — two sessions that differ only by case', () => {
  const API = summary({ id: 'live-up', name: 'API', folder: 'C:/p/api-upper' });
  const api = summary({ id: 'live-lo', name: 'api', folder: 'C:/p/api-lower' });

  it('gives the user the session they actually typed, exactly as `resolve` would', () => {
    const q = queries([OWN, API, api], { 'live-up': ['UPPER output'], 'live-lo': ['lower output'] });
    const upper = run(q, 'ask @API');
    const lower = run(q, 'ask @api');

    expect(upper.ok && upper.prompt.includes('UPPER output')).toBe(true);
    expect(upper.ok && upper.prompt.includes('lower output')).toBe(false);
    expect(lower.ok && lower.prompt.includes('lower output')).toBe(true);
    expect(lower.ok && lower.prompt.includes('UPPER output')).toBe(false);
    // …the same answers the bus gives for the same two strings.
    const busUpper = q.resolve('API');
    const busLower = q.resolve('api');
    expect(busUpper.ok && busUpper.value.id).toBe('live-up');
    expect(busLower.ok && busLower.value.id).toBe('live-lo');
  });

  it('injects ONE block when two spellings mean one session', () => {
    // Only `api` exists, so `@API` and `@api` both resolve to it — one session,
    // one block, both mentions rewritten.
    const q = queries([OWN, api], { 'live-lo': ['just the one'] });
    const r = run(q, 'ask @api and @API');
    if (!r.ok) throw new Error(r.refusals.join('; '));
    expect(r.prompt.split('just the one')).toHaveLength(2);
    expect(r.prompt.endsWith('ask "api" (session) and "API" (session)')).toBe(true);
  });

  it('a true same-case duplicate is still refused as ambiguous', () => {
    const twin = summary({ id: 'live-2', name: 'api', folder: 'C:/p/api-2' });
    const r = run(queries([OWN, api, twin]), 'ask @api');
    expect(r.ok).toBe(false);
  });
});

describe('resolveMentions — left exactly as typed', () => {
  const same: Array<[string, string]> = [
    ['no mention at all', 'plain prose'],
    ['an @ matching no session', 'ping @Nobody please'],
    ['an email address', 'mail dan@TradingApp.com'],
    ['@media, a CSS rule', 'why does @media (max-width: 600px) not apply'],
    ['an @ at the end of the input', 'look at @'],
    ['a mention inside a code fence', 'run\n```\n@TradingApp\n```'],
    ["the composer's OWN session", 'note to @Beta'],
  ];
  for (const [what, text] of same) {
    it(what, () => {
      expect(run(queries([OWN, TRADING], { 'live-a': ['out'] }), text)).toEqual({ ok: true, prompt: text });
    });
  }

  it('a name the session was RENAMED away from', () => {
    const renamed = summary({ ...TRADING, name: 'Trading2' });
    const text = 'take @TradingApp and go';
    expect(run(queries([OWN, renamed], { 'live-a': ['out'] }), text)).toEqual({ ok: true, prompt: text });
  });

  it('a title `resolve` normalises away (a leading @) — literal, not a refusal', () => {
    const odd = summary({ id: 'live-z', name: '@Odd' });
    const text = 'see @@Odd';
    expect(run(queries([OWN, odd]), text)).toEqual({ ok: true, prompt: text });
  });

  it('a session that RESOLVES but cannot be read — literal, never an empty block', () => {
    // Mutation survivor, and a defensive branch worth keeping honest: the name
    // resolved, so the session exists, but its output could not be fetched.
    // Injecting `{block: ''}` would tell the model the session had said nothing,
    // which is the confident wrong answer the query core exists to refuse.
    const q = queries([OWN, TRADING], { 'live-a': ['out'] });
    const unreadable = {
      listSessions: () => q.listSessions(),
      resolve: (ref: string) => q.resolve(ref),
      sessionOutput: () => ({ ok: false as const, reason: 'the transcript went away' }),
    };
    expect(resolveMentions(unreadable, renderOutput, 'ask @TradingApp', OWN.id)).toEqual({
      ok: true,
      prompt: 'ask @TradingApp',
    });
  });

  it('the session list itself refusing — the draft goes as typed', () => {
    const q = queries([OWN, TRADING]);
    const broken = { listSessions: () => ({ ok: false as const, reason: 'down' }), resolve: q.resolve.bind(q), sessionOutput: q.sessionOutput.bind(q) };
    expect(resolveMentions(broken, renderOutput, 'ask @TradingApp', OWN.id)).toEqual({ ok: true, prompt: 'ask @TradingApp' });
  });
});

describe('resolveMentions — an ambiguous name', () => {
  it("refuses the whole send with `resolve`'s own reason, naming every candidate and folder", () => {
    const twin = summary({ id: 'live-t', name: 'TradingApp', folder: 'C:/p/trading-2' });
    const q = queries([OWN, TRADING, twin], { 'live-a': ['a'], 'live-t': ['t'] });
    const bus = q.resolve('TradingApp');
    if (bus.ok) throw new Error('expected the bus to refuse too');

    expect(run(q, 'take @TradingApp')).toEqual({ ok: false, refusals: [bus.reason] });
    expect(bus.reason).toContain('C:/p/trading');
    expect(bus.reason).toContain('C:/p/trading-2');
  });

  it('even when it is the OWN session that shares the name — the bus would not pick either', () => {
    const twin = summary({ id: 'live-t', name: 'Beta', folder: 'C:/p/beta-2' });
    const r = run(queries([OWN, twin]), 'note to @Beta');
    expect(r.ok).toBe(false);
  });
});

describe('resolveMentions — what the injected block carries (#832, #830)', () => {
  /** The CLI's own bare-mention extractor — see `at-mentions.test.ts`. */
  const mentions = (s: string): string[] =>
    [...s.matchAll(/(^|[\s。、？！])@([^\s]+)\b/g)].map((m) => m[2] ?? '');

  it('DEFUSES an @word in the other session’s output — the whole of #832', () => {
    // The sibling's transcript talks about an npm scope. Before this, the
    // receiving CLI resolved it against the receiving folder.
    const q = queries([OWN, TRADING], { 'live-a': ['I bumped @types/node and it built'] });
    const r = run(q, 'what happened in @TradingApp?');
    if (!r.ok) throw new Error('expected a send');
    // The user's own mention is rewritten (#798) and the sibling's is escaped —
    // so the CLI finds NOTHING to attach in the whole prompt.
    expect(mentions(r.prompt)).toEqual([]);
    // …and the word is still readable, which is the other half of the promise.
    expect(r.prompt).toContain('types/node');
    expect(r.prompt).toContain(AT_ESCAPE_NOTE);
  });

  it('says nothing about escaping when the sibling said nothing @-shaped', () => {
    const q = queries([OWN, TRADING], { 'live-a': ['the build is green'] });
    const r = run(q, 'and @TradingApp?');
    if (!r.ok) throw new Error('expected a send');
    expect(r.prompt).not.toContain(AT_ESCAPE_NOTE);
  });

  it('marks the block with a minted ref, labelled with the RESOLVED name (#830)', () => {
    const q = queries([OWN, TRADING], { 'live-a': ['output'] });
    const refs: string[] = [];
    // `@tradingapp` — a spelling that resolves but is not the session's own.
    // Hex, like the real `ContextRefs.mint` — the marker's own pattern only
    // accepts hex, which is itself one more thing a forger has to get right.
    const r = resolveMentions(q, renderOutput, 'ping @tradingapp', OWN.id, {
      fence: quoted,
      mint: () => {
        const ref = `0000000${refs.length}`;
        refs.push(ref);
        return ref;
      },
    });
    if (!r.ok) throw new Error('expected a send');
    const [found] = findContextSections(r.prompt, (ref) => refs.includes(ref));
    expect(found?.name).toBe('TradingApp');
    expect(found?.start).toBe(0);
    // The fence is INSIDE the envelope: this wraps the fenced brief, it does
    // not replace the fence.
    expect(r.prompt.slice(found?.start, found?.end)).toContain(CONTENT_FENCE);
  });

  it('sends exactly what it always sent when nothing mints — no envelope, still defused', () => {
    const q = queries([OWN, TRADING], { 'live-a': ['saw @types/node'] });
    const r = run(q, 'and @TradingApp?');
    if (!r.ok) throw new Error('expected a send');
    expect(findContextSections(r.prompt, () => true)).toEqual([]);
    expect(mentions(r.prompt)).toEqual([]);
  });
});
