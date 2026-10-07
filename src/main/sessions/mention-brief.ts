// What naming another session in a prompt hands over (#1092, §5.5).
//
// A mention used to inject `get_session_output`'s answer: the tail of the other
// session's screen, tool results and all, trimmed from the front. The first
// session to receive one said what that was like — the other session's final
// report was the useful part, the tool output was a hundred lines of a file it
// could read for itself, the start of the owner's own prompt had been trimmed
// away, and everything it most needed to know (which branch, whether the two
// sessions shared a working tree, whether the other one was still running) it
// had to go and find out.
//
// So a mention now sends a BRIEF, in this order:
//
//   1. FACTS, stated by the app — never inferred from text. Who, where, what
//      state, which branch, and whether it shares the receiver's folder.
//   2. WHAT IT WAS ASKED, from the handoff package (#766): the opening prompt,
//      later instructions, the plan, the files it touched. The opening prompt
//      is read from the HEAD of the transcript, so it survives however long the
//      conversation got — which is what "trim the middle, not the start" comes
//      to.
//   3. THE RECENT CONVERSATION — prompts and replies in full, each tool call as
//      one line without its output. That is the inversion that matters: the
//      same budget now holds several turns of what was said instead of one
//      turn of what a tool printed.
//   4. HOW TO GET MORE, so detail is pulled on demand rather than shipped.
//
// NOT the package's own "Recent activity" and "Where it left off": at 6,000 and
// 2,000 characters they would cut exactly the closing report this exists to
// carry, and part 3 is both of them at a better size.
//
// ── THREE PARTS, AND ONLY THE MIDDLE ONE IS FENCED ──────────────────────────
//
// Parts 1 and 4 are the APP speaking. Parts 2 and 3 are text out of another
// session's transcript — prompts somebody pasted, replies a model wrote, paths
// and tool names — and any of it can contain a line shaped like one of ours.
// If the facts sat inside the same fence, a transcript carrying `## Facts` and
// a `- **Git:** on branch main` of its own would be indistinguishable from the
// real ones. So the caller fences `body` and nothing else, the way
// `renderOutput` keeps its own header outside the fence it draws: what is
// outside is ours, what is inside is reported.
//
// ── AND IT HAS A SIZE OF ITS OWN ────────────────────────────────────────────
//
// `buildMentionPrompt` leaves a block out WHOLE when it does not fit the
// prompt's 40k, so a brief that could grow past that would be a mention that
// injects nothing at all — on exactly the long, busy sessions a handoff is for.
// `BRIEF_CHAR_CAP` is under half of it, so two mentioned sessions always fit.
// The asked-for sections are clipped to fixed shares and the conversation gets
// everything left, cut from its OLDEST end.
//
// NO MODEL WRITES ANY OF THIS, and the brief says so — the rule §5.5 holds the
// package to. PURE: no file handles, no clock, no git. The caller reads.
import { COVERAGE_LINE, emptySection, type ContextPackage } from './context-package';
import { TRIM_MARKER, type SessionOutput } from './queries';
import { sliceTail } from './transcript-blocks';
import { HOST_STYLE, type PathStyle } from '../fs/read-scope';
import type { SessionSummary } from '../../shared/sessions';
import { cleanSenderName } from '../../shared/sibling-message';
import { mentionLabel } from '../../shared/mention-prompt';

/** How many blocks of conversation a brief asks for — tool calls are one line each. */
export const BRIEF_LAST_N = 80;

/**
 * The most one brief may be, fence and envelope not counted.
 *
 * Under half of `TOTAL_CONTEXT_CHAR_CAP` with room for the wrapping, so two
 * mentioned sessions always both arrive. `mention-brief.test.ts` holds the
 * worst case to it.
 */
export const BRIEF_CHAR_CAP = 18_000;

/**
 * What each asked-for section may take. Fixed shares, so the conversation — the
 * part the brief exists to carry — is never left with scraps: these sum to
 * 7,000, the app's own lines are under 3,000 at their very longest (a 400-character
 * folder and a 400-character working tree), and the rest is the conversation's.
 */
const SECTION_CAP: Record<'goal' | 'instructions' | 'plan' | 'files', number> = {
  goal: 1_500,
  instructions: 2_500,
  plan: 1_500,
  files: 1_500,
};

const CLIP_MARKER = '\n…[the rest is not shown here]';

/** `text`, cut at `cap` from its END, saying so. */
function clip(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap - CLIP_MARKER.length) + CLIP_MARKER;
}

/** What the app knows about a folder's checkout, when it could find out in time. */
export interface BriefGitFacts {
  /** the branch checked out there; absent on a detached HEAD */
  branch?: string;
  /** tracked files with uncommitted changes */
  changed: number;
  /** files git does not track yet */
  untracked: number;
}

/** The facts only the caller can supply. Every one is optional; unknown is not printed. */
export interface BriefFacts {
  /** the folder of the session that will READ this brief */
  readerFolder?: string;
  /** the mentioned session's checkout, or undefined when it is not known */
  git?: BriefGitFacts;
  /**
   * The root of the git working tree each folder is in (#1098) — git's own
   * `--show-toplevel`, or undefined when it could not be read in time. BOTH are
   * needed for the comparison; with either missing the brief falls back to
   * comparing the folders themselves.
   */
  tree?: string;
  readerTree?: string;
  /**
   * The handoff the mentioned session WROTE ITSELF, when the user asked for one
   * and it could be had (#1126). The one part of a brief a model authored — so
   * it goes INSIDE the fence with everything else that is not the app's own
   * word, and the head says so in the app's voice.
   */
  handoff?: { text: string; truncated: boolean };
}

/** The three parts of a brief. The caller fences `body` and only `body`. */
export interface MentionBrief {
  /** the app's own statement: heading, facts — OUTSIDE the fence */
  head: string;
  /** text out of the other session's transcript — INSIDE the fence */
  body: string;
  /** the app's closing line — OUTSIDE the fence */
  more: string;
}

/** The package sections a brief carries, in order. */
const BRIEF_SECTIONS: readonly (keyof typeof SECTION_CAP)[] = ['goal', 'instructions', 'plan', 'files'];

/**
 * Two folder strings that name one directory.
 *
 * Case is folded ONLY where the filesystem folds it. This decides the loudest
 * line in the brief — "it shares your folder" — and on Linux `/x/App` and
 * `/x/app` are two different trees; saying otherwise would tell a session to
 * distrust files nobody else is touching.
 */
export function sameFolder(
  a: string | undefined,
  b: string | undefined,
  style: PathStyle = HOST_STYLE
): boolean {
  if (!a || !b) return false;
  const fold = (p: string): string => {
    const flat = p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    return style.caseInsensitive ? flat.toLowerCase() : flat;
  };
  return fold(a) === fold(b);
}

/**
 * Do the two sessions work in ONE working tree — and if so, is it obvious?
 *
 * ⚠️ **TREES, NOT FOLDERS (#1098).** This used to be `sameFolder` and nothing
 * else, so a session in `repo/packages/a` and one in `repo` — one checkout, one
 * branch, each other's uncommitted changes — were told nothing, in exactly the
 * case where the two folder names give no hint of it. Git's toplevel is the
 * thing that is actually shared.
 *
 * Two LINKED worktrees of one repository have different toplevels and different
 * files, and are correctly `'no'`.
 *
 * Unknown never invents a warning and never swallows one: without BOTH
 * toplevels this is the folder comparison it always was.
 */
export function sharesWorkingTree(
  folder: string | undefined,
  facts: BriefFacts,
  style: PathStyle = HOST_STYLE
): 'no' | 'same-folder' | 'same-tree' {
  if (sameFolder(folder, facts.readerFolder, style)) return 'same-folder';
  if (facts.tree && facts.readerTree && sameFolder(facts.tree, facts.readerTree, style)) return 'same-tree';
  return 'no';
}

/**
 * What the session is doing, in words a reader can act on.
 *
 * `exited` FIRST, for `SessionSummary.exited`'s own reason: `'done'` is what the
 * state machine calls both a finished turn and a clean exit, and "it is done"
 * about a session whose process has gone is the wrong thing to tell someone
 * deciding whether to wait for it.
 */
export function statusSentence(session: Pick<SessionSummary, 'status' | 'exited'>): string {
  if (session.exited) return 'its process has ended — it is not running';
  switch (session.status) {
    case 'working':
      return 'working right now — what follows may already be out of date';
    case 'starting':
      return 'starting up';
    case 'needs-permission':
      return 'stopped, waiting for the user to answer a permission request';
    case 'needs-input':
      return 'stopped, waiting for the user to answer a question';
    case 'crashed':
      return 'crashed';
    case 'done':
    case 'idle':
    default:
      return 'finished its turn and is idle — still open';
  }
}

/**
 * One line, no control characters — for a value printed in the app's own voice.
 *
 * A folder can legally contain a newline on POSIX, and a line break inside a
 * fact is a second line the reader takes for another fact.
 */
function oneLine(text: string, cap = 400): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap);
}

/** The git line, or undefined when there is nothing true to say. */
function gitSentence(git: BriefGitFacts | undefined): string | undefined {
  if (!git) return undefined;
  // A branch name is chosen by whoever made the repository. It cannot hold a
  // space or a newline, but it can hold a backtick — which would close the code
  // span it is printed in — and it has no length limit.
  const branch = git.branch ? oneLine(git.branch.replace(/`/g, "'"), 120) : '';
  const where = branch ? `on branch \`${branch}\`` : 'on a detached HEAD (no branch)';
  const parts: string[] = [];
  if (git.changed > 0) {
    parts.push(`${git.changed} tracked file${git.changed === 1 ? '' : 's'} with uncommitted changes`);
  }
  if (git.untracked > 0) parts.push(`${git.untracked} untracked`);
  return `${where}, ${parts.length > 0 ? parts.join(' and ') : 'nothing uncommitted'}`;
}

/** Build the brief. See the header for why it comes in three parts. */
export function buildMentionBrief(
  pkg: ContextPackage,
  output: SessionOutput,
  facts: BriefFacts = {},
  style: PathStyle = HOST_STYLE
): MentionBrief {
  const { session } = pkg;
  const name = cleanSenderName(session.name);

  // ── 1. the app's own statement ─────────────────────────────────────────────
  const head: string[] = [];
  head.push(`# Brief on ${mentionLabel(name)}`);
  head.push('');
  head.push(
    facts.handoff
      ? // ⚠️ "No model wrote it" is the sentence this brief was built to be able
        // to say (#1092), and with a handoff in it that sentence is false. Said
        // plainly, in the app's own voice and OUTSIDE the fence, so the reader
        // knows which part to check before leaning on it.
        'Assembled by switchboard. The lines under "Facts" are switchboard’s. Inside ' +
          'the marked block below them, the section "Handoff, written by that session" ' +
          'was written a moment ago by that session’s own model because your user asked ' +
          'for it — switchboard has not checked it, so verify what matters against the ' +
          'repository. The rest of the block is text reported from that session’s record.'
      : 'Assembled by switchboard from that session’s own record — no model wrote it. ' +
          'The lines under "Facts" are switchboard’s; everything inside the marked ' +
          'block below them is text reported from that session.'
  );
  head.push('');
  head.push('## Facts');
  head.push('');
  head.push(`- **Session:** ${name} (${oneLine(session.providerId, 60)}) — id ${oneLine(session.id, 80)}`);
  head.push(`- **Folder:** ${oneLine(session.folder)}`);
  head.push(`- **State:** ${statusSentence(session)}`);
  const git = gitSentence(facts.git);
  if (git) head.push(`- **Git:** ${git}`);
  // The one fact that can break the READER rather than merely inform it.
  const shared = sharesWorkingTree(session.folder, facts, style);
  if (shared === 'same-folder') {
    head.push(
      '- **⚠ It shares your folder.** That session and you work in ONE working tree: ' +
        'the branch it checked out is the branch you are on, and its uncommitted ' +
        'changes are in your files. Run `git status` before you change anything.'
    );
  } else if (shared === 'same-tree') {
    // Said differently, because here the folder line above looks like someone
    // else's — which is the whole reason this case needs saying at all.
    //
    // "A different PATH", not "a different folder" (review): all that was
    // compared is two spellings. Git resolves a junction or a symlink to the
    // real directory, so two sessions on ONE folder under two names land here
    // too, and the app's own voice may not say they are in different places.
    head.push(
      `- **⚠ It shares your working tree.** Its folder is a different path from yours, but both are inside ONE ` +
        `git checkout (${oneLine(facts.tree ?? '')}): the branch it checked out is the branch you ` +
        'are on, and its uncommitted changes show up in your `git status`. Run `git status` ' +
        'before you change anything.'
    );
  }
  head.push(`- **How much of it this saw:** ${COVERAGE_LINE[pkg.coverage]}`);

  // ── 4. how to get more (built now, because its size is part of the budget) ──
  const more =
    '**To get more**, ask switchboard rather than guessing: `get_session_output` gives ' +
    'the recent output WITH tool results, `get_session_diff` its uncommitted changes, ' +
    'and `get_session_context` this handoff at other sizes. Each takes the session id above.';

  // ── 2. what it was asked — inside the fence ────────────────────────────────
  const body: string[] = [];
  // ...led by its own handoff, when there is one (#1126). First, because it is
  // the part the user asked for; and counted against the same budget as
  // everything after it, so a long one shortens the conversation tail rather
  // than growing the brief.
  if (facts.handoff) {
    body.push('## Handoff, written by that session');
    body.push('');
    body.push(facts.handoff.text.trim() + (facts.handoff.truncated ? '\n\n…[cut short]' : ''));
    body.push('');
  }
  for (const id of BRIEF_SECTIONS) {
    const section = pkg.sections.find((s) => s.id === id);
    if (!section) continue;
    body.push(`## ${section.title}`);
    body.push('');
    body.push(
      section.text.trim() === ''
        ? emptySection(id, pkg.coverage)
        : clip(section.text, SECTION_CAP[id])
    );
    body.push('');
  }

  // ── 3. the recent conversation — everything that is left ───────────────────
  body.push('## Recent conversation');
  body.push('');
  if (output.text === '') {
    body.push(
      output.truncated
        ? 'There is earlier activity, but its most recent part holds nothing readable.'
        : 'Nothing has been said in this session yet.'
    );
  } else {
    const intro =
      'Oldest first. What the user typed and what the session replied are given in ' +
      'full; each tool call is ONE line — its name and what it was aimed at — ' +
      'without what it printed.';
    const leftOut = ' Older turns were left out.';
    const used =
      head.join('\n').length + more.length + body.join('\n').length + intro.length + leftOut.length + 8;
    const room = Math.max(BRIEF_CHAR_CAP - used, 2_000);
    // CUT FROM THE FRONT, keeping the newest — `sessionOutput`'s own rule, for
    // its own reason: the closing report is at the end, and it is the point.
    const overflow = output.text.length > room;
    const text = overflow
      ? TRIM_MARKER + '\n\n' + sliceTail(output.text, room - TRIM_MARKER.length - 2)
      : output.text;
    body.push(intro + (output.truncated || overflow ? leftOut : ''));
    body.push('');
    body.push(text);
  }

  return { head: head.join('\n'), body: body.join('\n'), more };
}

/**
 * The brief as one document: head, the fenced body, the closing line.
 *
 * `fence` is the bus tools' data fence (`quoted`), injected because it lives
 * with them. Absent — a unit host — the body goes unfenced, which is only ever
 * a test's shape; the real wiring always passes one.
 */
export function renderMentionBrief(
  pkg: ContextPackage,
  output: SessionOutput,
  facts: BriefFacts = {},
  fence: (body: string) => string = (body) => body,
  style: PathStyle = HOST_STYLE
): string {
  const brief = buildMentionBrief(pkg, output, facts, style);
  return `${brief.head}\n\n${fence(brief.body)}\n\n${brief.more}`;
}
