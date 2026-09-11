// The Level-2 context package (P2-E11-09, §5.5, #766).
//
// THREE OF THIS ITEM'S FOUR DONE-WHENS ARE NEGATIVE CLAIMS — byte-stable, still
// usable with no tool calls, no LLM invoked — and a negative claim is exactly
// the kind a suite passes by accident. So each one is pinned by a test that a
// plausible wrong implementation FAILS, not merely by one the right
// implementation passes:
//
//  * "byte-stable" is checked against the repo's REAL 7.37 MB transcript, twice
//    through the whole pipeline, not against a six-line fixture whose output has
//    nowhere to vary.
//  * "no LLM" is asserted against the SOURCE TEXT, the way `queries.test.ts`
//    asserts transport-freedom — a behavioural test cannot prove a spawn does
//    not exist on a branch the test did not take.
//  * "a transcript with no tool calls still yields a usable package" is checked
//    on the RENDERED document, because an object full of empty strings would
//    satisfy the same sentence read loosely.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ACTIVITY_TRIM_MARKER,
  CHARS_PER_TOKEN,
  GOAL_CHAR_CAP,
  MAX_FILES,
  MAX_INSTRUCTIONS,
  PACKAGE_CAPS,
  PLAN_CHAR_CAP,
  SNIPPET_BLOCKS,
  SNIPPET_CHAR_CAP,
  STATE_CHAR_CAP,
  buildContextPackage,
  estimateTokens,
  renderPackage,
  type ContextPackage,
  type SectionId,
} from './context-package';
import {
  OUTPUT_CHAR_CAP,
  PACKAGE_HEAD_BYTES,
  PACKAGE_TAIL_BYTES,
  SessionQueries,
  type DiffSource,
  type SessionSummary,
} from './queries';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { HISTORY_MAX_LINES } from '../feed/history';
import { SESSION_TRANSCRIPT, transcriptLines } from '../transcripts/fixtures/session-transcript';

let dir: string;

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'sess-1',
  name: 'TradingApp',
  folder: 'C:/Projects/TradingApp',
  providerId: 'claude-code',
  status: 'working',
  exited: false,
  ...over,
});

/** Transcript lines in the real shape the CLI writes (`queries.test.ts`'s). */
const userLine = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const assistantLine = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
const toolLine = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
const toolResultLine = (id: string, out: string) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out }] },
  });
const todoLine = (id: string, todos: Array<{ content: string; status: string }>) =>
  toolLine(id, 'TodoWrite', { todos });

const entriesOf = (lines: string[]): Record<string, unknown>[] =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>);

/** The pure builder over hand-written lines. */
const build = (lines: string[], over: Partial<Parameters<typeof buildContextPackage>[0]> = {}) =>
  buildContextPackage({ session: session(), entries: entriesOf(lines), cut: false, ...over });

const sectionOf = (pkg: ContextPackage, id: SectionId) => {
  const s = pkg.sections.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
};

const noDiff: DiffSource = { diff: async () => ({ isRepo: false, text: '' }) };

function writeTranscript(lines: string[], name = 'conv.jsonl'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function queriesOver(file: string | null, sessions: SessionSummary[] = [session()]) {
  return new SessionQueries({ list: () => sessions, transcriptFor: () => file, git: noDiff });
}

beforeEach(() => {
  dir = tempDir('sb-ctxpkg-');
});
afterEach(() => cleanupTempDirs());

describe('the sections §5.5 asks for', () => {
  it('takes the goal from the FIRST prompt, not the most recent one', () => {
    const pkg = build([
      userLine('Port the settings pane to the new theme tokens.'),
      assistantLine('On it.'),
      userLine('actually do the sidebar first'),
    ]);
    expect(sectionOf(pkg, 'goal').text).toBe('Port the settings pane to the new theme tokens.');
    // And the later one is NOT silently folded in — it is the other section.
    expect(sectionOf(pkg, 'goal').text).not.toContain('sidebar');
  });

  it("prefers the head window's prompt over the window's oldest when given one", () => {
    // The whole reason `sessionContext` reads two windows: on a long session the
    // tail's first prompt is merely the oldest SURVIVOR, not the task statement.
    const pkg = build([userLine('bump the timeout'), assistantLine('done')], {
      goalFromHead: 'Build a context package generator.',
      cut: true,
    });
    expect(sectionOf(pkg, 'goal').text).toBe('Build a context package generator.');
    // …and the window's own first prompt then belongs to the instructions, not
    // dropped as though it had been the goal.
    expect(sectionOf(pkg, 'instructions').text).toContain('bump the timeout');
  });

  it('does not repeat the goal as an instruction when BOTH windows held it', () => {
    // The narrow band the two-window read can land in: a transcript just past
    // the tail budget has a tail that is cut AND that still reaches the file's
    // first line. Keying "is there a later prompt" off `goalFromHead` being
    // present rather than off the TEXT would print the task statement twice —
    // once as the goal, once as the user's first course correction.
    const pkg = build([userLine('THE GOAL'), userLine('a correction')], {
      goalFromHead: 'THE GOAL',
      cut: true,
    });
    expect(sectionOf(pkg, 'goal').text).toBe('THE GOAL');
    expect(sectionOf(pkg, 'instructions').text).toBe('- a correction');
  });

  it('keeps the last action even when the closing paragraph fills the section', () => {
    // Capping the two joined would let a long final message push the one line
    // that says what the session was actually DOING off the end.
    const pkg = build([
      toolLine('a', 'Edit', { file_path: 'src/app.ts' }),
      assistantLine('p'.repeat(STATE_CHAR_CAP + 500)),
    ]);
    const state = sectionOf(pkg, 'state');
    expect(state.truncated).toBe(true);
    expect(state.text).toContain('…[truncated]');
    expect(state.text).toContain('Last action: Edit src/app.ts');
  });

  it('lists later prompts as instructions, newest last, and never the goal twice', () => {
    const pkg = build([
      userLine('goal prompt'),
      userLine('first correction'),
      userLine('second correction'),
    ]);
    const text = sectionOf(pkg, 'instructions').text;
    expect(text).toBe('- first correction\n- second correction');
    expect(text).not.toContain('goal prompt');
  });

  it('keeps only the newest todo list, because TodoWrite rewrites the whole thing', () => {
    const pkg = build([
      userLine('go'),
      todoLine('t1', [{ content: 'superseded item', status: 'pending' }]),
      todoLine('t2', [
        { content: 'wire the reader', status: 'completed' },
        { content: 'write the renderer', status: 'in_progress' },
        { content: 'document it', status: 'pending' },
      ]),
    ]);
    const plan = sectionOf(pkg, 'plan').text;
    expect(plan).toContain('1 of 3 done, 1 in progress.');
    expect(plan).toContain('- [in_progress] write the renderer');
    expect(plan).not.toContain('superseded item');
  });

  it('records files from every key that names one, with a verb and a count', () => {
    const pkg = build([
      userLine('go'),
      toolLine('a', 'Read', { file_path: 'src/app.ts' }),
      toolLine('b', 'Edit', { file_path: 'src/app.ts' }),
      toolLine('c', 'Glob', { path: 'src/components' }),
      toolLine('d', 'NotebookEdit', { notebook_path: 'notes.ipynb' }),
    ]);
    const files = sectionOf(pkg, 'files').text;
    expect(files).toContain('- src/app.ts — edited, read (2 calls)');
    expect(files).toContain('- src/components — looked at (1 call)');
    expect(files).toContain('- notes.ipynb — edited (1 call)');
  });

  it('pins a verb for every tool that names a file, not just the common three', () => {
    // `Write`, `MultiEdit` and `NotebookRead` appeared in no assertion, so
    // mapping `Write` to "edited" — which understates a file being created
    // wholesale — survived the suite.
    const pkg = build([
      toolLine('a', 'Write', { file_path: 'new.ts' }),
      toolLine('b', 'MultiEdit', { file_path: 'multi.ts' }),
      toolLine('c', 'NotebookRead', { notebook_path: 'r.ipynb' }),
      toolLine('d', 'Grep', { path: 'src' }),
      toolLine('e', 'SomeToolNobodyHasWrittenYet', { file_path: 'future.ts' }),
    ]);
    const files = sectionOf(pkg, 'files').text;
    expect(files).toContain('- new.ts — wrote (1 call)');
    expect(files).toContain('- multi.ts — edited (1 call)');
    expect(files).toContain('- r.ipynb — read (1 call)');
    expect(files).toContain('- src — looked at (1 call)');
    // An unknown tool claims the weakest verb it can. Guessing "edited" for a
    // tool we have never seen would invent a change that never happened.
    expect(files).toContain('- future.ts — looked at (1 call)');
  });

  it('ignores CLI-internal lines when counting files, as the prose sections do', () => {
    // The one deliberate divergence from the watcher's otherwise-identical
    // walk, and therefore the line most likely to be "tidied up" later: nothing
    // pinned it, so deleting it survived.
    const meta = JSON.stringify({
      type: 'assistant',
      isMeta: true,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'm', name: 'Read', input: { file_path: 'internal.ts' } }],
      },
    });
    const pkg = build([meta, toolLine('a', 'Read', { file_path: 'real.ts' })]);
    expect(sectionOf(pkg, 'files').text).toContain('real.ts');
    expect(sectionOf(pkg, 'files').text).not.toContain('internal.ts');
  });

  it('does NOT put a shell command in the list of files touched', () => {
    // `toolIntent`'s `primary` falls through to `command`/`description`/
    // `pattern` because it is building a label. Reusing that rule here would
    // file `npm test -- --coverage` as a file this session touched.
    const pkg = build([userLine('go'), toolLine('a', 'Bash', { command: 'npm test' })]);
    expect(sectionOf(pkg, 'files').text).toBe('');
    expect(renderPackage(pkg)).toContain('_No file has been read or changed._');
    // It is still REPORTED, just not as a file — the command is what the
    // session last did, and losing it would be its own wrong answer.
    expect(sectionOf(pkg, 'activity').text).toContain('[Bash] npm test');
    expect(sectionOf(pkg, 'state').text).toContain('Last action: Bash npm test');
  });

  it("attaches a tool's OUTPUT to its call, where the failure actually is", () => {
    // The single most useful line in a handoff is often the one that says what
    // broke, and it arrives as a `tool_result` on a LATER transcript line than
    // the call it belongs to. `PACKAGE_CAPS.detail` is 600 rather than 0 for
    // exactly this — 0 would render every tool row without its `-> …` half and
    // lose the failure silently.
    const pkg = build([
      userLine('go'),
      toolLine('a', 'Bash', { command: 'npm test' }),
      toolResultLine('a', 'FAIL src/app.test.ts — 1 failed, 40 passed'),
    ]);
    expect(sectionOf(pkg, 'activity').text).toContain('[Bash] npm test');
    expect(sectionOf(pkg, 'activity').text).toContain('-> FAIL src/app.test.ts — 1 failed');
    expect(PACKAGE_CAPS.detail).toBeGreaterThan(0);
  });

  it('reports where it left off from the last assistant line and the last tool call', () => {
    const pkg = build([
      userLine('go'),
      assistantLine('Older thought.'),
      toolLine('a', 'Edit', { file_path: 'src/app.ts' }),
      assistantLine('The reader is wired; the renderer is next.'),
    ]);
    const state = sectionOf(pkg, 'state').text;
    expect(state).toContain('The reader is wired; the renderer is next.');
    expect(state).toContain('Last action: Edit src/app.ts');
    expect(state).not.toContain('Older thought.');
  });

  it('never reports a subagent as the user, the session, or its last action', () => {
    // A `Task` call's brief and a subagent's replies land in the SAME file as
    // sidechain lines. Reporting one as the human's goal, or as what this
    // session last did, is a misattribution the reader cannot detect.
    const side = (line: string) => {
      const e = JSON.parse(line) as Record<string, unknown>;
      e.isSidechain = true;
      return JSON.stringify(e);
    };
    const pkg = build([
      side(userLine('SUBAGENT BRIEF: go and read everything')),
      userLine('The real goal.'),
      assistantLine('Working.'),
      side(assistantLine('SUBAGENT SAYS it is done')),
      side(toolLine('s1', 'Read', { file_path: 'sub.ts' })),
    ]);
    expect(sectionOf(pkg, 'goal').text).toBe('The real goal.');
    expect(sectionOf(pkg, 'instructions').text).not.toContain('SUBAGENT BRIEF');
    expect(sectionOf(pkg, 'state').text).toContain('Working.');
    expect(sectionOf(pkg, 'state').text).not.toContain('SUBAGENT SAYS');
    expect(sectionOf(pkg, 'state').text).not.toContain('Last action: Read sub.ts');
    // Its FILE edits do count — that work really happened in this session, and
    // the watcher's `filesTouched` counts them too.
    expect(sectionOf(pkg, 'files').text).toContain('sub.ts');
  });
});

describe('a transcript with no tool calls still yields a usable package', () => {
  // The done-when, checked on the rendered document rather than the object: a
  // package of six empty strings satisfies "yields a package" and briefs nobody.
  const planningOnly = [
    userLine('Should we use a named pipe or loopback HTTP for the bus?'),
    assistantLine('A named pipe: it deletes the DNS-rebinding class rather than hardening it.'),
    userLine('agreed, write that down'),
  ];

  it('fills the sections it can and says so plainly for the ones it cannot', () => {
    const doc = renderPackage(build(planningOnly));
    expect(doc).toContain('Should we use a named pipe or loopback HTTP for the bus?');
    expect(doc).toContain('- agreed, write that down');
    expect(doc).toContain('A named pipe: it deletes the DNS-rebinding class');
    // The empty ones are SENTENCES, not blanks under a heading.
    expect(doc).toContain('_No file has been read or changed._');
    expect(doc).toContain('_This session kept no todo list._');
    expect(doc).not.toMatch(/## [^\n]+\n\n\n/);
  });

  it('never leaves a heading with nothing under it, for any section', () => {
    const pkg = build(planningOnly);
    for (const s of pkg.sections) {
      const rendered = renderPackage(pkg);
      const at = rendered.indexOf(`## ${s.title}`);
      expect(at).toBeGreaterThan(-1);
      const body = rendered.slice(at + s.title.length + 3).split('\n##')[0].trim();
      expect(body.length).toBeGreaterThan(0);
    }
  });

  it('yields a whole document for a session that has produced nothing at all', () => {
    const doc = renderPackage(build([]));
    expect(doc).toContain('# Context from @TradingApp');
    expect(doc).toContain('_This session has not been given a prompt yet._');
    expect(doc.trim().length).toBeGreaterThan(200);
  });

  it('distinguishes "nothing happened" from "I did not look that far back"', () => {
    // The same empty section means two very different things, and a handoff
    // that conflated them would report a blind spot as a fact about the work.
    expect(renderPackage(build([]))).toContain('_No file has been read or changed._');
    expect(renderPackage(build([], { cut: true }))).toContain(
      '_No file was read or changed in the part of the conversation this covers._'
    );
  });
});

describe('the goal is never guessed (review blocker)', () => {
  // THE FAILURE THE TWO-WINDOW READ EXISTS TO PREVENT, reachable by a second
  // route: the head window can be consumed entirely by one pasted-attachment
  // line (a 100 KB screenshot is ~137 KB of base64, already over budget), and
  // `firstPrompt` is fail-open so a read error arrives the same way. Falling
  // back to the tail's oldest prompt puts a mid-conversation instruction under
  // the heading "Goal" — confidently wrong, in the one line that matters most.
  it('says the goal is unknown rather than promoting the oldest surviving prompt', () => {
    const pkg = build([userLine('a much later instruction'), assistantLine('ok')], {
      cut: true, // no goalFromHead: the head read found nothing
    });
    expect(sectionOf(pkg, 'goal').text).toBe('');
    expect(renderPackage(pkg)).toContain(
      '_The opening prompt is not in the part of the conversation this covers._'
    );
  });

  it('does not then LOSE that prompt — it is a later instruction, not the goal', () => {
    const pkg = build([userLine('a much later instruction')], { cut: true });
    expect(sectionOf(pkg, 'instructions').text).toBe('- a much later instruction');
  });

  it('still uses the window\'s first prompt when the window WAS the whole file', () => {
    // The fallback is wrong only when the window is cut. On a complete read,
    // `prompts[0]` genuinely IS the opening prompt.
    const pkg = build([userLine('the opening prompt'), userLine('a correction')], { cut: false });
    expect(sectionOf(pkg, 'goal').text).toBe('the opening prompt');
    expect(sectionOf(pkg, 'instructions').text).toBe('- a correction');
  });

  it('reads an ATTACHMENT-ONLY opening turn through the head window too', () => {
    // ROUND 2 FOUND THIS INSIDE ROUND 1'S FIX. `firstPrompt` had its own copy
    // of "is this the user speaking" and the copy disagreed about attachment-
    // only turns: it skipped them and returned the SECOND prompt, printed under
    // the heading "Goal" — round 1's blocker, reached through the fix for it.
    // Every earlier test of this exercised the pure builder, never the head
    // read, which is exactly why it survived.
    const attachOnly = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'image' }] },
    });
    const filler = assistantLine('f'.repeat(4_000));
    const lines = [attachOnly, userLine('fix the flaky timeout test')];
    const needed = Math.ceil(PACKAGE_TAIL_BYTES / (filler.length + 1)) + 20;
    for (let i = 0; i < needed; i++) lines.push(filler);
    const r = queriesOver(writeTranscript(lines)).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package');
    expect(sectionOf(r.value, 'goal').text).toBe('[the user sent 1 image with no text]');
    expect(sectionOf(r.value, 'goal').text).not.toContain('flaky timeout');
  });

  it('reaches the goal end to end when the head read CAN find it', () => {
    const filler = assistantLine('f'.repeat(4_000));
    const lines = [userLine('THE ORIGINAL TASK')];
    const needed = Math.ceil(PACKAGE_TAIL_BYTES / (filler.length + 1)) + 20;
    for (let i = 0; i < needed; i++) lines.push(filler);
    const r = queriesOver(writeTranscript(lines)).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package');
    expect(sectionOf(r.value, 'goal').text).toBe('THE ORIGINAL TASK');
  });

  it('does not lose a session that opened with an attachment and no words', () => {
    // #491's attachment-only turn produces a block with no text at all, so a
    // filter on text alone drops it — and a session that OPENED that way would
    // report no goal with no explanation.
    const attachOnly = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'image' }, { type: 'document' }] },
    });
    const pkg = build([attachOnly, assistantLine('I see a screenshot of a stack trace.')]);
    expect(sectionOf(pkg, 'goal').text).toBe(
      '[the user sent 1 image and 1 document with no text]'
    );
  });
});

describe('a transcript that could not be read is not a session that did nothing', () => {
  // #772's lie, one layer up: `entries: []` is what an unreadable transcript
  // and a brand-new session both look like, and reporting the first as "the
  // whole conversation" turns a fact about the READ into a fact about the WORK.
  it('reports coverage "unreadable" rather than "whole"', () => {
    const pkg = build([], { unreadable: true });
    expect(pkg.coverage).toBe('unreadable');
  });

  it('says so loudly enough that a model cannot draw the wrong conclusion', () => {
    const doc = renderPackage(build([], { unreadable: true }));
    expect(doc).toContain("this session's transcript could not be read");
    expect(doc).toContain('NOT what the session did');
    expect(doc).not.toContain('the whole conversation');
  });

  it('hedges EVERY empty section, not just the two that used to', () => {
    // `plan` and `state` read as facts about the session — "kept no todo list",
    // "has not said anything yet" — when all they knew was how far back the
    // read went. `sessionContext`'s doc calls that exact sentence a confident
    // wrong answer while justifying the 2 MB budget.
    const doc = renderPackage(build([], { cut: true }));
    expect(doc).toContain('_No todo list in the part of the conversation this covers._');
    expect(doc).toContain(
      '_Nothing in the part of the conversation this covers says where it left off._'
    );
    expect(doc).not.toContain('_This session kept no todo list._');
    expect(doc).not.toContain('_The session has not said anything yet._');
  });

  it('a session with NO transcript at all is still "whole" — nothing was missed', () => {
    const r = queriesOver(null).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package');
    expect(r.value.coverage).toBe('whole');
  });

  it('a transcriptFor that THROWS is unreadable, not "this session has none"', () => {
    // `attempt(…, null)` mapped a throw onto the no-transcript branch, which
    // answers `coverage: 'whole'` — so a dependency blowing up produced a
    // document saying the session had done nothing, over a claim to cover all
    // of it. Defensive today; the `attempt` wrapper is there because someone
    // thought it might not stay so.
    const q = new SessionQueries({
      list: () => [session()],
      transcriptFor: () => {
        throw new Error('the transcript index is unavailable');
      },
      git: noDiff,
    });
    const r = q.sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package, not a refusal');
    expect(r.value.coverage).toBe('unreadable');
  });

  it('says "not known" under every heading when it covered nothing', () => {
    // "…in the part of the conversation this covers" is vacuous beneath a
    // `Covers: nothing` header — it reads as though something WAS covered.
    const doc = renderPackage(build([], { unreadable: true }));
    expect(doc).toContain('_Not known — the transcript could not be read._');
    expect(doc).not.toContain('the part of the conversation this covers');
  });

  it('a transcript path that names a file which is not there is unreadable', () => {
    const r = queriesOver(path.join(dir, 'vanished.jsonl')).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package');
    expect(r.value.coverage).toBe('unreadable');
    expect(renderPackage(r.value)).toContain('could not be read');
  });
});

describe('what the derivation cut before the package ever saw it', () => {
  it('reports a tool result truncated inside the derivation', () => {
    // Measured by review: a 5,016-char result ending in the actual error came
    // back as its first 600 with `truncated: false` — the section swearing it
    // was complete while holding none of the thing worth handing over.
    const pkg = build([
      toolLine('a', 'Bash', { command: 'npm test' }),
      toolResultLine('a', 'x'.repeat(5_000) + 'THE-ACTUAL-ERROR'),
    ]);
    const s = sectionOf(pkg, 'activity');
    expect(s.text).not.toContain('THE-ACTUAL-ERROR');
    expect(s.truncated).toBe(true);
  });

  it('reports a tool summary truncated inside the derivation', () => {
    const pkg = build([toolLine('a', 'Bash', { command: 'c'.repeat(400) })]);
    expect(sectionOf(pkg, 'activity').truncated).toBe(true);
    expect(sectionOf(pkg, 'state').truncated).toBe(true);
  });

  it('does NOT cry truncation over a short tool result', () => {
    // The flag has to be worth something: if it were always true it would carry
    // no information and the section above would pass on a constant.
    const pkg = build([
      toolLine('a', 'Bash', { command: 'npm test' }),
      toolResultLine('a', '1 failed, 40 passed'),
    ]);
    expect(sectionOf(pkg, 'activity').truncated).toBe(false);
  });

  it('does not cry truncation over a big tool INPUT the document never shows', () => {
    // Measured in review: counting `tool.detail` — the stringified tool INPUT,
    // which nothing here renders — fired on 435 of the real fixture's 1,172
    // tool blocks. A warning true on a third of calls is a constant, not a
    // warning. A `Write` of a large file is the everyday way to trip it.
    const pkg = build([
      toolLine('a', 'Write', { file_path: 'src/big.ts', content: 'z'.repeat(20_000) }),
      toolResultLine('a', 'ok'),
    ]);
    expect(sectionOf(pkg, 'activity').truncated).toBe(false);
  });

  it('reports a CHECKLIST cut by the derivation, which the activity section draws', () => {
    // `renderBlock` puts todos into the activity section, and a 120-item list
    // arrives there as 100 — the section used to report itself complete while
    // holding five sixths of it.
    const todos = Array.from({ length: PACKAGE_CAPS.todos + 20 }, (_, i) => ({
      content: `task ${i}`,
      status: 'pending',
    }));
    const s = sectionOf(build([todoLine('t', todos)]), 'activity');
    expect(s.text).not.toContain(`task ${PACKAGE_CAPS.todos + 19}`);
    expect(s.truncated).toBe(true);
  });
});

describe('the plan section', () => {
  it('does not resurrect a checklist that the session CLEARED', () => {
    // `TodoWrite` with an empty list is a real call, and skipping it presents
    // finished work to the next session as still pending.
    const pkg = build([
      todoLine('t1', [{ content: 'wire the reader', status: 'in_progress' }]),
      todoLine('t2', []),
    ]);
    const s = sectionOf(pkg, 'plan');
    expect(s.text).not.toContain('wire the reader');
    expect(s.text).toBe('The todo list was emptied.');
  });

  it('does not hand over a SUBAGENT\'s scratch list as the session\'s plan', () => {
    // `lastProse` and `lastTool` both carry a `!sidechain` guard and this
    // predicate did not, so any session whose last delegation kept a checklist
    // handed the next session the subagent's list and dropped its own.
    const side = (line: string) => {
      const e = JSON.parse(line) as Record<string, unknown>;
      e.isSidechain = true;
      return JSON.stringify(e);
    };
    const pkg = build([
      todoLine('t1', [{ content: 'REAL PLAN ITEM', status: 'in_progress' }]),
      side(todoLine('t2', [{ content: 'SUBAGENT SCRATCH LIST', status: 'in_progress' }])),
    ]);
    expect(sectionOf(pkg, 'plan').text).toContain('REAL PLAN ITEM');
    expect(sectionOf(pkg, 'plan').text).not.toContain('SUBAGENT SCRATCH LIST');
  });

  it('is bounded — one pathological TodoWrite cannot outweigh the transcript', () => {
    // Measured by review before the cap: 100 items of 10 KB produced a
    // 1,001,520-character section, ~250,000 estimated tokens, from one call.
    const todos = Array.from({ length: 90 }, (_, i) => ({
      content: 'z'.repeat(10_000),
      status: i < 5 ? 'completed' : 'pending',
    }));
    const s = sectionOf(build([todoLine('t', todos)]), 'plan');
    expect(s.truncated).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(PLAN_CHAR_CAP + 32);
    expect(s.tokens).toBeLessThan(2_000);
  });

  it('caps a single runaway item without eating the rest of the list', () => {
    const s = sectionOf(
      build([
        todoLine('t', [
          { content: 'y'.repeat(5_000), status: 'pending' },
          { content: 'the next real task', status: 'pending' },
        ]),
      ]),
      'plan'
    );
    expect(s.text).toContain('the next real task');
    expect(s.truncated).toBe(true);
  });
});

describe('every section is bounded', () => {
  // No test asserted any section's LENGTH, so every cap constant's magnitude
  // survived mutation — `cap(text, limit * 2)` passed the whole suite because
  // the only assertion was that the marker appeared somewhere.
  // `cap()` appends its marker AFTER slicing to the limit, so those sections
  // may exceed it by exactly the marker. The activity trim subtracts its marker
  // BEFORE slicing, so that section must not exceed its budget at all — and the
  // slack has to be per-section rather than one generous number, because a
  // blanket `limit + 40` is wide enough to swallow the whole marker arithmetic
  // (`slice(-SNIPPET_CHAR_CAP)` instead of `slice(-(CAP - marker - 2))` fits
  // inside it, and did).
  const CAP_MARKER = ' …[truncated]'.length;
  const LIMITS: Array<[SectionId, number]> = [
    ['goal', GOAL_CHAR_CAP + CAP_MARKER],
    ['plan', PLAN_CHAR_CAP + CAP_MARKER],
    ['state', STATE_CHAR_CAP + CAP_MARKER],
    ['activity', SNIPPET_CHAR_CAP],
  ];

  it('holds each capped section to its stated budget, to the character', () => {
    const lines = [userLine('g'.repeat(50_000))];
    for (let i = 0; i < SNIPPET_BLOCKS + 5; i++) lines.push(assistantLine('x'.repeat(5_000)));
    lines.push(
      todoLine(
        't',
        Array.from({ length: 50 }, () => ({ content: 'w'.repeat(2_000), status: 'pending' }))
      )
    );
    const pkg = build(lines);
    for (const [id, limit] of LIMITS) {
      const s = sectionOf(pkg, id);
      expect(s.truncated).toBe(true);
      expect(s.text.length).toBeLessThanOrEqual(limit);
    }
    // …and not trivially small either, or a section that returned '' would pass.
    expect(sectionOf(pkg, 'activity').text.length).toBeGreaterThan(SNIPPET_CHAR_CAP - 200);
  });

  it('never splits an astral character at the END of a cap', () => {
    // A `slice` counts UTF-16 code units, so it can leave half an emoji — which
    // reaches the reading model as U+FFFD.
    const text = 'a'.repeat(GOAL_CHAR_CAP - 1) + '😀tail';
    const s = sectionOf(build([userLine(text)]), 'goal');
    expect(s.truncated).toBe(true);
    expect(s.text).not.toMatch(/[\uD800-\uDBFF]/);
  });

  it('never splits one at the FRONT of a cut either', () => {
    // The mirror case, and the one the first fix missed: the activity section
    // cuts from the front, so it needs a LOW-surrogate guard at index 0. The
    // guard had been applied to the function that was asked about rather than
    // to the shape of the bug, so both front slices in the tree still had it.
    const lines: string[] = [];
    for (let i = 0; i < SNIPPET_BLOCKS; i++) {
      lines.push(assistantLine('😀'.repeat(Math.ceil(SNIPPET_CHAR_CAP / 2))));
    }
    const s = sectionOf(build(lines), 'activity');
    expect(s.truncated).toBe(true);
    const body = s.text.slice(ACTIVITY_TRIM_MARKER.length + 2);
    expect(body.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
    expect(JSON.stringify(s.text)).not.toMatch(/\\ud[c-f]/i);
  });

  it('guards the same front cut in get_session_output, which had the same hole', () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(assistantLine('😀'.repeat(OUTPUT_CHAR_CAP)));
    const r = queriesOver(writeTranscript(lines)).sessionOutput('TradingApp', 30);
    if (!r.ok) throw new Error('expected output');
    expect(r.value.truncated).toBe(true);
    expect(JSON.stringify(r.value.text)).not.toMatch(/\\ud[c-f]/i);
  });
});

describe('byte-stability', () => {
  it('renders the REAL 7.37 MB transcript identically on two runs', () => {
    const entries = entriesOf(transcriptLines());
    const a = renderPackage(buildContextPackage({ session: session(), entries, cut: false }));
    const b = renderPackage(buildContextPackage({ session: session(), entries, cut: false }));
    expect(a).toBe(b);
    // A real session, so the document is not stable by being empty.
    expect(a.length).toBeGreaterThan(2_000);
  });

  it('is stable end to end through the reader, not just through the builder', () => {
    const file = writeTranscript(transcriptLines());
    const q = queriesOver(file);
    const first = q.sessionContext('TradingApp');
    const second = q.sessionContext('TradingApp');
    if (!first.ok || !second.ok) throw new Error('expected a package');
    expect(renderPackage(first.value)).toBe(renderPackage(second.value));
    expect(first.value.tokens).toBe(second.value.tokens);
  });

  it('orders a file\'s verbs canonically, not by the order the agent worked in', () => {
    // Read-then-edit and edit-then-read are the same file in the same state.
    // Rendering them differently would make the handoff depend on the order the
    // work happened to happen in.
    const readFirst = build([
      toolLine('a', 'Read', { file_path: 'src/app.ts' }),
      toolLine('b', 'Edit', { file_path: 'src/app.ts' }),
    ]);
    const editFirst = build([
      toolLine('a', 'Edit', { file_path: 'src/app.ts' }),
      toolLine('b', 'Read', { file_path: 'src/app.ts' }),
    ]);
    expect(sectionOf(readFirst, 'files').text).toBe(sectionOf(editFirst, 'files').text);
  });

  it('formats numbers without the machine\'s locale', () => {
    // `toLocaleString` would render 1,234 here and 1.234 on a German install —
    // the same package, two documents.
    //
    // ANCHORED, and over a FOUR-DIGIT total. The earlier version of this test
    // was neither: an unanchored `/~\d{1,3}(,\d{3})*/` matches the tail of
    // "~12345" on its last three digits, and the fixture it used produced a
    // three-digit number where grouping never happens at all — so `groupDigits`
    // was entirely untested and `String(n)` passed.
    const lines = [userLine('x'.repeat(GOAL_CHAR_CAP))];
    for (let i = 0; i < SNIPPET_BLOCKS; i++) lines.push(assistantLine('y'.repeat(400)));
    const pkg = build(lines);
    expect(pkg.tokens).toBeGreaterThan(1_000);
    const line = renderPackage(pkg)
      .split('\n')
      .find((l) => l.startsWith('- **Estimated size:**'));
    expect(line).toMatch(/^- \*\*Estimated size:\*\* ~\d{1,3}(,\d{3})+ tokens of content$/);
  });

  it('groups digits the same way on every machine, at every magnitude', () => {
    // `groupDigits` directly, because reaching six figures through a package
    // means building a six-figure package.
    const doc = (n: number) =>
      renderPackage({
        session: session(),
        coverage: 'whole',
        sections: [],
        tokens: n,
      });
    expect(doc(0)).toContain('~0 tokens');
    expect(doc(999)).toContain('~999 tokens');
    expect(doc(1_000)).toContain('~1,000 tokens');
    expect(doc(12_345)).toContain('~12,345 tokens');
    expect(doc(1_234_567)).toContain('~1,234,567 tokens');
  });

  it('contains no clock, no randomness and no locale formatting in its source', () => {
    // The behavioural tests above can only prove stability on the paths they
    // take. A `Date.now()` in a branch none of them reaches would survive all
    // of them and break the property in the field.
    const source = fs.readFileSync(path.join(__dirname, 'context-package.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/Date\.now|new Date|performance\.now|hrtime/);
    expect(code).not.toMatch(/Math\.random|crypto\./);
    expect(code).not.toMatch(/toLocaleString|toLocaleDateString|Intl\./);
    expect(code).not.toMatch(/process\.env/);
  });
});

describe('no model runs on the default path', () => {
  // The done-when says "assert it". A behavioural test cannot: it would only
  // prove that the ONE path it took spawned nothing. This asserts against the
  // source, the way `queries.test.ts` asserts the transport-free constraint.
  //
  // BOTH MODULES ON THE DEFAULT PATH, not just the one this file is named
  // after. Review pointed out the gap: a `spawn` added to `transcript-blocks.ts`
  // — which `buildContextPackage` calls on every single invocation — would have
  // satisfied every assertion below while making the package invoke a model.
  // `queries.ts` carries its own equivalent assertions in `queries.test.ts`.
  // EVERY MODULE `sessionContext` REACHES, not the one this file is named
  // after. Round 1 found that a `spawn` in `transcript-blocks.ts` would satisfy
  // every assertion here; round 2 found the fix had closed that INSTANCE rather
  // than the class — `queries.ts`, `feed/blocks.ts` and `feed/history.ts` are
  // all executed on the default path and were scanned by nothing. (The comment
  // that used to sit here claimed `queries.test.ts` carried equivalent
  // assertions. It does not: its checks are transport-freedom only, which is a
  // different property from "invokes no model".)
  const MODULES = [
    'context-package.ts',
    'transcript-blocks.ts',
    'queries.ts',
    '../feed/blocks.ts',
    '../feed/history.ts',
    // Reached transitively through `history.ts`, and therefore executed —
    // module-level code runs on import whether or not the function that wanted
    // it is called. The walk below found these; they were not on anyone's list.
    '../log/logger.ts',
    '../log/redact.ts',
    '../transcripts/paths.ts',
  ] as const;

  /**
   * The stricter half, and why it is a shorter list: "reads no files" is a
   * property of the PURE modules only. `history.ts` is the file reader and
   * `queries.ts` calls it — I/O is their job. "Invokes no model" applies to
   * all five.
   */
  const PURE = ['context-package.ts', 'transcript-blocks.ts'] as const;

  const read = (name: string) => {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    return {
      name,
      source,
      code: source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
      imports: [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)].map(
        (m) => m[1]
      ),
    };
  };

  it('scans EVERY module the default path reaches — the list is the assertion', () => {
    // Without this, narrowing `MODULES` fails nothing: it removes tests, and
    // `it.each` reports a smaller green suite. Derived from the import graph
    // rather than hand-maintained, so a NEW module on the default path fails
    // here instead of quietly going unscanned — which is the half the round-1
    // fix left open.
    const reached = new Set<string>();
    const walk = (rel: string) => {
      if (reached.has(rel)) return;
      reached.add(rel);
      const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
      for (const m of src.matchAll(/^\s*import\s[^;]*?from\s+'(\.[^']+)'/gm)) {
        const next = path
          .relative(__dirname, path.resolve(path.dirname(path.join(__dirname, rel)), m[1] + '.ts'))
          .split(path.sep)
          .join('/');
        if (fs.existsSync(path.join(__dirname, next))) walk(next);
      }
    };
    walk('context-package.ts');
    walk('queries.ts');
    // `shared/*` is types only and carries no executable path; everything else
    // the two entry points reach must be on the scanned list.
    const executable = [...reached].filter((r) => !r.includes('shared/'));
    expect([...executable].sort()).toEqual([...MODULES].sort());
  });

  it('the import extractor still extracts imports', () => {
    // The guard that stops every assertion below passing vacuously on a broken
    // regex. It lives here rather than inside the `each` because a module is
    // allowed to import NOTHING — `redact.ts` does, and asserting per module
    // turned "this file depends on nothing" into a failure.
    expect(read('context-package.ts').imports).toContain('../feed/blocks');
    expect(read('queries.ts').imports.length).toBeGreaterThan(2);
  });

  it.each(MODULES)('%s imports nothing that could run a program or open a connection', (name) => {
    const { imports } = read(name);
    for (const spec of imports) {
      expect(spec).not.toMatch(/child_process|net|http|https|dgram|worker_threads|provider/i);
      expect(spec).not.toMatch(/anthropic|claude|sdk|openai/i);
    }
  });

  it.each(MODULES)('%s names no spawn, no fetch and no dynamic import ANYWHERE', (name) => {
    const { code } = read(name);
    expect(code).not.toMatch(/\b(spawn|spawnSync|exec|execFile|execSync|fork)\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/);
    expect(code).not.toMatch(/require\(|await import\(/);
  });

  it.each(PURE)('%s does no I/O — pure functions of entries in, text out', (name) => {
    // Stronger than "invokes no model", and the reason it is worth asserting:
    // a generator that could read a file could read a config that names one.
    const { code, imports } = read(name);
    for (const spec of imports) expect(spec).not.toMatch(/^(fs|path|os)$/);
    expect(code).not.toMatch(/readFileSync|writeFileSync|openSync/);
  });

  it.each(MODULES)('%s stays transport-free, like every module below the bus', (name) => {
    const { code, imports } = read(name);
    for (const spec of imports) {
      expect(spec).not.toMatch(/mcp|ipc|electron|preload|renderer/i);
    }
    expect(code).not.toMatch(/\b(ipcMain|ipcRenderer|BrowserWindow|webContents)\b/);
  });
});

describe('the token estimate', () => {
  it('is reported per section and sums to the package total', () => {
    const pkg = build([
      userLine('the goal'),
      userLine('a correction'),
      todoLine('t', [{ content: 'a task', status: 'pending' }]),
      toolLine('a', 'Edit', { file_path: 'src/app.ts' }),
      assistantLine('the state'),
    ]);
    // EVERY section carries one, including the ones that came out empty —
    // §5.5's drop dialog shows sizes per option, so a missing number is a hole
    // in a table rather than a tidy omission.
    expect(pkg.sections).toHaveLength(6);
    for (const s of pkg.sections) {
      expect(s.tokens).toBe(estimateTokens(s.text));
    }
    expect(pkg.tokens).toBe(pkg.sections.reduce((n, s) => n + s.tokens, 0));
    expect(pkg.tokens).toBeGreaterThan(0);
  });

  it('rounds up, so a short section is never reported as free', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('a'.repeat(CHARS_PER_TOKEN))).toBe(1);
    expect(estimateTokens('a'.repeat(CHARS_PER_TOKEN + 1))).toBe(2);
  });

  it('tracks the content and not the document boilerplate', () => {
    // The two numbers answer different questions and the type says so. If they
    // were the same number, one of them would be wrong.
    const pkg = build([userLine('the goal'), assistantLine('the answer')]);
    expect(estimateTokens(renderPackage(pkg))).toBeGreaterThan(pkg.tokens);
  });
});

describe('what it says when it had to leave something out', () => {
  it('marks the package "recent" when the window did not reach the start', () => {
    const whole = build([userLine('go')]);
    const partial = build([userLine('go')], { cut: true });
    expect(whole.coverage).toBe('whole');
    expect(partial.coverage).toBe('recent');
    expect(renderPackage(whole)).toContain('the whole conversation');
    expect(renderPackage(partial)).toContain('there is older history not included here');
  });

  it('caps the instruction list and says it was capped', () => {
    const lines = [userLine('goal')];
    for (let i = 0; i < MAX_INSTRUCTIONS + 3; i++) lines.push(userLine(`correction ${i}`));
    const s = sectionOf(build(lines), 'instructions');
    expect(s.truncated).toBe(true);
    expect(s.text.split('\n')).toHaveLength(MAX_INSTRUCTIONS);
    // The NEWEST survive — an old correction that has been superseded is the
    // one worth losing.
    expect(s.text).toContain(`correction ${MAX_INSTRUCTIONS + 2}`);
    expect(s.text).not.toContain('correction 0');
  });

  it('keeps the files touched MOST RECENTLY and counts the earlier ones', () => {
    // The policy every other section uses, and the opposite of what this one
    // used to do: keeping the first 60 dropped precisely the files the session
    // is working on now, so the handoff described where the work started and
    // omitted where it got to.
    const lines = [userLine('go')];
    for (let i = 0; i < MAX_FILES + 5; i++) {
      lines.push(toolLine(`t${i}`, 'Read', { file_path: `src/f${i}.ts` }));
    }
    const s = sectionOf(build(lines), 'files');
    expect(s.truncated).toBe(true);
    expect(s.text).toContain('…and 5 more, not touched as recently');
    expect(s.text).toContain('src/f64.ts');
    expect(s.text).not.toContain('src/f0.ts —');
    expect(s.text.startsWith('- …and 5 more, not touched as recently')).toBe(true);
  });

  it('keeps a file the session KEEPS COMING BACK TO, however early it started', () => {
    // The bug the previous fix introduced: the map is keyed by FIRST touch, so
    // a file opened at turn 1 and edited again at the very end sits at the
    // front of it and was dropped — in favour of sixty files glanced at once
    // near the end. The file the work has been ABOUT is the last one to lose.
    const lines = [toolLine('first', 'Edit', { file_path: 'src/the-real-work.ts' })];
    for (let i = 0; i < MAX_FILES + 5; i++) {
      lines.push(toolLine(`g${i}`, 'Read', { file_path: `src/glanced${i}.ts` }));
    }
    lines.push(toolLine('last', 'Edit', { file_path: 'src/the-real-work.ts' }));
    const s = sectionOf(build(lines), 'files');
    expect(s.text).toContain('src/the-real-work.ts — edited (2 calls)');
    // …and it is rendered where it belongs in the story, at the front, because
    // selection is by last touch and RENDERING is still by first.
    expect(s.text.indexOf('the-real-work')).toBeLessThan(s.text.indexOf('glanced'));
  });

  it('cuts recent activity from the FRONT, keeping the newest', () => {
    const lines = [userLine('go')];
    // Long enough to blow the character cap inside the block window.
    for (let i = 0; i < SNIPPET_BLOCKS; i++) lines.push(assistantLine('x'.repeat(1_000)));
    lines.push(assistantLine('THE NEWEST THING'));
    const s = sectionOf(build(lines), 'activity');
    expect(s.truncated).toBe(true);
    expect(s.text.startsWith(ACTIVITY_TRIM_MARKER)).toBe(true);
    expect(s.text).toContain('THE NEWEST THING');
  });

  it('marks a goal that was itself too long to carry whole', () => {
    const s = sectionOf(build([userLine('g'.repeat(GOAL_CHAR_CAP + 50))]), 'goal');
    expect(s.truncated).toBe(true);
    expect(s.text).toContain('…[truncated]');
  });

  it('carries a checklist far past the length the Feed would show', () => {
    // `DISPLAY_CAPS.todos` is 30 — a plan quietly cut there would hand the next
    // session a list with its remaining work removed from it.
    const todos = Array.from({ length: 50 }, (_, i) => ({
      content: `task ${i}`,
      status: i < 10 ? 'completed' : 'pending',
    }));
    const s = sectionOf(build([todoLine('t', todos)]), 'plan');
    expect(s.text).toContain('10 of 50 done');
    expect(s.text).toContain('task 49');
    expect(s.truncated).toBe(false);
    expect(PACKAGE_CAPS.todos).toBeGreaterThan(50);
  });
});

describe('reading the transcript (SessionQueries.sessionContext)', () => {
  it('refuses a bad reference rather than answering about nobody', () => {
    const r = queriesOver(writeTranscript([userLine('go')])).sessionContext('Nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no session named "Nope"');
  });

  it('answers with an empty-but-whole package when there is no transcript', () => {
    const r = queriesOver(null).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package, got a refusal');
    expect(r.value.coverage).toBe('whole');
    expect(r.value.sections).toHaveLength(6);
    expect(renderPackage(r.value)).toContain('# Context from @TradingApp');
  });

  it('reaches back for the opening prompt when the tail window missed it', () => {
    // The defect this whole two-window design exists to prevent: on a long
    // session the tail's oldest prompt is not the task statement, and a package
    // built on the tail alone reports it as one with total confidence.
    const filler = assistantLine('f'.repeat(4_000));
    const lines = [userLine('THE ORIGINAL TASK')];
    const needed = Math.ceil(PACKAGE_TAIL_BYTES / (filler.length + 1)) + 20;
    for (let i = 0; i < needed; i++) lines.push(filler);
    lines.push(userLine('a much later instruction'));
    const file = writeTranscript(lines);
    expect(fs.statSync(file).size).toBeGreaterThan(PACKAGE_TAIL_BYTES);

    const r = queriesOver(file).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package');
    expect(r.value.coverage).toBe('recent');
    expect(sectionOf(r.value, 'goal').text).toBe('THE ORIGINAL TASK');
    expect(sectionOf(r.value, 'instructions').text).toContain('a much later instruction');
  });

  it('does not skip a real prompt hiding behind the CLI plumbing that precedes it', () => {
    // `type: 'user'` is not the same thing as "the human said something": meta
    // lines and `<local-command-*>` wrappers arrive under it too, and the CLI
    // writes several before a conversation starts.
    const meta = JSON.stringify({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: 'Caveat: the messages below were generated…' },
    });
    const wrapper = userLine('<local-command-stdout></local-command-stdout>');
    const filler = assistantLine('f'.repeat(4_000));
    const lines = [meta, wrapper, userLine('THE ORIGINAL TASK')];
    const needed = Math.ceil(PACKAGE_TAIL_BYTES / (filler.length + 1)) + 20;
    for (let i = 0; i < needed; i++) lines.push(filler);
    const r = queriesOver(writeTranscript(lines)).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package');
    expect(sectionOf(r.value, 'goal').text).toBe('THE ORIGINAL TASK');
  });

  it('does not mistake a subagent brief at the top of the file for the goal', () => {
    // A session whose very FIRST act is to delegate writes the `Task` tool's
    // brief into this same file, as a sidechain `user` line, ahead of anything
    // the human said. The head read is a second place that decision has to be
    // made — the builder's own guard is not on this path — and getting it wrong
    // opens the handoff with an instruction written by a model.
    const side = JSON.stringify({
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: 'SUBAGENT BRIEF: go and read everything' },
    });
    const filler = assistantLine('f'.repeat(4_000));
    const lines = [side, userLine('THE HUMAN GOAL')];
    const needed = Math.ceil(PACKAGE_TAIL_BYTES / (filler.length + 1)) + 20;
    for (let i = 0; i < needed; i++) lines.push(filler);
    const r = queriesOver(writeTranscript(lines)).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package');
    expect(sectionOf(r.value, 'goal').text).toBe('THE HUMAN GOAL');
  });

  it('calls a package partial when the LINE budget cut, not just the byte one', () => {
    // Two independent ways to miss history, and only one of them is `cut`. A
    // transcript of many tiny lines fits inside the byte budget and still loses
    // its oldest entries to `HISTORY_MAX_LINES` — reporting that as "the whole
    // conversation" is exactly the class of lie #772 closed one layer down.
    const lines: string[] = [];
    for (let i = 0; i < HISTORY_MAX_LINES + 500; i++) lines.push(assistantLine(`turn ${i}`));
    const file = writeTranscript(lines);
    expect(fs.statSync(file).size).toBeLessThan(PACKAGE_TAIL_BYTES);
    const r = queriesOver(file).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package');
    expect(r.value.coverage).toBe('recent');
    expect(renderPackage(r.value)).toContain('there is older history not included here');
  });

  it('does not repeat the goal as an instruction when both windows saw it', () => {
    // A short conversation whose tail reaches byte 0: the head read is skipped
    // entirely, so there is only one source for the prompt and no way to
    // double-count it. The guard is that `goalFromHead` stays undefined.
    const r = queriesOver(
      writeTranscript([userLine('the only prompt'), assistantLine('ok')])
    ).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package');
    expect(r.value.coverage).toBe('whole');
    expect(sectionOf(r.value, 'goal').text).toBe('the only prompt');
    expect(sectionOf(r.value, 'instructions').text).toBe('');
  });

  it('survives a transcript of pure garbage without throwing', () => {
    const file = writeTranscript(['not json', '{', '[]', 'null', '']);
    const r = queriesOver(file).sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package, not a refusal');
    expect(renderPackage(r.value)).toContain('# Context from @TradingApp');
  });

  it('builds a real session\'s package from the captured fixture', () => {
    const q = queriesOver(SESSION_TRANSCRIPT);
    const r = q.sessionContext('TradingApp');
    if (!r.ok) throw new Error('expected a package');
    // 7.37 MB against a 2 MB tail budget: this is the partial case, and the
    // document must say so.
    expect(r.value.coverage).toBe('recent');
    // Real paths, so real separators — the capture is a Windows session.
    expect(sectionOf(r.value, 'files').text).toMatch(/- .+\.ts — (wrote|edited|read|looked at)/);
    // The 2 MB budget was chosen because it is the first that reaches this
    // session's most recent `TodoWrite`. If the budget ever shrinks, this is
    // the assertion that notices the plan section going quiet.
    expect(sectionOf(r.value, 'plan').text).toContain('done,');
    expect(r.value.tokens).toBeGreaterThan(100);
  });

  it('keeps the head budget well under the tail budget', () => {
    // Not a style point: the head read exists to be cheap. If it ever grew past
    // the tail budget, the "one small extra read" argument would be gone and
    // every package would pay twice.
    expect(PACKAGE_HEAD_BYTES).toBeLessThan(PACKAGE_TAIL_BYTES / 4);
  });
});
