// REAL `ai-title` lines, captured verbatim from transcripts in
// `~/.claude/projects/` (P2-E7-06).
//
// WHY THESE ARE COPIED AND NOT WRITTEN. Everything this feature reads comes off
// an undocumented key in a file the CLI writes, so a hand-written fixture would
// be testing our own idea of what Claude Code emits — which is exactly the
// belief that needs checking. Three properties below were surprises when the
// real files were read, and every one of them is a bug we would otherwise have
// shipped:
//
//   * **The key order is not stable.** `aiTitle` appears before `sessionId` on
//     some lines and after it on others, in the SAME file, on ADJACENT lines
//     (see `REVISED` lines 8 and 9). Anything that pattern-matched the line as
//     text rather than parsing it would pass a hand-written fixture and fail on
//     a real transcript.
//   * **The title gets revised.** The CLI's first answer is not its last:
//     `"…preview windows"` became `"…preview feature"` one line later.
//   * **"It shows up early" is not a property.** First `ai-title` at line 8 of
//     one transcript, line 339 of another, line 510 of a third.
//
// Copied lines only — never a whole transcript. A transcript is a conversation,
// and these files are the author's own working sessions. `ai-title` lines carry
// a session UUID and a six-word description of the task, and nothing else.
//
// Captured 2026-08-11 by grepping the files read-only. To refresh:
//   grep -n '"ai-title"' <transcript>.jsonl

/** One real transcript's `ai-title` lines, with where they sat in the file. */
export interface CapturedTitles {
  /** which transcript, for provenance — a fixture nobody can trace is a guess */
  source: string;
  /** how many lines the real file had, so a rebuilt fixture is the real shape */
  totalLines: number;
  /** every `ai-title` line in it: `[1-based line number, the raw JSONL line]` */
  lines: ReadonlyArray<readonly [number, string]>;
}

/** The distinct titles in a capture, in the order the CLI first emitted them. */
export function titlesOf(c: CapturedTitles): string[] {
  const seen: string[] = [];
  for (const [, raw] of c.lines) {
    const title = (JSON.parse(raw) as { aiTitle: string }).aiTitle;
    if (!seen.includes(title)) seen.push(title);
  }
  return seen;
}

/**
 * The design session itself, and the one §5.11 quotes: the CLI's first title was
 * REVISED one line later, then re-emitted unchanged 24 more times.
 *
 * Note lines 8 and 9: same file, adjacent lines, opposite key order.
 */
export const REVISED: CapturedTitles = {
  source: 'c--Projects-Switchboard-ai/bd2517c3-adaf-44d8-a86f-b80b6f5efabe.jsonl',
  totalLines: 326,
  lines: [
    [8, '{"type":"ai-title","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe","aiTitle":"Add markdown and file preview windows"}'],
    [9, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [16, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [23, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [34, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [43, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [59, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [67, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [78, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [87, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [96, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [113, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [124, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [147, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [167, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [178, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [191, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [204, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [221, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [237, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [256, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [274, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [288, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [300, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [313, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
    [323, '{"type":"ai-title","aiTitle":"Add markdown and file preview feature","sessionId":"bd2517c3-adaf-44d8-a86f-b80b6f5efabe"}'],
  ],
};

/**
 * Repeat-heavy: 13 `ai-title` lines in a 133-line transcript and ONE distinct
 * title between them. This is the de-dupe's fixture — §5.11 measured 14
 * identical lines in a 171-line transcript, and this is the same shape from a
 * file that still exists.
 *
 * Lines 8 and 9 are again the same title in the opposite key order, so a
 * de-dupe done on the raw text rather than the parsed value counts twelve
 * changes instead of one.
 */
export const REPEAT_HEAVY: CapturedTitles = {
  source: 'c--Projects-Switchboard-ai/431280c5-38c3-4589-a896-2556bb4ecbab.jsonl',
  totalLines: 133,
  lines: [
    [8, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [9, '{"type":"ai-title","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab","aiTitle":"Analyze and improve Playwright test coverage"}'],
    [18, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [32, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [43, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [58, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [79, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [90, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [93, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [102, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [118, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [123, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
    [133, '{"type":"ai-title","aiTitle":"Analyze and improve Playwright test coverage","sessionId":"431280c5-38c3-4589-a896-2556bb4ecbab"}'],
  ],
};

/**
 * Late arrival: 567 lines, and the first `ai-title` is line 510 — five hundred
 * lines of conversation before the CLI names it.
 *
 * The reason the card must reserve the label's space rather than grow a row
 * when one turns up, and the reason nothing may treat "no title yet" as "this
 * transcript has no titles".
 */
export const LATE: CapturedTitles = {
  source: 'c--Projects-Switchboard-ai/a8b98f46-772f-40ee-8e50-1cecf863b514.jsonl',
  totalLines: 567,
  lines: [
    [510, '{"type":"ai-title","aiTitle":"Review next steps after PR merge","sessionId":"a8b98f46-772f-40ee-8e50-1cecf863b514"}'],
    [518, '{"type":"ai-title","aiTitle":"Review next steps after PR merge","sessionId":"a8b98f46-772f-40ee-8e50-1cecf863b514"}'],
    [538, '{"type":"ai-title","aiTitle":"Review next steps after PR merge","sessionId":"a8b98f46-772f-40ee-8e50-1cecf863b514"}'],
    [557, '{"type":"ai-title","aiTitle":"Review next steps after PR merge","sessionId":"a8b98f46-772f-40ee-8e50-1cecf863b514"}'],
  ],
};

/**
 * Rebuild a transcript of the real SHAPE: the captured `ai-title` lines at the
 * line numbers they really had, and `filler` on every other line.
 *
 * The positions are the point. A test that writes the four captured lines back
 * to back proves nothing about a title that arrives on line 510, which is the
 * case this feature has to survive.
 */
export function rebuild(c: CapturedTitles, filler: (lineNo: number) => string): string {
  const byLine = new Map(c.lines.map(([n, raw]) => [n, raw]));
  const out: string[] = [];
  for (let n = 1; n <= c.totalLines; n++) out.push(byLine.get(n) ?? filler(n));
  return out.join('\n') + '\n';
}
