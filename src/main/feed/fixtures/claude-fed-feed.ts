// TEST SUPPORT (#1286): a `StreamFeed` that takes raw Claude frames, the way the
// Feed's tests have always been written.
//
// The Feed itself takes only neutral events since E40 item 03. Its tests keep
// the real Claude frames they were written against — S-10/S-11's captures, the
// #978 local-command turn — and pass them through the REAL translator, exactly
// as the session pump does. So every one of them now checks the translator and
// the Feed together, and a translation that drifted from what the Feed used to
// read would fail here first.
//
// The same for HISTORY since #1303: the Feed's replay takes neutral
// `ReplayEntry`s, and its tests keep the raw Claude transcript lines they were
// written against and pass them through the REAL reader
// (`readClaudeTranscriptEntry`), exactly as `replayResumedHistory` and the
// watcher do — so the hydrate tests' assertions are unchanged and now check
// the reader and the Feed together.
import { StreamFeed } from '../stream-feed';
import type { BlockOrigin, HydrateOptions } from '../blocks';
import { translateClaudeFrame } from '../../providers/claude-events';
import { readClaudeTranscriptEntry } from '../../providers/claude-transcript';

export class ClaudeFedFeed extends StreamFeed {
  /** One raw Claude stream-json frame, translated and ingested. */
  offer(sessionId: string, frame: Record<string, unknown>): void {
    for (const ev of translateClaudeFrame(frame) ?? []) this.ingest(sessionId, ev);
  }

  /**
   * `hydrate` from raw Claude transcript lines, each read by the real reader.
   * `origins` is what `mergeHistory` hands over for the subagent lines (#1140),
   * keyed by the line itself, as `replayResumedHistory` applies it.
   */
  hydrateTranscript(
    sessionId: string,
    entries: readonly Record<string, unknown>[],
    opts: HydrateOptions & { origins?: ReadonlyMap<Record<string, unknown>, BlockOrigin> } = {}
  ): number {
    const { origins, ...rest } = opts;
    return this.hydrate(
      sessionId,
      entries.map((e) => readClaudeTranscriptEntry(e, origins?.get(e))),
      rest
    );
  }

  /** `absorbSidechain` from one raw Claude subagent line and its file's origin. */
  absorbTranscriptLine(sessionId: string, entry: Record<string, unknown>, origin: BlockOrigin): boolean {
    return this.absorbSidechain(sessionId, readClaudeTranscriptEntry(entry, origin));
  }
}
