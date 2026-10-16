// WHICH CONTROLS A SESSION'S AI HAS (E40 item 04, #1287; design record
// `docs/plans/e40-multi-ai-design.md` §3, §5 screen 3).
//
// Each provider declares the controls it has — `SessionControls` in
// `main/sessions/engine-controls.ts`, where a member that is present IS the
// declaration — and the composer reads that declaration to grey a control out
// with a reason, "Not available with <AI>". In BOTH directions: a control
// Claude has and another AI lacks greys out on that AI, and one only another
// AI has greys out on Claude. The mechanism is the same either way, because a
// control is simply a name in this list that a session does or does not have.
//
// In `shared/` because it crosses IPC: main answers `sessions:controls`, the
// preload declares it, the renderer greys by it.

/**
 * Every control the host knows how to offer.
 *
 * - `approvals` — answer an AI's request to use a tool (the approval bar).
 * - `interrupt` — stop the running turn (Stop).
 * - `models` — list the models and switch between them (the model chip).
 * - `effort` — read and set how hard the model thinks (the effort chip).
 * - `contextUsage` — how full the context window is (the context meter).
 * - `modes` — the autonomy mode (the mode chip).
 * - `slashCommands` — the AI runs `/commands` (the palette's AI half, Compact
 *   and Clear).
 * - `mcp` — the live MCP server controls in the MCP manager.
 *
 * ADDING ONE is adding its name here, its member to `SessionControls`, and
 * deciding what the composer does without it. A provider that does not
 * declare a new name greys it out with no further code — which is how a
 * control only another AI has will grey out on Claude.
 */
export const ENGINE_CONTROLS = [
  'approvals',
  'interrupt',
  'models',
  'effort',
  'contextUsage',
  'modes',
  'slashCommands',
  'mcp',
] as const;

export type EngineControl = (typeof ENGINE_CONTROLS)[number];

/**
 * What `sessions:controls` answers for a live session: the AI's display name,
 * for the reason sentence, and the controls it has.
 *
 * `null` (the whole answer) is "this session is not known to main" — an ended
 * or not-yet-started card. The renderer treats that as NOTHING TO GREY OUT:
 * the controls that need a live session already say so in their own way, and a
 * session that cannot be asked must not look as if its AI were missing
 * features it has.
 */
export interface SessionControlsWire {
  /** the provider's display name, e.g. "Claude Code" */
  ai: string;
  /** the controls this session's AI has, in `ENGINE_CONTROLS` order */
  has: EngineControl[];
}

