// The briefing a card hands an AI it switches to for the first time (E40 item
// 12, #1295; DESIGN §5.5 "Cross-provider handoff", design record §6).
//
// §5.5's LEVEL 2, MECHANICAL — the ladder's rung (a). It is the context
// package (`context-package.ts`), rendered for a different reader: not a
// sibling session being handed notes, but the AI that is about to carry on the
// SAME card's work. So it reuses every section of the package, and adds only
// what a different AI needs on top:
//
//   * THE HONESTY RULE, said to the model as well as on screen — this is a
//     briefed continuation, never a resume. The new AI has not seen the
//     conversation, only this; a document that let it believe otherwise would
//     have it "remember" things it was never told.
//   * A NEXT STEP, so the reader does not have to dig the open thread out of
//     the sections — the open item on the plan, else the user's last ask.
//   * THE IMPEDANCE SECTION. Instruction files follow each CLI's own
//     convention (Claude reads `CLAUDE.md`; Codex reads `AGENTS.md` only,
//     measured in `spike/findings/e40-codex-acp.md` Q7), and MCP servers,
//     permissions and hooks do not transfer. §5.5: the handoff lists what the
//     target will not have. An AI that declares no convention is "not known",
//     never a guess.
//
// PURE, and held to `context-package.ts`'s rules: no clock, no randomness, no
// locale formatting, no I/O, no model. Same material in, same bytes out — the
// done-when, and `ai-briefing.test.ts` asserts it against the source text.
import type { FeedBlock } from '../feed/blocks';
import { cleanSenderName } from '../../shared/sibling-message';
import {
  COVERAGE_LINE,
  INSTRUCTION_CHAR_CAP,
  buildPackageFrom,
  capText,
  emptySection,
  promptText,
  BRIEFING_HEADING,
  TRUNCATION_MARKER,
  type ContextPackage,
  type PackageMaterial,
} from './context-package';
import type { SessionSummary } from './queries';

/** One side of the switch, as the briefing names it. */
export interface BriefingParty {
  providerId: string;
  name: string;
  /**
   * The instruction files this AI reads by its own convention, from the
   * provider's `instructionFiles` capability. Absent: not known.
   */
  instructionFiles?: readonly string[];
}

/** Everything a briefing is built from. No file handles, no clock. */
export interface BriefingSource {
  from: BriefingParty;
  to: BriefingParty;
  /** the card's title and folder, for the header */
  cardTitle: string;
  folder: string;
  /** the conversation being left, normalised (`materialFrom…`) */
  material: PackageMaterial;
  /** the opening prompt, read from the head when the window did not reach it */
  goalFromHead?: string;
  /** the window began after the conversation's start */
  cut: boolean;
}

export interface Briefing {
  /** the exact text sent as the new AI's first prompt */
  text: string;
  /** how many of the user's turns it covers */
  turnsSummarised: number;
  /** it covers only the recent end of the conversation, so the count is not all of it */
  partial: boolean;
  /** the package it was rendered from — for tests and the log, never re-rendered */
  pkg: ContextPackage;
}

/**
 * The whole document's budget. The package's sections are each capped already
 * (about 20,000 characters at most); this bounds the sum, so a briefing can
 * never outweigh the conversation it stands in for.
 */
export const BRIEFING_CHAR_CAP = 24_000;

/** Said where the body was cut, so the reader knows it holds a part. */
export const BRIEFING_TRIM_MARKER = '…[the rest of this summary was cut to keep it short]';

/**
 * The document's first line — the marker the e2e and the hand test look for in
 * the new AI's first reply, and the one `promptText` uses to never read a
 * briefing as the user's words (so a second switch does not summarise a
 * summary). Defined in `context-package.ts`, which this module imports.
 */
export { BRIEFING_HEADING };

/** A title or folder is the user's and unbounded; the header holds this much of either. */
const HEADER_FIELD_CAP = 300;

/** Whether the summary covers only the recent end of the conversation. */
export function isPartial(pkg: ContextPackage): boolean {
  return pkg.coverage !== 'whole';
}

/**
 * Build the briefing. `undefined` when the conversation being left holds no
 * turn of the user's at all — there is nothing to hand over, and a document
 * saying so would be a prompt the new AI answers for no reason.
 */
export function buildBriefing(src: BriefingSource): Briefing | undefined {
  const turnsSummarised = countTurns(src.material.blocks);
  if (turnsSummarised === 0) return undefined;
  const session: SessionSummary = {
    id: '',
    name: src.cardTitle,
    folder: src.folder,
    providerId: src.from.providerId,
    status: 'done',
    exited: true,
  };
  const pkg = buildPackageFrom({
    session,
    material: src.material,
    goalFromHead: src.goalFromHead,
    cut: src.cut,
    // the AI being left speaks under its own name, never as "Claude"
    assistantLabel: cleanSenderName(src.from.name),
  });
  return { text: renderBriefing(src, pkg, turnsSummarised), turnsSummarised, partial: isPartial(pkg), pkg };
}

/** The user's own turns in the material — the count the divider shows. */
function countTurns(blocks: readonly FeedBlock[]): number {
  let n = 0;
  for (const b of blocks) if (promptText(b) !== undefined) n++;
  return n;
}

/** A list of file names as prose: `` `A` `` or `` `A` and `B` ``. */
function fileList(files: readonly string[]): string {
  const quoted = files.map((f) => '`' + f + '`');
  if (quoted.length <= 1) return quoted.join('');
  return quoted.slice(0, -1).join(', ') + ' and ' + quoted[quoted.length - 1];
}

/**
 * The instruction-file line. Four cases, each stated as what is known and
 * nothing more.
 */
export function instructionFilesLine(from: BriefingParty, to: BriefingParty): string {
  const fromFiles = from.instructionFiles?.length ? from.instructionFiles : undefined;
  const toFiles = to.instructionFiles?.length ? to.instructionFiles : undefined;
  const fromName = cleanSenderName(from.name);
  if (!fromFiles && !toFiles) {
    return `Instruction files: which project instruction files ${fromName} read, and which you read, is not known.`;
  }
  if (!fromFiles) {
    return `Instruction files: you read ${fileList(toFiles!)}; which ones ${fromName} read is not known.`;
  }
  if (!toFiles) {
    return (
      `Instruction files: ${fromName} read ${fileList(fromFiles)}; which ones you read is not known. ` +
      `If this folder has ${fileList(fromFiles)}, it holds the instructions ${fromName} was working under.`
    );
  }
  const missed = fromFiles.filter((f) => !toFiles.includes(f));
  if (missed.length === 0) {
    return `Instruction files: ${fromName} read ${fileList(fromFiles)}, and so do you.`;
  }
  return (
    `Instruction files: ${fromName} read ${fileList(fromFiles)}; you read ${fileList(toFiles)}. ` +
    `If this folder has ${fileList(missed)}, it holds the instructions ${fromName} was working under, ` +
    `and you will not read it on your own.`
  );
}

/**
 * What to do next, from the material: the open item on the plan, else the
 * user's last ask. Both are facts in the conversation; neither is a guess at
 * what the user wants.
 */
function nextStep(pkg: ContextPackage, blocks: readonly FeedBlock[]): string {
  const plan = [...blocks].reverse().find((b) => b.kind === 'todos' && !b.sidechain);
  const open =
    plan?.todos?.find((t) => t.status === 'in_progress') ?? plan?.todos?.find((t) => t.status === 'pending');
  if (open) return `The open item on the plan: ${capText(open.content, INSTRUCTION_CHAR_CAP).text}`;
  let last: string | undefined;
  for (const b of blocks) {
    const t = promptText(b);
    if (t !== undefined) last = t;
  }
  if (last !== undefined) {
    return 'The user\'s last request: ' + capText(last, INSTRUCTION_CHAR_CAP).text.replace(/\n/g, '\n  ');
  }
  return emptySection('instructions', pkg.coverage);
}

/** Group a number by hand — `context-package.ts`'s byte-stability rule. */
function groupDigits(n: number): string {
  const s = String(Math.max(0, Math.floor(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

/**
 * The document. THE CLOSING SECTIONS ALWAYS SURVIVE: the cap cuts the body —
 * the package's sections — and never the impedance section or the closing
 * line, which are what make the rest safe to act on.
 */
export function renderBriefing(src: BriefingSource, pkg: ContextPackage, turns: number): string {
  const fromName = cleanSenderName(src.from.name);
  const toName = cleanSenderName(src.to.name);
  const head: string[] = [
    `${BRIEFING_HEADING} from ${fromName} to ${toName}`,
    '',
    `You are ${toName}. This conversation was started with ${fromName}, and the user has just ` +
      `switched it to you. This is a briefed continuation, not a resume: you have not seen the ` +
      `conversation itself, only this summary of it. The summary was extracted mechanically from ` +
      `the conversation — no model wrote it — so it reports what the conversation contains, not ` +
      `what it meant.`,
    '',
    `- **Card:** ${capText(cleanSenderName(src.cardTitle), HEADER_FIELD_CAP).text}`,
    `- **Folder:** ${capText(src.folder, HEADER_FIELD_CAP).text}`,
    `- **Covers:** ${COVERAGE_LINE[pkg.coverage]}`,
    `- **Summarises:** ${groupDigits(turns)} of the user's ${turns === 1 ? 'turn' : 'turns'}`,
    '',
  ];
  const body: string[] = [];
  for (const s of pkg.sections) {
    body.push(`## ${s.title}`, '', s.text.trim() === '' ? emptySection(s.id, pkg.coverage) : s.text, '');
  }
  body.push('## Next step', '', nextStep(pkg, src.material.blocks), '');
  const tail: string[] = [
    '## What does not carry over',
    '',
    `- ${instructionFilesLine(src.from, src.to)}`,
    `- MCP servers, permissions and hooks set up for ${fromName} do not transfer to you.`,
    `- Neither does ${fromName}'s own memory of this conversation: this summary is all you have of it.`,
    '',
    'Do not start work from this summary alone. Reply in a sentence or two with where things ' +
      'stand, then wait for the user\'s next message.',
  ];
  // Each part ends in a blank line's worth of newline once joined: the head and
  // the body each end on an empty line, so `head + NL + body + NL + tail`
  // leaves exactly one blank line between sections.
  const headText = head.join('\n');
  const tailText = tail.join('\n') + '\n';
  let bodyText = body.join('\n');
  // what the body may take: the cap less the head, the tail and the two
  // joining newlines; a cut body then spends 3 of it on its own newlines
  const room = BRIEFING_CHAR_CAP - headText.length - tailText.length - 2;
  if (headText.length + bodyText.length + tailText.length + 2 > BRIEFING_CHAR_CAP) {
    // `capText`'s own guard against splitting an astral character, with this
    // document's marker instead of the generic one
    const capped = capText(bodyText, Math.max(0, room - BRIEFING_TRIM_MARKER.length - 3)).text;
    const kept = capped.endsWith(TRUNCATION_MARKER) ? capped.slice(0, -TRUNCATION_MARKER.length) : capped;
    bodyText = kept + '\n\n' + BRIEFING_TRIM_MARKER + '\n';
  }
  return headText + '\n' + bodyText + '\n' + tailText;
}
