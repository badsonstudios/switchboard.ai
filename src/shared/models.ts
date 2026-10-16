// The models a session will accept, in the host's NEUTRAL shape (E40 item 04,
// #1287).
//
// `SessionControls.models.list()` answers `{ models: [...] }` with entries of
// this shape, and the two model pickers read it through `readModels`. Claude's
// `list_models` answer already IS this shape (the names below are the ones it
// measured with), so Claude's control passes it through untouched; another
// engine maps its own list onto it (ACP: `configOptions` `category:"model"`,
// `spike/findings/e40-codex-acp.md` Q4).
//
// Moved here from `shared/stream-protocol.ts`, which is now
// `main/providers/claude-protocol.ts`: the renderer must not import a
// provider's wire module.

/**
 * One model the CLI will accept, as a `models.list()` answer describes it.
 *
 * Every field but `value` is optional on purpose: `value` is the only one we
 * SEND back, and a CLI that renames a display field must degrade the picker's
 * labels rather than empty it. Measured payload — 5 entries, 3 shown:
 *
 *     {value:"default",  resolvedModel:"claude-opus-5[1m]", displayName:"Default (recommended)",
 *      description:"Opus 5 with 1M context · Best for everyday, complex tasks", …}
 *     {value:"sonnet",   resolvedModel:"claude-sonnet-5",   displayName:"Sonnet", …}
 *     {value:"haiku",    resolvedModel:"claude-haiku-4-5-20251001", displayName:"Haiku"}
 *     // …plus "opus[1m]" and "claude-fable-5[1m]", same shape
 *
 * `supportsEffort` / `supportedEffortLevels` / `supportsFastMode` also ride
 * along and are deliberately NOT modelled HERE. The effort pair is read by
 * `main/providers/claude-effort.ts` (#1115) straight off the raw payload, for the effort
 * chip; the model picker has no use for it, and a type that claims it here
 * invites a picker that half-supports it.
 *
 * NOTHING IN THE PAYLOAD MARKS THE CURRENT MODEL. Neither does `initialize`
 * (its keys were dumped; there is no current-model field). The only place the
 * running model appears is `system:init.model`, which arrives ONCE PER TURN —
 * so before a session's first turn its model is genuinely unknown, and a
 * picker must say so rather than guess at `default`.
 */
export interface CliModel {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
}

/**
 * The models out of a `list_models` (or `initialize`) payload.
 *
 * Lenient by construction: a malformed entry is dropped rather than failing the
 * whole list, and an entry with no usable `value` is worthless to us because
 * `value` is the only thing `set_model` accepts.
 */
export function readModels(response: Record<string, unknown>): CliModel[] {
  const raw = response.models;
  if (!Array.isArray(raw)) return [];
  const out: CliModel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.value !== 'string' || !e.value) continue;
    out.push({
      value: e.value,
      ...(typeof e.resolvedModel === 'string' ? { resolvedModel: e.resolvedModel } : {}),
      ...(typeof e.displayName === 'string' ? { displayName: e.displayName } : {}),
      ...(typeof e.description === 'string' ? { description: e.description } : {}),
    });
  }
  return out;
}

