// How hard the model thinks: reading and setting a session's EFFORT level
// (#1115).
//
// ── THE CONTRACT, MEASURED AGAINST THE CLI ON PATH (2.1.288, 2026-10-09) ─────
//
// `spike/probes/1115/` holds the two probes; `spike/findings/1115-effort.md`
// the captures. No prompt was sent, so none of it cost a turn.
//
//  * **`set_thinking_level` IS GONE.** The ticket was written against 2.1.245
//    and names it. On 2.1.288 it answers
//    `Unsupported control request subtype: set_thinking_level`, and the string
//    is not in the binary at all.
//  * **The level is set with `apply_flag_settings`**, `{settings:{effortLevel}}`.
//    It answers `success` with no payload. All five of `low`, `medium`, `high`,
//    `xhigh`, `max` take — `max` included, although the settings schema's own
//    enum stops at `xhigh`.
//  * ⚠️ **A LEVEL THE CLI DOES NOT KNOW ALSO ANSWERS `success`, AND CHANGES
//    NOTHING.** The `set_model` trap, again. So the acknowledgement is not
//    evidence, and a set is verified BY EFFECT (next point).
//  * **THE CURRENT LEVEL IS READABLE**: `get_settings` answers
//    `{effective, sources, applied}` and `applied` is
//    `{model, effort, …}` — what the session is actually running. It is there
//    on a cold session, before any turn. `effort` is `null` on a model that has
//    no effort levels (Haiku 4.5).
//    (`applied.model` is also the answer to "which model is this session on",
//    which `stream-model.ts` recorded as unanswerable. #1174 took that up:
//    `appliedModel` below, and `spike/findings/1174-applied-model.md`.)
//  * `{effortLevel: null}` clears the setting and the level goes back to the
//    model's default (`medium` here).
//  * The level SURVIVES A MODEL SWITCH: set `max`, switch to Haiku (effort
//    `null`), switch to Sonnet, and it is `max` again.
//  * `list_models` gives each model `supportsEffort` and
//    `supportedEffortLevels`. Haiku 4.5 has neither key at all; the two 4.6
//    models have no `xhigh`.
//
// In `shared/` because it crosses IPC: main builds the requests and reads the
// answers, the preload declares the shape, the renderer draws it.
import { controlRequest, StreamControlRequest } from './stream-protocol';

/** What `sessions:effort` answers, inside a success verdict's `response`. */
export interface EffortState {
  /** the level in force, or `null` when this session's model has none */
  effort: string | null;
  /** the levels this session's model accepts, lowest first, from the CLI */
  levels: string[];
}

/** `get_settings` — the effective settings, and what is actually applied. */
export function getSettingsRequest(requestId: string): StreamControlRequest {
  return controlRequest(requestId, { subtype: 'get_settings' });
}

/**
 * `apply_flag_settings {effortLevel}`.
 *
 * Returns `null` for anything that is not a non-empty string: a dropped or
 * empty field must not reach a verb that says `success` to everything. (A
 * `null` level is a real request — "back to the default" — and nothing here
 * offers it; if something ever does it gets its own builder, so that "I forgot
 * the argument" can never be spelled the same way.)
 */
export function setEffortRequest(requestId: string, level: unknown): StreamControlRequest | null {
  if (typeof level !== 'string') return null;
  const trimmed = level.trim();
  if (!trimmed) return null;
  return controlRequest(requestId, {
    subtype: 'apply_flag_settings',
    settings: { effortLevel: trimmed },
  });
}

/**
 * What a `get_settings` answer says is applied, or `null` when it does not say.
 *
 * `null` (the whole thing) is "this CLI has no `applied` block" — an older one,
 * or a renamed field — and the caller shows no chip rather than a guess.
 * `effort: null` inside it is a real answer: this model has no effort levels.
 */
export function readApplied(
  response: Record<string, unknown>
): { model: string | null; effort: string | null } | null {
  const applied = response.applied;
  if (!applied || typeof applied !== 'object') return null;
  const a = applied as Record<string, unknown>;
  if (!('effort' in a)) return null;
  return {
    model: typeof a.model === 'string' && a.model ? a.model : null,
    effort: typeof a.effort === 'string' && a.effort ? a.effort : null,
  };
}

/**
 * The model a `get_settings` answer says the session is running, or `null`
 * (#1174).
 *
 * Read on its own, not through `readApplied`: that one answers `null` for an
 * `applied` block with no `effort` key, and "which model" does not depend on
 * whether this CLI reports effort. Measured to be the same string
 * `system:init.model` carries, on a cold, a switched and a resumed session
 * (`spike/findings/1174-applied-model.md`).
 */
export function appliedModel(response: Record<string, unknown>): string | null {
  const applied = response.applied;
  if (!applied || typeof applied !== 'object') return null;
  const model = (applied as Record<string, unknown>).model;
  return typeof model === 'string' && model.trim() ? model : null;
}

/** `claude-opus-5[1m]` and `claude-opus-5` are the same model for this purpose */
const bare = (id: string): string => id.replace(/\[[^\]]*\]$/, '');

/**
 * The effort levels for the model a session is on, out of a `list_models`
 * answer.
 *
 * THE MATCH IS BEST-EFFORT, AND SAFE TO GET WRONG. `applied.model` is a
 * resolved id (`claude-opus-5-5`) and the list is keyed by alias (`opus`,
 * `default`) with a `resolvedModel` that may carry a suffix or stop short of
 * the minor version, so there is no exact join the CLI promises. An entry
 * matches when its value or its resolved id IS the applied model, or is a
 * prefix of it; the longest match wins. With no match, the LONGEST list any
 * model has is used — never the first one, which might be a short one: an
 * extra level is caught (below), a missing one is a level nobody can choose
 * and nothing reports.
 *
 * Getting it wrong offers a level the model lacks (the 4.6 models have no
 * `xhigh`), and that is caught where it matters: a set is verified by reading
 * the level back, so an unsupported one is reported as not taken.
 */
export function effortLevelsFor(
  response: Record<string, unknown>,
  appliedModel: string | null
): string[] {
  const raw = response.models;
  if (!Array.isArray(raw)) return [];
  const entries: Array<{ ids: string[]; levels: string[] }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const levels = Array.isArray(e.supportedEffortLevels)
      ? e.supportedEffortLevels.filter((l): l is string => typeof l === 'string' && !!l)
      : [];
    if (!levels.length) continue;
    const ids = [e.value, e.resolvedModel]
      .filter((v): v is string => typeof v === 'string' && !!v)
      .map(bare);
    entries.push({ ids, levels });
  }
  if (!entries.length) return [];
  if (appliedModel) {
    const want = bare(appliedModel);
    let best: { levels: string[]; length: number } | null = null;
    for (const entry of entries) {
      for (const id of entry.ids) {
        const hit = id === want || want.startsWith(`${id}-`);
        if (hit && (!best || id.length > best.length)) best = { levels: entry.levels, length: id.length };
      }
    }
    if (best) return [...best.levels];
  }
  let longest = entries[0].levels;
  for (const entry of entries) if (entry.levels.length > longest.length) longest = entry.levels;
  return [...longest];
}

/** the order the CLI lists levels in, for placing one its list left out */
const KNOWN_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * `levels` with `level` in it, in the right place.
 *
 * The level in force is always offered, whatever the list says — a menu that
 * cannot show its own current value has nothing to tick. It goes where the
 * CLI's own order puts it (so `max` on a three-level list reads low, medium,
 * high, max and not something stranger), or last when it is a level this
 * file has never heard of.
 */
export function withLevel(levels: readonly string[], level: string): string[] {
  if (levels.includes(level)) return [...levels];
  const rank = KNOWN_ORDER.indexOf(level);
  if (rank < 0) return [...levels, level];
  const out = [...levels];
  const at = out.findIndex((l) => KNOWN_ORDER.indexOf(l) > rank);
  out.splice(at < 0 ? out.length : at, 0, level);
  return out;
}
