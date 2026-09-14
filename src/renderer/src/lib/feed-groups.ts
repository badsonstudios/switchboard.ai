// Grouping subagent blocks into named runs (#788, §5.10 "Subagent sidechains —
// folded behind an agent header, indented").
//
// THE PROBLEM THIS SOLVES IS OURS, NOT THE CLI'S. The watcher tails every
// `subagents/agent-*.jsonl` a session owns and drains all of them into ONE
// block buffer in tail-arrival order. Measured, the CLI itself never mixes two
// agents: each subagent gets a file of its own and every line in it carries the
// same `agentId` (333 of 333 files, zero exceptions). So the interleaving the
// Feed shows is produced by our merge — and 10 of 61 measured sessions ran two
// subagents whose time spans genuinely overlap, up to 757 seconds of it.
//
// A DIVIDER, NOT A WRAPPER. This returns "which block STARTS a run, and what to
// call it", and `FeedView` renders a caption before those blocks exactly the
// way `turn-divider` works. It deliberately does not return a nested structure:
// wrapping blocks in a group element would put a node between the feed root and
// the rows that `FeedFindSurface.jumpTo` resolves by document order, and
// `FeedView.forgery.test.tsx` pins that resolution. The flat list stays flat.
//
// Derived on every render from the FILTERED list, never stored: `upsertBlock`
// inserts by seq and evicts at 1000, so a stored grouping would describe a list
// that no longer exists.
import type { FeedBlockDto } from './feed';

/** The shortest id fragment worth showing a human. Longer only on a tie. */
const SHORT_ID = 6;

export interface AgentRunHead {
  /** the run's grouping key — the CLI's own `agentId`, when the run has one */
  agentId?: string;
  /** the agent's name, when ANY block in the run carried one */
  name?: string;
  /**
   * An id fragment that separates this run from another on screen with the
   * same name.
   *
   * ABSENT unless it is needed, which is the point: a bare
   * `deep-research-specialist` is what the user wants to read, and a hex suffix
   * on every header would be noise on the common case to serve the rare one.
   * It appears only when a second agent is on screen under the same name —
   * which is a real case, not a defensive one: one measured session ran three
   * overlapping `deep-research-specialist`s, and the name alone cannot tell
   * them apart.
   */
  discriminator?: string;
}

/**
 * A maximal consecutive span of sidechain blocks belonging to one agent.
 *
 * `agentId` is ABSENT for a sidechain block we cannot attribute — a transcript
 * written before CLI 2.1.226, or a resumed stream session, whose replay reads
 * the main file only and so has no subagent filename to fall back on. Such a
 * run still gets a bare caption: before #788 it at least got a stray "NEW
 * PROMPT" rule, and losing that without putting anything in its place would
 * leave it with LESS separation than the bug this item fixes.
 */
interface Run {
  agentId?: string;
  headSeq: number;
}

/**
 * The shortest prefix length ≥ `SHORT_ID` that tells every id in `ids` apart.
 *
 * Ids are long hex strings, so `SHORT_ID` characters separate them essentially
 * always — but "essentially always" is how a label ends up showing two
 * different agents the same suffix, and the fix costs a loop. Falls back to the
 * longest id when no prefix separates them (two identical ids cannot happen
 * here: the caller passes a de-duplicated set).
 */
function distinguishingLength(ids: readonly string[]): number {
  const longest = Math.max(...ids.map((id) => id.length));
  for (let n = SHORT_ID; n < longest; n++) {
    if (new Set(ids.map((id) => id.slice(0, n))).size === ids.length) return n;
  }
  return longest;
}

/**
 * Which visible blocks start a subagent run, and what to caption them.
 *
 * **TWO LISTS, BECAUSE THIS ANSWERS TWO DIFFERENT QUESTIONS** (#788 review).
 *
 * - *Where does a run start* is a question about the list as RENDERED, so it
 *   takes `visible` — already filtered by verbosity and the find-reveal set.
 *   A run whose head block the current preset hides is captioned at the first
 *   block the user can actually see, rather than not at all.
 * - *What is agent X called*, and *does that name clash*, are facts about the
 *   SESSION. Answering them from the window makes a run's caption a function of
 *   what happens to be on screen, and it changes under the reader:
 *   - `attributionAgent` rides on `assistant` lines, and the buffer evicts from
 *     the front at 1,000 blocks. In a session that ran 58 subagents, an agent's
 *     named blocks fall out of the window while its tool-result and attachment
 *     blocks — which are never named — remain, and a run silently degrades from
 *     `Subagent · digger` to `Subagent`. Verbosity does it too: a name carried
 *     on a thinking block is hidden by `normal` and shown by `firehose`, so the
 *     same run reads two ways depending on a chip.
 *   - A run the user already read as `Subagent · digger` would sprout a
 *     disambiguating fragment the moment a second `digger` scrolled into view,
 *     and drop it again when the first was evicted — re-introducing exactly the
 *     ambiguity this item exists to remove, silently, and rewrapping captions
 *     above the viewport while the user is parked on something.
 *
 * So pass `all` (the unfiltered, uncapped-as-we-have-it block list) as well.
 * It defaults to `visible` for callers that genuinely have only one list.
 */
export function agentRunHeads(
  visible: readonly FeedBlockDto[],
  all: readonly FeedBlockDto[] = visible
): Map<number, AgentRunHead> {
  // `Map`, not an object, throughout: an `agentId` and an `agentName` are
  // untrusted text out of another process, and `__proto__` as an object key is
  // not a key at all.
  //
  // FIRST name wins, PER AGENT rather than per run, and over ALL blocks. A
  // subagent transcript opens with a `user` line and `attributionAgent` is on
  // `assistant` lines only, so a run is routinely anonymous at its head — and a
  // SECOND run of the same agent, after the parent said something in between,
  // often contains no named line at all.
  const nameById = new Map<string, string>();
  for (const b of all) {
    if (!b.sidechain || !b.agentId || !b.agentName) continue;
    if (!nameById.has(b.agentId)) nameById.set(b.agentId, b.agentName);
  }

  // Which names are claimed by more than one AGENT — again over ALL blocks, so
  // the fragment does not blink in and out as its twin scrolls past.
  const idsByName = new Map<string, Set<string>>();
  for (const b of all) {
    if (!b.sidechain || !b.agentId) continue;
    // Anonymous-but-identified agents share a bucket: they all render the same
    // fallback caption, so two of them need separating for the same reason two
    // identically named ones do, and with rather more urgency — they have no
    // other cue at all.
    const key = nameById.get(b.agentId) ?? '';
    const ids = idsByName.get(key);
    if (ids) ids.add(b.agentId);
    else idsByName.set(key, new Set([b.agentId]));
  }

  const runs: Run[] = [];
  let current: Run | undefined;
  for (const b of visible) {
    // `b.sidechain` is checked as well as `b.agentId`, even though the main
    // process already gates one on the other (`agentOriginFor`). The caption is
    // indented onto the dashed sidechain spine; above an un-indented main block
    // it would not read as a wrong label, it would read as a broken layout.
    if (!b.sidechain) {
      current = undefined;
      continue;
    }
    // An UNATTRIBUTED sidechain block still opens a run — see `Run`. Its key is
    // `undefined`, which is a key like any other here: two consecutive
    // unattributed blocks are one run, and an attributed block beside one is
    // not.
    //
    // `!current` is load-bearing — its ORDER is not, and a mutant proved it
    // either way. Without the test at all, the first unattributed block after a
    // main-conversation block reads `current?.agentId !== b.agentId` as
    // `undefined !== undefined`, which is false, and opens no run: the one case
    // that has nothing else to identify it would be the one case with no
    // caption. Reordering the two operands changes nothing, since both are
    // evaluated regardless.
    //
    // A separate `inRun` latch stood here for the same purpose and was removed
    // once round 2 showed it exactly equivalent to this — a second name for one
    // fact, which is a thing to delete rather than to test.
    if (!current || current.agentId !== b.agentId) {
      current = { headSeq: b.seq, ...(b.agentId === undefined ? {} : { agentId: b.agentId }) };
      runs.push(current);
    }
  }

  const heads = new Map<number, AgentRunHead>();
  for (const r of runs) {
    const head: AgentRunHead = {};
    if (r.agentId !== undefined) {
      head.agentId = r.agentId;
      const name = nameById.get(r.agentId);
      if (name !== undefined) head.name = name;
      const ids = idsByName.get(name ?? '');
      if (ids && ids.size > 1) {
        head.discriminator = r.agentId.slice(0, distinguishingLength([...ids]));
      }
    }
    heads.set(r.headSeq, head);
  }
  return heads;
}
