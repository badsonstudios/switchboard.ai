// The AI-switch briefing's I/O half (E40 item 12, #1295): where the
// conversation being left is READ from, and where the exact text sent is KEPT.
// The document itself is `ai-briefing.ts`, pure; this module only feeds it and
// files its output.
//
// ── THE SOURCE, PER DIRECTION ────────────────────────────────────────────────
//
// There is no single source both directions have, so there are two, and they
// meet in one intermediate (`PackageMaterial`) before anything is rendered:
//
//   * LEAVING AN AI THAT WRITES TRANSCRIPTS (Claude, and the Claude fake):
//     its JSONL, through the provider's `transcripts` capability — the same
//     two-window read `SessionQueries.sessionContext` makes for a context
//     drop. It is there whether or not the card's session was live, and it is
//     the conversation's own record rather than what the Feed happened to show.
//   * LEAVING AN AI THAT DOES NOT (an ACP agent: Codex, the fake ACP): the
//     Feed's own blocks for the session the card just left, snapshotted by
//     `sessions:switchAi` before it tore that session down. An ACP agent keeps
//     its conversations to itself, and the only other way to read one —
//     `session/load` — would mean starting the agent just to summarise it.
//
// A source that cannot be READ throws, which the caller turns into "could not
// brief"; a source with nothing in it answers `undefined` — nothing to hand
// over, which is not a failure.
//
// ── THE EXACT TEXT ───────────────────────────────────────────────────────────
//
// Written to `<root>/<cardId>/<markId>.md`, and `briefingRef` is
// `<cardId>/<markId>`. A file, not a rebuild on demand: the context drop's
// `contextOffer` rebuilds, which is right for an offer about a live session,
// but "see what it was told" has to show the bytes that were SENT, and a
// rebuild after the transcript has grown would be a different document. The
// ref is checked against a strict shape before it becomes a path, so the
// renderer can never name a file outside the folder.
import fs from 'fs';
import path from 'path';
import { errorText } from '../../shared/error-text';
import type { AiSwitchMark, BriefingTextResult } from '../../shared/ai-switch';
import type { ProviderCapabilities } from '../extensibility/contributions';
import type { Logger } from '../log/logger';
import { BLOCK_CAP, type FeedBlock } from '../feed/blocks';
import { HISTORY_MAX_LINES, readTranscriptWindow } from '../feed/history';
import { locateConversation } from '../transcripts/paths';
import { materialFromBlocks, materialFromEntries, type PackageMaterial } from './context-package';
import { PACKAGE_TAIL_BYTES, firstPrompt } from './queries';
import { buildBriefing } from './ai-briefing';

export interface BriefingHostDeps {
  /** the folder briefings are kept in — `userData/briefings` in the app */
  root: string;
  /** the provider's declared capabilities, by id (§5.3) — never its frames */
  capabilitiesOf: (providerId: string) => ProviderCapabilities | undefined;
  /** the card's title, for the briefing's header */
  cardTitle: (cardId: string) => string | undefined;
  log: Logger;
}

/** What the hook is asked — `SessionIpcDeps.aiSwitchBriefing`'s request. */
export interface BriefingRequest {
  cardId: string;
  folder: string;
  mark: AiSwitchMark;
  /** the conversation the card left, parked under `mark.from` */
  fromConversation?: { providerId: string; nativeSessionId: string };
  /** the Feed's blocks for the session the card left, taken at the switch */
  fromBlocks?: readonly FeedBlock[];
  /** the marks the card still holds; any other briefing of the card's is removed */
  keepMarkIds?: readonly string[];
}

export interface BriefingResult {
  text: string;
  turnsSummarised: number;
  /** the summary covers only the recent end — the divider then says "the last N" */
  summaryPartial?: boolean;
  /** absent when the text could not be kept — it is still sent */
  briefingRef?: string;
}

export type BriefingRead = BriefingTextResult;

/** One path segment we will put on disk: an id, never `.`/`..`, never a separator. */
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/**
 * Windows drops a trailing dot from a name (`abc.` IS `abc`) and keeps device
 * names (`CON`, `NUL`…) for itself — neither is a file name we will write.
 */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** One id we will put on disk as a file or folder name. */
function safeSegment(s: string): boolean {
  return SEGMENT.test(s) && !s.endsWith('.') && !RESERVED.test(s);
}

/** `<cardId>/<markId>` → its two segments, or nothing for any other shape. */
export function parseBriefingRef(ref: unknown): { cardId: string; markId: string } | undefined {
  if (typeof ref !== 'string') return undefined;
  const parts = ref.split('/');
  if (parts.length !== 2 || !safeSegment(parts[0]) || !safeSegment(parts[1])) return undefined;
  return { cardId: parts[0], markId: parts[1] };
}

export interface BriefingHost {
  /** Build, keep and return the briefing. Throws when the source cannot be read. */
  brief(req: BriefingRequest): BriefingResult | undefined;
  /** The exact text behind a ref. */
  read(ref: unknown): BriefingRead;
  /** A closed card's briefings go with it. */
  forgetCard(cardId: string): void;
}

export function createBriefingHost(deps: BriefingHostDeps): BriefingHost {
  const caps = (providerId: string): ProviderCapabilities | undefined => {
    try {
      return deps.capabilitiesOf(providerId);
    } catch {
      return undefined;
    }
  };

  /** The conversation being left, normalised — or nothing to summarise. */
  const sourceFor = (
    req: BriefingRequest
  ): { material: PackageMaterial; goalFromHead?: string; cut: boolean } | undefined => {
    const transcripts = caps(req.mark.from.providerId)?.transcripts;
    if (req.fromConversation && transcripts) {
      const found = locateConversation(transcripts.projectsRoot(), req.folder, req.fromConversation.nativeSessionId);
      // could not LOOK (a locked directory, a share that dropped) is a failure;
      // looked and it is not there is a conversation with no turns written
      if (found.status === 'unknown') throw new Error(`could not look for the transcript: ${found.reason}`);
      if (found.status === 'found') {
        const file = found.file;
        const tail = readTranscriptWindow(file, PACKAGE_TAIL_BYTES);
        // a transcript that is THERE and would not read is a failure, not an
        // empty conversation (#766's distinction)
        if (!tail.read) throw new Error('the transcript of the conversation being left could not be read');
        const cut = tail.cut || tail.entries.length >= HISTORY_MAX_LINES;
        let goalFromHead: string | undefined;
        if (cut) {
          try {
            goalFromHead = firstPrompt(file);
          } catch {
            goalFromHead = undefined; // the package then says the goal is not known
          }
        }
        return { material: materialFromEntries(tail.entries), goalFromHead, cut };
      }
    }
    // taken at the switch and EMPTY: the session was open and held nothing
    if (req.fromBlocks && req.fromBlocks.length === 0) return undefined;
    if (req.fromBlocks && req.fromBlocks.length > 0) {
      // the Feed keeps its newest BLOCK_CAP blocks; a full buffer has lost older ones
      return { material: materialFromBlocks(req.fromBlocks), cut: req.fromBlocks.length >= BLOCK_CAP };
    }
    // A CONVERSATION THAT IS THERE AND COULD NOT BE READ is a failure, not
    // "nothing to hand over" (review finding): an AI with no transcript whose
    // session was not open at the switch — a card switched straight after a
    // relaunch — left no Feed to take. Saying "started fresh" would hide that.
    if (req.fromConversation && !transcripts) {
      throw new Error('the conversation being left was not open at the switch, so there was nothing to read');
    }
    return undefined;
  };

  const keep = (cardId: string, markId: string, text: string, keepIds?: readonly string[]): string | undefined => {
    if (!safeSegment(cardId) || !safeSegment(markId)) {
      deps.log.warn('the briefing was sent but not kept: an id is not a safe file name', { cardId: cardId.slice(0, 80) });
      return undefined;
    }
    const dir = path.join(deps.root, cardId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${markId}.md`), text, 'utf8');
    } catch (err) {
      deps.log.warn('the briefing was sent but could not be kept; "see what it was told" will not be offered', {
        cardId,
        error: errorText(err),
      });
      return undefined;
    }
    if (keepIds) {
      // the card keeps its last MAX_AI_SWITCHES marks; a briefing for a mark it
      // has dropped can no longer be opened from anywhere
      const wanted = new Set([...keepIds, markId]);
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name.endsWith('.md') && !wanted.has(name.slice(0, -3))) fs.rmSync(path.join(dir, name), { force: true });
        }
      } catch (err) {
        deps.log.info('could not prune old briefings', { cardId, error: errorText(err) });
      }
    }
    return `${cardId}/${markId}`;
  };

  return {
    brief(req) {
      const source = sourceFor(req);
      if (!source) return undefined;
      const fromCaps = caps(req.mark.from.providerId);
      const toCaps = caps(req.mark.to.providerId);
      let title: string | undefined;
      try {
        title = deps.cardTitle(req.cardId);
      } catch {
        title = undefined;
      }
      const briefing = buildBriefing({
        from: { ...req.mark.from, instructionFiles: fromCaps?.instructionFiles },
        to: { ...req.mark.to, instructionFiles: toCaps?.instructionFiles },
        cardTitle: title || path.basename(req.folder) || req.folder,
        folder: req.folder,
        material: source.material,
        goalFromHead: source.goalFromHead,
        cut: source.cut,
      });
      if (!briefing) return undefined;
      const briefingRef = keep(req.cardId, req.mark.id, briefing.text, req.keepMarkIds);
      return {
        text: briefing.text,
        turnsSummarised: briefing.turnsSummarised,
        ...(briefing.partial ? { summaryPartial: true } : {}),
        ...(briefingRef ? { briefingRef } : {}),
      };
    },

    read(ref) {
      const parsed = parseBriefingRef(ref);
      if (!parsed) return { ok: false, reason: 'bad-ref' };
      try {
        return { ok: true, text: fs.readFileSync(path.join(deps.root, parsed.cardId, `${parsed.markId}.md`), 'utf8') };
      } catch {
        return { ok: false, reason: 'gone' };
      }
    },

    forgetCard(cardId) {
      if (!safeSegment(cardId)) return;
      try {
        fs.rmSync(path.join(deps.root, cardId), { recursive: true, force: true });
      } catch (err) {
        deps.log.info('could not remove a closed card\'s briefings', { cardId, error: errorText(err) });
      }
    },
  };
}
