// How hard the model thinks (#1115): the NEUTRAL half.
//
// What `sessions:effort` answers. Reading and setting it is a provider
// control (E40 item 04, #1287): Claude's verbs and the readers of their
// answers are `main/providers/claude-effort.ts`, which has the measured
// contract.

/** What `sessions:effort` answers, inside a success verdict's `response`. */
export interface EffortState {
  /** the level in force, or `null` when this session's model has none */
  effort: string | null;
  /** the levels this session's model accepts, lowest first, from the CLI */
  levels: string[];
}
