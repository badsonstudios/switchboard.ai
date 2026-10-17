// The briefing's I/O half (#1295): which source each direction reads, where
// the exact text is kept, and that a ref from the renderer can never name a
// file outside the folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { createBriefingHost, parseBriefingRef, type BriefingRequest } from './ai-briefing-host';
import { slugForCwd } from '../transcripts/paths';
import type { ProviderCapabilities } from '../extensibility/contributions';
import type { Logger } from '../log/logger';
import type { AiSwitchMark } from '../../shared/ai-switch';
import type { FeedBlock } from '../feed/blocks';

const lines: string[] = [];
const log: Logger = {
  debug: () => {},
  info: (m) => void lines.push(m),
  warn: (m) => void lines.push(m),
  error: (m) => void lines.push(m),
  child: () => log,
};

let root: string;
let projects: string;
let folder: string;
beforeEach(() => {
  root = tempDir('sb-briefings-');
  projects = tempDir('sb-projects-');
  folder = tempDir('sb-folder-');
  lines.length = 0;
});
afterEach(() => cleanupTempDirs());

const CAPS: Record<string, ProviderCapabilities> = {
  'claude-code': { transcripts: { projectsRoot: () => projects }, instructionFiles: ['CLAUDE.md'] },
  codex: { instructionFiles: ['AGENTS.md'] },
};

const host = (caps: Record<string, ProviderCapabilities> = CAPS) =>
  createBriefingHost({
    root,
    capabilitiesOf: (id) => caps[id],
    cardTitle: (id) => (id === 'card-1' ? 'acme-storefront' : undefined),
    log,
  });

const mark = (from: string, to: string, id = 'm1'): AiSwitchMark => ({
  kind: 'ai-switch',
  id,
  from: { providerId: from, name: from === 'codex' ? 'Codex' : 'Claude Code' },
  to: { providerId: to, name: to === 'codex' ? 'Codex' : 'Claude Code' },
  at: '2026-10-16T10:00:00.000Z',
  briefed: false,
});

function writeTranscript(id: string, entries: unknown[]): void {
  const dir = path.join(projects, slugForCwd(folder));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const userLine = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });

const claudeToCodex = (over: Partial<BriefingRequest> = {}): BriefingRequest => ({
  cardId: 'card-1',
  folder,
  mark: mark('claude-code', 'codex'),
  fromConversation: { providerId: 'claude-code', nativeSessionId: 'claude-1' },
  ...over,
});

describe('the source, per direction', () => {
  it('leaving Claude: its own transcript, through its transcripts capability', () => {
    writeTranscript('claude-1', [userLine('the first claude turn'), userLine('the second claude turn')]);
    const got = host().brief(claudeToCodex());
    expect(got?.turnsSummarised).toBe(2);
    expect(got?.text).toContain('## Goal\n\nthe first claude turn\n');
    expect(got?.text).toContain('Claude Code read `CLAUDE.md`; you read `AGENTS.md`.');
    expect(got?.text).toContain('- **Card:** acme-storefront');
  });

  it('leaving an ACP agent: the Feed taken at the switch, since it writes no transcript we read', () => {
    const blocks = [{ seq: 1, kind: 'user', text: 'hello codex', sidechain: false }] as FeedBlock[];
    const got = host().brief({
      cardId: 'card-1',
      folder,
      mark: mark('codex', 'claude-code'),
      fromConversation: { providerId: 'codex', nativeSessionId: 'acp-1' },
      fromBlocks: blocks,
    });
    expect(got?.turnsSummarised).toBe(1);
    expect(got?.text).toContain('Codex read `AGENTS.md`; you read `CLAUDE.md`.');
  });

  it('a Claude conversation with no transcript yet falls back to the Feed, else hands over nothing', () => {
    const blocks = [{ seq: 1, kind: 'user', text: 'from the feed', sidechain: false }] as FeedBlock[];
    expect(host().brief(claudeToCodex({ fromBlocks: blocks }))?.text).toContain('from the feed');
    expect(host().brief(claudeToCodex())).toBeUndefined();
    expect(host().brief(claudeToCodex({ fromConversation: undefined }))).toBeUndefined();
  });

  it('leaving an ACP agent whose session was not open: a FAILURE, not "nothing to hand over"', () => {
    expect(() =>
      host().brief({
        cardId: 'card-1',
        folder,
        mark: mark('codex', 'claude-code'),
        fromConversation: { providerId: 'codex', nativeSessionId: 'acp-1' },
      })
    ).toThrow(/not open at the switch/);
    // …while one whose session was open with an EMPTY Feed held nothing to hand over
    expect(
      host().brief({
        cardId: 'card-1',
        folder,
        mark: mark('codex', 'claude-code'),
        fromConversation: { providerId: 'codex', nativeSessionId: 'acp-1' },
        fromBlocks: [],
      })
    ).toBeUndefined();
    // …and one with no conversation at all is simply nothing
    expect(host().brief({ cardId: 'card-1', folder, mark: mark('codex', 'claude-code') })).toBeUndefined();
  });

  it('an AI that declares no instruction files is "not known", never a guess', () => {
    writeTranscript('claude-1', [userLine('go')]);
    const caps = { ...CAPS, codex: {} };
    expect(host(caps).brief(claudeToCodex())?.text).toContain('which ones you read is not known');
  });
});

describe('the exact text', () => {
  it('is kept byte-exact, and the ref opens it', () => {
    writeTranscript('claude-1', [userLine('ünïcode — and emoji 🎛️ survive')]);
    const h = host();
    const got = h.brief(claudeToCodex())!;
    expect(got.briefingRef).toBe('card-1/m1');
    expect(h.read(got.briefingRef)).toEqual({ ok: true, text: got.text });
    expect(fs.readFileSync(path.join(root, 'card-1', 'm1.md'), 'utf8')).toBe(got.text);
  });

  it('a file that is gone reads as gone, never a throw', () => {
    expect(host().read('card-1/nope')).toEqual({ ok: false, reason: 'gone' });
  });

  it.each(['../x', 'card-1/../../etc', 'card-1/..', '..\\x/y', '/abs/path', 'a/b/c', '', 7, null, 'card-1', 'abc./m', 'CON/m', 'card-1/nul.md'])(
    'refuses a ref that is not one of ours: %o',
    (ref) => {
      expect(host().read(ref)).toEqual({ ok: false, reason: 'bad-ref' });
    }
  );

  it('parseBriefingRef accepts exactly <id>/<id>', () => {
    expect(parseBriefingRef('card-1/5b2e')).toEqual({ cardId: 'card-1', markId: '5b2e' });
    expect(parseBriefingRef('.hidden/x')).toBeUndefined();
  });

  it('briefings for marks the card no longer holds are removed when a new one is kept', () => {
    writeTranscript('claude-1', [userLine('go')]);
    const h = host();
    h.brief(claudeToCodex({ mark: mark('claude-code', 'codex', 'old') }));
    h.brief(claudeToCodex({ mark: mark('claude-code', 'codex', 'kept') }));
    h.brief(claudeToCodex({ mark: mark('claude-code', 'codex', 'new'), keepMarkIds: ['kept', 'new'] }));
    expect(fs.readdirSync(path.join(root, 'card-1')).sort()).toEqual(['kept.md', 'new.md']);
  });

  it('a closed card takes its briefings with it', () => {
    writeTranscript('claude-1', [userLine('go')]);
    const h = host();
    h.brief(claudeToCodex());
    h.forgetCard('card-1');
    expect(fs.existsSync(path.join(root, 'card-1'))).toBe(false);
    h.forgetCard('../escape'); // refused quietly, touches nothing
  });

  it('a briefing that cannot be KEPT is still returned — sent without a ref', () => {
    writeTranscript('claude-1', [userLine('go')]);
    fs.writeFileSync(path.join(root, 'card-1'), 'a file where the folder should be');
    const got = host().brief(claudeToCodex());
    expect(got?.text).toContain('go');
    expect(got?.briefingRef).toBeUndefined();
    expect(lines.some((l) => l.includes('could not be kept'))).toBe(true);
  });
});
