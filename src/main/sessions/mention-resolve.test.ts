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
import { renderOutput, CONTENT_FENCE } from '../bus/bus-tools';
import { resolveMentions } from './mention-resolve';
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

const run = (q: SessionQueries, text: string) => resolveMentions(q, renderOutput, text, OWN.id);

describe('resolveMentions — a live session', () => {
  it("injects that session's output AHEAD of the prose, attributed, fenced, and with #764's wording", () => {
    const q = queries([OWN, TRADING], { 'live-a': ['the fix was a null check in parse()'] });
    const r = run(q, "take @TradingApp's fix and apply it here");
    if (!r.ok) throw new Error(r.refusals.join('; '));

    const [block, prose] = [r.prompt.slice(0, r.prompt.lastIndexOf('\n\n')), r.prompt.slice(r.prompt.lastIndexOf('\n\n') + 2)];
    // the SAME text the bus tool would have returned for this session
    const direct = q.sessionOutput('live-a');
    if (!direct.ok) throw new Error(direct.reason);
    expect(block).toBe(renderOutput(direct.value));
    expect(block).toContain('Recent output from TradingApp [id live-a]');
    expect(block).toContain('Long individual messages and tool results are shortened.');
    expect(block).toContain(CONTENT_FENCE);
    expect(block).toContain('the fix was a null check in parse()');
    // the prose: every word the user typed, with the mention out of `@` shape
    expect(prose).toBe(`take "TradingApp" (session)'s fix and apply it here`);
  });

  it('a session with NO transcript yet is an ok answer that says so — not a throw, not silence', () => {
    const r = run(queries([OWN, TRADING]), 'what is @TradingApp doing');
    expect(r).toEqual({
      ok: true,
      prompt: `TradingApp [id live-a] has not produced any readable output yet.\n\nwhat is "TradingApp" (session) doing`,
    });
  });

  it('resolves case-insensitively, the way `resolve` does, and names the session as it is spelled', () => {
    const r = run(queries([OWN, TRADING], { 'live-a': ['done'] }), 'ask @tradingapp');
    expect(r.ok && r.prompt.endsWith('ask "TradingApp" (session)')).toBe(true);
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
