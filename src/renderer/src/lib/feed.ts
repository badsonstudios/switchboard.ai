// Feed view visibility rules (P2-E12-07, §5.10 verbosity presets). Pure —
// the FeedView component applies these; tests pin the preset semantics.
export interface FeedBlockDto {
  seq: number;
  kind: 'user' | 'assistant' | 'thinking' | 'tool';
  text?: string;
  tool?: { name: string; summary: string; detail?: string };
  sidechain: boolean;
  ts?: string;
}

export type Verbosity = 'quiet' | 'normal' | 'firehose';

/** quiet = prose only · normal = prose + tools, no thinking · firehose = everything. */
export function blockVisible(b: FeedBlockDto, v: Verbosity): boolean {
  if (v === 'firehose') return true;
  if (b.kind === 'thinking') return false;
  if (v === 'quiet') return (b.kind === 'user' || b.kind === 'assistant') && !b.sidechain;
  return true; // normal
}
