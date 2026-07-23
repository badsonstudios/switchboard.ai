// Feed view visibility rules (P2-E12-07, §5.10 verbosity presets). Pure —
// the FeedView component applies these; tests pin the preset semantics.
export interface FeedBlockDto {
  seq: number;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'todos';
  text?: string;
  tool?: {
    name: string;
    summary: string;
    detail?: string;
    description?: string;
    filePath?: string;
    oldString?: string;
    newString?: string;
    out?: string;
  };
  todos?: Array<{ content: string; status: string }>;
  durationMs?: number;
  sidechain: boolean;
  ts?: string;
}

/** Insert-or-replace by seq: the watcher re-emits updated blocks (E10-06). */
export function upsertBlock(blocks: FeedBlockDto[], b: FeedBlockDto, cap = 1000): FeedBlockDto[] {
  const i = blocks.findIndex((x) => x.seq === b.seq);
  if (i >= 0) {
    const next = [...blocks];
    next[i] = b;
    return next;
  }
  const next = [...blocks, b];
  return next.length > cap ? next.slice(-cap) : next;
}

export type Verbosity = 'quiet' | 'normal' | 'firehose';

/** quiet = prose only · normal = prose + tools, no thinking · firehose = everything. */
export function blockVisible(b: FeedBlockDto, v: Verbosity): boolean {
  if (v === 'firehose') return true;
  if (b.kind === 'thinking') return false;
  if (v === 'quiet') return (b.kind === 'user' || b.kind === 'assistant') && !b.sidechain;
  return true; // normal (tools + todos included)
}
