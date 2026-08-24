// Feed view visibility rules (P2-E12-07, §5.10 verbosity presets). Pure —
// the FeedView component applies these; tests pin the preset semantics.
export interface FeedBlockDto {
  seq: number;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'todos';
  text?: string;
  tool?: {
    name: string;
    /** presentation class stamped by the watcher — dispatch on THIS, never
     *  the raw name (PowerShell renders like Bash; review P1 #9) */
    category?: 'shell' | 'edit' | 'read' | 'other';
    summary: string;
    detail?: string;
    description?: string;
    filePath?: string;
    oldString?: string;
    newString?: string;
    out?: string;
  };
  todos?: Array<{ content: string; status: string }>;
  /**
   * user: what rode with this prompt (#491), counted off the message that was
   * actually sent. Absent — never `{images: 0, documents: 0}` — for a prompt
   * that carried nothing, which is what keeps the ordinary block unchanged.
   * The main-side shape and the reasoning are `main/feed/blocks.ts`.
   */
  attachments?: { images: number; documents: number };
  durationMs?: number;
  sidechain: boolean;
  ts?: string;
  /** tokens are still arriving into this block (P2-E18-10, stream sessions) */
  streaming?: boolean;
}

/** Insert-or-replace by seq: the watcher re-emits updated blocks (E10-06). */
export function upsertBlock(blocks: FeedBlockDto[], b: FeedBlockDto, cap = 1000): FeedBlockDto[] {
  const i = blocks.findIndex((x) => x.seq === b.seq);
  if (i >= 0) {
    const next = [...blocks];
    next[i] = b;
    return next;
  }
  // insert by seq, never append blindly: a re-emit of a block that was
  // already evicted from the capped window must not render as newest (it
  // lands back at the head and the cap slice drops it again)
  const next = [...blocks];
  const at = next.findIndex((x) => x.seq > b.seq);
  if (at < 0) next.push(b);
  else next.splice(at, 0, b);
  return next.length > cap ? next.slice(-cap) : next;
}

/**
 * Which blocks earn a timeline dot (#91, §5.10 "Block presentation").
 *
 * The dot marks an EVENT — something the session did or the user asked for.
 * A plain assistant reply is not an event, it is the answer, and Dan put it
 * plainly on 2026-07-26: "when you actually answer me and then are waiting for
 * my next prompt, I shouldn't need the dot". There the dot is noise that also
 * costs the prose its left margin.
 *
 * The GUTTER stays either way — the caller renders a spacer of the same size —
 * so the column never jumps between a dotted block and an undotted one.
 */
export function showsTimelineDot(kind: FeedBlockDto['kind']): boolean {
  return kind !== 'assistant';
}

export type Verbosity = 'quiet' | 'normal' | 'firehose';

/** quiet = prose only · normal = prose + tools, no thinking · firehose = everything. */
export function blockVisible(b: FeedBlockDto, v: Verbosity): boolean {
  if (v === 'firehose') return true;
  if (b.kind === 'thinking') return false;
  if (v === 'quiet') return (b.kind === 'user' || b.kind === 'assistant') && !b.sidechain;
  return true; // normal (tools + todos included)
}
