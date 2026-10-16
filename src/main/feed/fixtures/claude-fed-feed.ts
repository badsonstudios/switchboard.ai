// TEST SUPPORT (#1286): a `StreamFeed` that takes raw Claude frames, the way the
// Feed's tests have always been written.
//
// The Feed itself takes only neutral events since E40 item 03. Its tests keep
// the real Claude frames they were written against — S-10/S-11's captures, the
// #978 local-command turn — and pass them through the REAL translator, exactly
// as the session pump does. So every one of them now checks the translator and
// the Feed together, and a translation that drifted from what the Feed used to
// read would fail here first.
import { StreamFeed } from '../stream-feed';
import { translateClaudeFrame } from '../../providers/claude-events';

export class ClaudeFedFeed extends StreamFeed {
  /** One raw Claude stream-json frame, translated and ingested. */
  offer(sessionId: string, frame: Record<string, unknown>): void {
    for (const ev of translateClaudeFrame(frame) ?? []) this.ingest(sessionId, ev);
  }
}
