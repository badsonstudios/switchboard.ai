// The AI-switch briefing (E40 item 12, #1295) — deterministic, like the
// context package it is built from: a fixture conversation gives byte-exact
// text, a second run gives the same bytes, the size is capped with a stated
// marker, and `turnsSummarised` counts the user's turns. And the honesty and
// impedance rules are pinned on the document, where the reading model sees them.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  BRIEFING_CHAR_CAP,
  BRIEFING_HEADING,
  BRIEFING_TRIM_MARKER,
  buildBriefing,
  instructionFilesLine,
  type BriefingParty,
  type BriefingSource,
} from './ai-briefing';
import { buildPackageFrom, materialFromBlocks, materialFromEntries } from './context-package';
import type { FeedBlock } from '../feed/blocks';
import { transcriptLines } from '../transcripts/fixtures/session-transcript';

const userLine = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const assistantLine = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const toolLine = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResultLine = (id: string, out: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] },
});

const CLAUDE: BriefingParty = { providerId: 'claude-code', name: 'Claude Code', instructionFiles: ['CLAUDE.md'] };
const CODEX: BriefingParty = { providerId: 'codex', name: 'Codex', instructionFiles: ['AGENTS.md'] };

const CONVERSATION = [
  userLine('Add a dark mode toggle to the settings page'),
  toolLine('t1', 'Read', { file_path: 'src/settings.tsx' }),
  toolResultLine('t1', 'export function Settings() {}'),
  toolLine('t2', 'Edit', { file_path: 'src/settings.tsx', old_string: 'a', new_string: 'b' }),
  toolResultLine('t2', 'ok'),
  toolLine('t3', 'TodoWrite', {
    todos: [
      { content: 'Add the toggle', status: 'completed' },
      { content: 'Remember the choice between visits', status: 'pending' },
    ],
  }),
  assistantLine('The toggle is on the settings page. The choice is not remembered after a reload yet.'),
  userLine('Good. Keep it in the same style as the other switches'),
  assistantLine('Done — it matches the other switches.'),
];

const source = (over: Partial<BriefingSource> = {}): BriefingSource => ({
  from: CLAUDE,
  to: CODEX,
  cardTitle: 'acme-storefront',
  folder: 'C:/Projects/acme-storefront',
  material: materialFromEntries(CONVERSATION),
  cut: false,
  ...over,
});

const EXPECTED = [
  '# Briefed continuation from Claude Code to Codex',
  '',
  'You are Codex. This conversation was started with Claude Code, and the user has just switched it to you. ' +
    'This is a briefed continuation, not a resume: you have not seen the conversation itself, only this summary ' +
    'of it. The summary was extracted mechanically from the conversation — no model wrote it — so it reports ' +
    'what the conversation contains, not what it meant.',
  '',
  '- **Card:** acme-storefront',
  '- **Folder:** C:/Projects/acme-storefront',
  '- **Covers:** the whole conversation',
  "- **Summarises:** 2 of the user's turns",
  '',
  '## Goal',
  '',
  'Add a dark mode toggle to the settings page',
  '',
  '## What the user asked for along the way',
  '',
  '- Good. Keep it in the same style as the other switches',
  '',
  '## Plan / todo state',
  '',
  '1 of 2 done, 0 in progress.',
  '',
  '- [completed] Add the toggle',
  '- [pending] Remember the choice between visits',
  '',
  '## Files touched',
  '',
  '- src/settings.tsx — edited, read (2 calls)',
  '',
  '## Recent activity',
  '',
  'User: Add a dark mode toggle to the settings page',
  '',
  '[Read] src/settings.tsx',
  '  -> export function Settings() {}',
  '',
  '[Edit] src/settings.tsx',
  '  -> ok',
  '',
  '- [completed] Add the toggle',
  '- [pending] Remember the choice between visits',
  '',
  'Claude Code: The toggle is on the settings page. The choice is not remembered after a reload yet.',
  '',
  'User: Good. Keep it in the same style as the other switches',
  '',
  'Claude Code: Done — it matches the other switches.',
  '',
  '## Where it left off',
  '',
  'Done — it matches the other switches.',
  '',
  'Last action: Edit src/settings.tsx',
  '',
  '## Next step',
  '',
  'The open item on the plan: Remember the choice between visits',
  '',
  '## What does not carry over',
  '',
  '- Instruction files: Claude Code read `CLAUDE.md`; you read `AGENTS.md`. If this folder has `CLAUDE.md`, ' +
    'it holds the instructions Claude Code was working under, and you will not read it on your own.',
  '- MCP servers, permissions and hooks set up for Claude Code do not transfer to you.',
  "- Neither does Claude Code's own memory of this conversation: this summary is all you have of it.",
  '',
  'Do not start work from this summary alone. Reply in a sentence or two with where things stand, then wait ' +
    "for the user's next message.",
  '',
].join('\n');

describe('the briefing is deterministic', () => {
  it('a fixture conversation gives these exact bytes', () => {
    expect(buildBriefing(source())?.text).toBe(EXPECTED);
  });

  it('a second run gives identical bytes — on the repo’s real 7 MB transcript too', () => {
    expect(buildBriefing(source())?.text).toBe(buildBriefing(source())?.text);
    const real = transcriptLines().map((l) => JSON.parse(l) as Record<string, unknown>);
    const a = buildBriefing(source({ material: materialFromEntries(real) }));
    const b = buildBriefing(source({ material: materialFromEntries(real) }));
    expect(a?.text).toBeTruthy();
    expect(a?.text).toBe(b?.text);
    expect(a?.text.length).toBeLessThanOrEqual(BRIEFING_CHAR_CAP);
  });

  it('turnsSummarised counts the user’s own turns — not tool results, not the AI', () => {
    expect(buildBriefing(source())?.turnsSummarised).toBe(2);
  });

  it('a conversation with no turn of the user’s hands over nothing', () => {
    expect(buildBriefing(source({ material: materialFromEntries([assistantLine('hello')]) }))).toBeUndefined();
    expect(buildBriefing(source({ material: materialFromEntries([]) }))).toBeUndefined();
  });

  it('is capped, says where it was cut, and ALWAYS keeps what does not carry over', () => {
    // Every section is capped on its own, so only the one section whose LINES
    // are not — sixty files with very long paths — can carry the sum past the
    // whole document's cap. Which is exactly what the cap is a backstop for.
    const huge = Array.from({ length: 80 }, (_, i) => [
      userLine(`request ${i} `.padEnd(590, 'x')),
      toolLine(`t${i}`, 'Edit', { file_path: `src/${'deep/'.repeat(80)}file-${i}.ts` }),
      toolResultLine(`t${i}`, 'z'.repeat(590)),
      assistantLine(`reply ${i} `.padEnd(1900, 'w')),
    ]).flat();
    const text = buildBriefing(source({ material: materialFromEntries(huge) }))!.text;
    expect(text.length).toBeLessThanOrEqual(BRIEFING_CHAR_CAP);
    expect(text).toContain(BRIEFING_TRIM_MARKER);
    expect(text.startsWith(BRIEFING_HEADING)).toBe(true);
    expect(text).toContain('## What does not carry over');
    expect(text).toContain('`AGENTS.md`');
    expect(text.endsWith("then wait for the user's next message.\n")).toBe(true);
    // and a briefing under the cap carries no marker at all
    expect(buildBriefing(source())!.text).not.toContain(BRIEFING_TRIM_MARKER);
  });
});

describe('the honesty rule and the impedance rule, in the document', () => {
  it('calls itself a briefed continuation and never claims to be a resume of THIS AI’s', () => {
    const text = buildBriefing(source())!.text;
    expect(text).toContain('This is a briefed continuation, not a resume');
    expect(text).toContain('You are Codex. This conversation was started with Claude Code');
    expect(text).toContain('MCP servers, permissions and hooks set up for Claude Code do not transfer to you.');
  });

  it('the AI being left speaks under its OWN name in the recent activity', () => {
    const fromCodex = buildBriefing(source({ from: CODEX, to: CLAUDE }))!.text;
    expect(fromCodex).toContain('Codex: Done — it matches the other switches.');
    expect(fromCodex).not.toMatch(/^Claude: /m);
  });

  it.each([
    [CLAUDE, CODEX, 'Claude Code read `CLAUDE.md`; you read `AGENTS.md`. If this folder has `CLAUDE.md`'],
    [CODEX, CLAUDE, 'Codex read `AGENTS.md`; you read `CLAUDE.md`. If this folder has `AGENTS.md`'],
    [CODEX, { ...CODEX, providerId: 'fake-acp', name: 'Fake ACP' }, 'Codex read `AGENTS.md`, and so do you.'],
    [CLAUDE, { providerId: 'custom', name: 'Mine' }, 'Claude Code read `CLAUDE.md`; which ones you read is not known.'],
    [{ providerId: 'custom', name: 'Mine' }, CODEX, 'you read `AGENTS.md`; which ones Mine read is not known.'],
    [
      { providerId: 'a', name: 'A' },
      { providerId: 'b', name: 'B' },
      'which project instruction files A read, and which you read, is not known.',
    ],
  ])('instruction files: %o → %o', (from, to, says) => {
    expect(instructionFilesLine(from, to)).toContain(says);
  });

  it('a card title or AI name cannot break the header', () => {
    const text = buildBriefing(source({ cardTitle: 'two\nlines', to: { ...CODEX, name: 'Co\ndex' } }))!.text;
    expect(text.split('\n')[0]).toBe('# Briefed continuation from Claude Code to Co dex');
    expect(text).toContain('- **Card:** two lines');
  });
});

describe('both sources meet in one intermediate', () => {
  it('Feed blocks (an ACP agent’s conversation) brief the same sections, with files from tool.filePath', () => {
    const blocks: FeedBlock[] = [
      { seq: 1, kind: 'user', text: 'Remember the dark mode choice', sidechain: false },
      {
        seq: 2,
        kind: 'tool',
        sidechain: false,
        tool: { name: 'Edit src/hooks/useTheme.ts', category: 'edit', summary: 'src/hooks/useTheme.ts', filePath: 'src/hooks/useTheme.ts', editPath: 'src/hooks/useTheme.ts' },
      },
      { seq: 3, kind: 'tool', sidechain: false, tool: { name: 'Read', category: 'read', summary: 'a.ts', filePath: 'a.ts' } },
      { seq: 4, kind: 'assistant', text: 'Persisted in localStorage.', sidechain: false },
    ] as FeedBlock[];
    const b = buildBriefing(source({ from: CODEX, to: CLAUDE, material: materialFromBlocks(blocks) }))!;
    expect(b.turnsSummarised).toBe(1);
    expect(b.text).toContain('## Goal\n\nRemember the dark mode choice\n');
    expect(b.text).toContain('- src/hooks/useTheme.ts — edited (1 call)');
    expect(b.text).toContain('- a.ts — read (1 call)');
    expect(b.text).toContain('Codex: Persisted in localStorage.');
    expect(b.text).toBe(buildBriefing(source({ from: CODEX, to: CLAUDE, material: materialFromBlocks(blocks) }))!.text);
  });

  it('a subagent’s file counts, as it does on the transcript path — the two sources agree', () => {
    const blocks = [
      { seq: 1, kind: 'user', text: 'go', sidechain: false },
      { seq: 2, kind: 'tool', sidechain: true, tool: { name: 'Edit', category: 'edit', summary: 'x', filePath: 'x.ts' } },
    ] as FeedBlock[];
    expect([...materialFromBlocks(blocks).files.keys()]).toEqual(['x.ts']);
  });
});

describe('a briefing is never read back as the user’s words (review finding)', () => {
  it('a SECOND switch summarises the conversation, not the summary: the briefing is not a turn, a goal or a last request', () => {
    const first = buildBriefing(source())!.text;
    // Codex’s conversation: the briefing went in as its first prompt, then real turns
    const codexFeed = [
      { seq: 1, kind: 'user', text: first, sidechain: false },
      { seq: 2, kind: 'assistant', text: 'Where things stand: the toggle is in.', sidechain: false },
      { seq: 3, kind: 'user', text: 'now remember it between visits', sidechain: false },
    ] as FeedBlock[];
    const third = { providerId: 'gemini', name: 'Gemini CLI' };
    const second = buildBriefing(source({ from: CODEX, to: third, material: materialFromBlocks(codexFeed) }))!;
    expect(second.turnsSummarised).toBe(1);
    expect(second.text).toContain('## Goal' + String.fromCharCode(10, 10) + 'now remember it between visits');
    expect(second.text).toContain('The user\'s last request: now remember it between visits');
    expect(second.text.split('# Briefed continuation from').length).toBe(2); // its own heading only
  });

  it('a briefing alone is nothing to hand over', () => {
    const only = [{ seq: 1, kind: 'user', text: buildBriefing(source())!.text, sidechain: false }] as FeedBlock[];
    expect(buildBriefing(source({ from: CODEX, to: CLAUDE, material: materialFromBlocks(only) }))).toBeUndefined();
  });

  it('a context package over a briefed session does not take the briefing as its goal', () => {
    const entries = [userLine(buildBriefing(source())!.text), userLine('the real ask')];
    const pkg = buildPackageFrom({ session: { id: 's', name: 'n', folder: 'f', providerId: 'codex', status: 'done', exited: true }, material: materialFromEntries(entries), cut: false });
    expect(pkg.sections.find((s) => s.id === 'goal')?.text).toBe('the real ask');
  });

  it('a summary of the recent end of a long conversation says it is partial', () => {
    expect(buildBriefing(source())!.partial).toBe(false);
    expect(buildBriefing(source({ cut: true, goalFromHead: 'the goal' }))!.partial).toBe(true);
  });
});

describe('no model, no clock, no I/O', () => {
  const read = (name: string) => {
    const src = fs.readFileSync(path.join(__dirname, name), 'utf8');
    return {
      code: src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      imports: [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]),
    };
  };

  it('ai-briefing.ts is pure: no clock, no randomness, no locale, no files, no programs', () => {
    const { code, imports } = read('ai-briefing.ts');
    expect(imports.length).toBeGreaterThan(1);
    for (const spec of imports) {
      expect(spec).not.toMatch(/^(node:)?(fs|path|child_process|net|http|https|os)$/);
      expect(spec).not.toMatch(/provider|anthropic|claude|openai|sdk/i);
    }
    expect(code).not.toMatch(/Date\.now|new Date|performance\.now|Math\.random|toLocale|Intl\.|process\.env/);
    expect(code).not.toMatch(/\b(spawn|exec|execFile|fork)\s*\(|\bfetch\s*\(|require\(|await import\(/);
  });

  it('the host reads and writes files, and runs nothing', () => {
    const { code, imports } = read('ai-briefing-host.ts');
    for (const spec of imports) {
      expect(spec).not.toMatch(/child_process|^(node:)?(net|http|https)$|provider|anthropic|claude|openai/i);
    }
    expect(code).not.toMatch(/\b(spawn|exec|execFile|fork)\s*\(|\bfetch\s*\(|require\(|await import\(/);
  });
});
