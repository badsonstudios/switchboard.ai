// What crosses IPC for a dispatch (P2-E13-03, §5.15).
//
// ── WHY THESE ARE NOT `RoleTemplate` ────────────────────────────────────────
//
// #946's `isSaneRoleTemplate` ends with a warning addressed to this item: it
// answers exactly one question — "may this go in the workspace file?" — and a
// BUILT-IN's answer is no, because it refuses the `builtin:` id namespace. So a
// `RoleTemplate` arriving on a channel could only be validated with a predicate
// that refuses the three templates every fresh install has. The contract written
// there is that **dispatch passes a template ID and main resolves it with
// `templateById`**, and these types are that contract in the type system:
//
//   * OUT, the renderer gets `DispatchTemplateDto` — a row to render. It has no
//     `rolePrompt`, because a menu never shows one and the least surface that
//     works is the right surface; main already holds the real template.
//   * IN, the renderer sends an `id`. Nothing else about a template travels
//     inward at all, so there is no object for a predicate to have to refuse.
//
// ── AND WHY THE REFUSAL IS COMPUTED IN MAIN ─────────────────────────────────
//
// `refusalKey` is main's answer, not the renderer's. `DispatchGates.forkEnabled`
// carries a warning of its own — read it at render time from the same accessor
// main reads, because a menu that passes a CACHED `true` offers a row that
// refuses the moment it is clicked. Having main compute the key satisfies that by
// construction: there is one reading of the setting, and it is main's.
import type { AutonomyMode } from './sessions';
import type { ContextPolicy, WorkspacePolicy } from './dispatch';

/** One dispatch target, as a row the palette and the ⋯ menu can render. */
export interface DispatchTemplateDto {
  id: string;
  name: string;
  contextPolicy: ContextPolicy;
  workspacePolicy: WorkspacePolicy;
  autonomy: AutonomyMode;
  /** A code-defined template (§5.15's three) rather than one of the user's. */
  builtIn: boolean;
  /**
   * The i18n key for why this template cannot be dispatched right now, or absent.
   *
   * ⚠️ ABSENT MEANS "NOTHING TO GREY THE ROW OUT FOR", NEVER "this will work" —
   * `templateRefusalKey`'s own words. A `full` dispatch can still be refused at
   * `dispatch:prepare` for reasons no list can know: a cross-provider target, or
   * an author session that has not had a turn yet.
   */
  refusalKey?: string;
  accentColor?: string;
}

/** What the dialog reads before it can offer anything. */
export interface DispatchOptions {
  templates: DispatchTemplateDto[];
  /**
   * The author session's opening prompt, as the task line's DEFAULT.
   *
   * Measured on #947 against this repo's own 7.7 MB transcript: a session started
   * from a slash command answers `"do it."` — correct, honest, and nearly
   * useless, because the real brief was command plumbing and an `isMeta` line.
   * Clean-room is defined by withholding everything else, so this is the one
   * field that has to carry the job and it is the field most likely to be empty
   * in practice. That is why the gesture lets the user edit it, and why this is
   * the DEFAULT rather than the value.
   *
   * Absent when the transcript has no opening prompt to read.
   */
  taskStatement?: string;
  /**
   * Where a dispatch from this session would run — the author's own folder.
   *
   * ⚠️ **MAIN'S RESOLVE, NOT THE RENDERER'S COPY OF THE CARD IDENTITY** (#949).
   * The renderer knows a folder for the card it opened this dialog from, and
   * showing that one would be a second description of a fact `dispatch:prepare`
   * settles for itself a moment later — the two could disagree for a card whose
   * session moved, and the one on screen would be the one that did not spawn
   * anything. So the dialog is TOLD, by the same `queries.resolve` the prepare
   * path calls.
   *
   * Absent when the session does not resolve. `dispatch:options` never refuses
   * (a bad id must not hide three built-ins), so this field carries that
   * failure as an absence and the dialog simply says less.
   *
   * v1 has one workspace policy, so there is one answer. When Phase 3 builds
   * worktrees this becomes a per-template question and this field becomes the
   * `same-folder` case of it — which is why the dialog reads it alongside a
   * template's `workspacePolicy` rather than instead of it.
   */
  folder?: string;
}

/** The dispatch the user confirmed. */
export interface DispatchRequestWire {
  /** the AUTHOR session — its live session id, what `@name` resolves to */
  from: string;
  templateId: string;
  /**
   * The task, as the user finally stated it. THREE states, not two.
   *
   * ABSENT means "use whatever the transcript says". Only `clean-room` reads this
   * field at all, so the dialog offers it only for that policy and therefore only
   * that policy ever sends it — which is what keeps this branch reachable rather
   * than theoretical.
   *
   * PRESENT AND EMPTY means the user CLEARED the line, and it is honoured as the
   * choice it is: the bundle says "not known" rather than quietly restoring the
   * `"do it."` that had just been deleted.
   *
   * PRESENT AND NON-EMPTY is the override. Main does not try to tell "they typed
   * the default back" from "they typed something new" — the difference does not
   * change what the reviewer is handed.
   */
  taskStatement?: string;
  /** What "done" looks like. Nothing in a transcript is labelled with these. */
  acceptanceCriteria?: string;
}

/**
 * A dispatch that is ready to spawn, or the reason it is not.
 *
 * `dispatchId` is an opaque, SINGLE-USE handle to a briefing main is holding.
 * The briefing text itself never crosses to the renderer — see
 * `dispatch-ipc.ts` for why that matters and what a stale id does.
 */
export type DispatchPrepared =
  | {
      ok: true;
      dispatchId: string;
      /** where the dispatched session runs — `same-folder` is the only v1 answer */
      folder: string;
      /** for the card's title, which the renderer builds through `t` */
      templateName: string;
    }
  | { ok: false; reason: string; reasonKey?: string };

// ⚠️ WHAT IS DELIBERATELY NOT ON THAT SHAPE: the briefing's SIZE and its `empty`
// flag. Both exist on `DispatchBriefing` and both would make a nice line in the
// dialog — "hands over about 3,100 tokens" — and neither has a reader, for a
// reason that is about ordering rather than taste.
//
// A size can only be known by BUILDING the briefing, and building one shells out
// to git for a diff (#764). So a dialog that showed the size would have to prepare
// on every template the user clicked, or prepare once on Dispatch and report the
// figure after the user had already committed — a number that arrives too late to
// act on. Neither is worth a git call per click.
//
// So it is left out, on #946's and #947's own rule: a field with no caller is
// speculative surface. A later item that wants a preview adds it with the caller
// that needs it.
