// The window's side of a manual dispatch (P2-E13-03, §5.15 Trigger 1).
//
// Two channels, and the split between them is the whole design:
//
//   dispatch:options   IN   what can I dispatch, and what is the task by default?
//   dispatch:prepare   IN   build the briefing for this template — hold it for me
//
// Nothing here spawns anything. The spawn is `sessions:create`, which is the ONE
// place a session starts in this app, and it grows exactly one operand: the
// `dispatchId` this module hands back.
//
// ── WHY TWO PHASES AND NOT ONE ──────────────────────────────────────────────
//
// A card is a dockview panel, and only the renderer can make one. A session is
// started by that panel's own lazy-spawn effect, on first visibility. So a
// one-call `sessions:dispatch` would have to either spawn a session with no card
// bound to it, or reach into the renderer and make a panel — and both of those
// are a second way to start a session, which is the thing `sessions:create`'s
// header spends thirty lines being the only one of.
//
// So: prepare, then spawn. The renderer gets an opaque handle and passes it along
// the existing path (`CardParams` → `sessions:create`), exactly as `forkFrom`
// already travels.
//
// ── THE BRIEFING NEVER CROSSES TO THE RENDERER ──────────────────────────────
//
// It is built here and it stays here. The renderer carries a string that means
// nothing on its own. Two reasons, and the second is the load-bearing one:
//
//   * a clean-room bundle is DEFINED by what it withholds (#947), and a document
//     that round-trips through the renderer is a document the renderer could
//     alter — which would make "the reasoning history was withheld" a claim about
//     a value main no longer controls;
//   * `CardParams` are serialized into the SAVED LAYOUT. A briefing in there
//     would put the author's diff and task statement into `workspace.json`, on
//     disk, for ever, for every dispatch anybody ever made.
//
// ── WHAT A STALE `dispatchId` DOES, AND WHY IT IS FAIL-OPEN ─────────────────
//
// The map is in memory and panel params outlive the process, so a `dispatchId`
// CAN arrive on a later launch. It resolves to nothing, the card starts as an
// ordinary session, and the log says which card lost its briefing. That is P6:
// our bookkeeping going stale must not cost a card its start. It is also why
// consumption is SINGLE-USE — see `consume`.
import { randomUUID } from 'crypto';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import { errorText } from '../../shared/error-text';
import {
  allTemplates,
  isBuiltInTemplateId,
  isProviderIdShape,
  templateById,
  templateRefusalKey,
  type RoleTemplate,
} from '../../shared/dispatch';
import type {
  DispatchAiLogin,
  DispatchOptions,
  DispatchPrepared,
  DispatchTemplateDto,
} from '../../shared/dispatch-wire';
import {
  buildDispatchContext,
  type DispatchContext,
  type DispatchContextDeps,
} from './dispatch-context';

/**
 * How long a prepared dispatch is worth keeping.
 *
 * Sized for "the user pressed Dispatch and the panel mounted", which is
 * milliseconds — not for a deliberation. The generous margin is for a card that
 * lands somewhere it is not immediately visible, since the spawn effect waits for
 * that; the point of the bound is that a `prepare` whose card never appears must
 * not be a leak.
 */
export const DISPATCH_TTL_MS = 15 * 60_000;

/**
 * How many prepared dispatches may be held at once.
 *
 * A bound as well as a TTL, because the TTL alone is a bound only if time passes:
 * nothing stops a surface from calling `prepare` in a loop, and a briefing is a
 * whole diff. Oldest out first — the newest is the one the user is about to spawn.
 */
export const MAX_PENDING_DISPATCHES = 32;

/**
 * A briefing waiting for the card that will carry it.
 *
 * The TEMPLATE, not its id: it was resolved with `templateById` at prepare time
 * and the spawn must not resolve it again. Re-resolving would let a user edit or
 * delete the template between the dialog and the spawn and get a session briefed
 * one way and instructed another — the two halves of one dispatch decided at two
 * different moments.
 */
export interface PendingDispatch {
  context: DispatchContext;
  template: RoleTemplate;
  /** the author session, for the log and for #951's lineage to pick up later */
  from: string;
  folder: string;
  /**
   * The AI the dispatched session runs on — "Run it on" (#1296), already checked
   * to be registered when this was prepared. `sessions:create` starts the
   * brand-new card on it, and re-checks it, because a provider can go between
   * the dialog and the spawn.
   */
  providerId: string;
  /**
   * That AI's display name when the dispatch was prepared (#1318). Kept because
   * a "Something else" AI removed before the spawn takes its name with it, and
   * the card's refusal has to say WHICH AI is gone. Optional: absent reads as
   * the id.
   */
  providerName?: string;
  at: number;
}

/** One AI a dispatch can run on, as the registry knows it. */
export interface DispatchProvider {
  id: string;
  name: string;
}

/**
 * How long `dispatch:prepare` waits for a login answer before saying `unknown`.
 *
 * The shipped reader (the AI catalog's last detection, #1291) answers at once;
 * the bound is for a reader that probes. The wait happens behind the dialog's
 * own "Preparing…" state. An AI slower than this goes ahead (fail-open), and
 * its own session says so if it really is logged out.
 */
export const LOGIN_WAIT_MS = 3_000;

/**
 * ...and how long `dispatch:options` waits: long enough for an answer that is
 * already known (which resolves at once), not long enough for a probe. The
 * dialog does not open until options arrive, and a menu click that does nothing
 * for seconds reads as broken (review). An AI whose answer is not ready shows
 * undimmed, and `prepare` still asks with the full wait before anything starts.
 */
export const OPTIONS_LOGIN_WAIT_MS = 150;

export interface DispatchIpcDeps {
  broker: IpcBroker;
  log: Logger;
  /** the user's saved templates — the built-ins are code and are added here */
  listTemplates: () => RoleTemplate[];
  /** everything `buildDispatchContext` needs; §5.5 L3's flag is a thunk in it */
  contextDeps: DispatchContextDeps;
  /** the author session's opening prompt, for the task line's default */
  taskStatementOf: (sessionId: string) => string | undefined;
  /** §5.5 L3 fork adoption is on — ONE reading of the setting, and it is main's */
  experimentalFork: () => boolean;
  /**
   * Every AI a dispatch could run on — the registered providers, in
   * registration order (#1296, "Run it on").
   *
   * This REPLACED a `targetProviderId: () => string` dep that was pinned to the
   * default provider, from the days a dispatch had no AI choice. The target is
   * now the user's pick, or the author's own AI, and it is checked against this
   * list: a target not on it is refused, never swapped for the default.
   */
  providers: () => DispatchProvider[];
  /**
   * Whether an AI is logged in. Optional, and absent means `unknown` for
   * everyone (not dimmed, not refused). Must not reject; a rejection is read as
   * `unknown`. `index.ts` wires it to the AI catalog's detection (#1291).
   */
  loginStateOf?: (providerId: string) => Promise<DispatchAiLogin>;
}

/**
 * What the spawn path needs from the pending map.
 *
 * ⚠️ TWO METHODS RATHER THAN ONE, AND THE SPLIT IS LOAD-BEARING — but the reason is
 * WHEN, not how often. `sessions:create` has to READ the dispatch early, because the
 * template decides the session's autonomy and its accent and a `full` dispatch
 * decides what `planSessionStart` is even asked for. Between that read and the spawn,
 * several things can still refuse: a fork the provider cannot set up, a transport
 * with no typed-message channel. A single consuming read would eat the briefing on
 * every one of those paths, turning the card's own "Try again" button into a silently
 * unbriefed session.
 *
 * So: read early, spend late. (It happens to read exactly ONCE and reuse the value —
 * an earlier version of this note said "several times", which sent a reader looking
 * for peeks that are not there. Reading per consumer would be four reads of a map
 * that can expire between them.)
 */
export interface DispatchRegistry {
  /** The dispatch under this id, WITHOUT spending it. Safe to call repeatedly. */
  peek: (dispatchId: unknown) => PendingDispatch | undefined;
  /**
   * Spend it. Call this once the session is definitely being started.
   *
   * ⚠️ THE DELETION IS THE POINT, not tidiness. `dispatchId` lives in a dockview
   * panel param, so it is re-sent on every remount and every restart of that card
   * — hide and reveal a dispatched card, or let its session crash and come back,
   * and `sessions:create` runs again with the same id. Without spending it the
   * reviewer would be briefed a second time, in the middle of a conversation it
   * was already having, in the voice of a user who typed nothing. That is the same
   * "a param is not the one-shot it reads like" hazard `resumeConversationId`
   * documents, with a worse failure at the end of it.
   */
  consume: (dispatchId: unknown) => void;
}

/**
 * The dispatch channels, plus the registry the spawn path collects briefings from.
 *
 * The registry is returned rather than exported as module functions because the
 * map is per-wiring state: the unit harness stands two of these up in one process,
 * and a module-level map would make them one.
 */
export function registerDispatchIpc(deps: DispatchIpcDeps): DispatchRegistry {
  const { broker, log } = deps;
  const pending = new Map<string, PendingDispatch>();

  const refuse = (channel: string, reason: string, fields: LogFields = {}): DispatchPrepared => {
    log.warn(`${channel} refused: ${reason}`, fields);
    return { ok: false, reason };
  };

  /**
   * Every template on offer, with duplicates by id removed.
   *
   * ⚠️ THE DEDUPE IS HERE RATHER THAN IN THE COMPONENT, and #946's review is
   * explicit about why it is needed at all: `keepSane` does not dedupe by id —
   * deliberately, consistently with the other five persisted lists — so only a
   * hand-edited `workspace.json` can produce a duplicate, and
   * `removeDispatchTemplate` filters every row with that id, which makes the
   * state self-healing. What it costs is at the SURFACE: a list keyed by `id`
   * renders two React rows with the same key, and `upsertDispatchTemplate`
   * updates only the first, so an edit appears to half-apply.
   *
   * Fixing it in main rather than in the list makes the renderer's key
   * collision-proof BY CONSTRUCTION, for every surface, instead of by a rule the
   * next list to be written has to remember. First wins, matching
   * `upsertDispatchTemplate`'s own `findIndex` — so the row the user sees is the
   * row an edit would actually change.
   */
  const offered = (): RoleTemplate[] => {
    const seen = new Set<string>();
    const out: RoleTemplate[] = [];
    for (const t of allTemplates(deps.listTemplates())) {
      if (seen.has(t.id)) {
        log.warn('duplicate dispatch template id — showing the first only', { templateId: t.id });
        continue;
      }
      seen.add(t.id);
      out.push(t);
    }
    return out;
  };

  const asDto = (t: RoleTemplate): DispatchTemplateDto => {
    // READ AT RENDER TIME, FROM THE ACCESSOR MAIN READS — `DispatchGates`'
    // warning, satisfied by there being only one reading and it happening here.
    const refusalKey = templateRefusalKey(t, { forkEnabled: deps.experimentalFork() });
    return {
      id: t.id,
      name: t.name,
      contextPolicy: t.contextPolicy,
      workspacePolicy: t.workspacePolicy,
      autonomy: t.autonomy,
      builtIn: isBuiltInTemplateId(t.id),
      ...(refusalKey === undefined ? {} : { refusalKey }),
      ...(t.accentColor === undefined ? {} : { accentColor: t.accentColor }),
      ...(t.preferredProviderId === undefined ? {} : { preferredProviderId: t.preferredProviderId }),
    };
  };

  /** The registered providers, read once per call; a throwing list is no list. */
  const providerList = (): DispatchProvider[] => {
    try {
      return deps.providers();
    } catch (err) {
      log.warn('the provider list could not be read', { error: errorText(err) });
      return [];
    }
  };

  /**
   * One AI's login state, bounded by `LOGIN_WAIT_MS` and never rejecting.
   * FAIL-OPEN: anything other than a definite answer is `unknown`.
   */
  const loginOf = async (providerId: string, waitMs = LOGIN_WAIT_MS): Promise<DispatchAiLogin> => {
    const read = deps.loginStateOf;
    if (!read) return 'unknown';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => read(providerId))
          .catch((): DispatchAiLogin => 'unknown'),
        new Promise<DispatchAiLogin>((resolve) => {
          timer = setTimeout(() => resolve('unknown'), waitMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  broker.handle('dispatch:options', async (_e, sessionId: unknown): Promise<DispatchOptions> => {
    // NEVER REFUSES, and that is deliberate: the list of templates does not
    // depend on the session, so a bad `sessionId` costs the caller its task
    // default and nothing else. Refusing would hide three built-ins behind a
    // typo in one field.
    const usable = typeof sessionId === 'string' && sessionId !== '';
    const task = usable ? deps.taskStatementOf(sessionId) : undefined;
    // WHERE A DISPATCH FROM HERE WOULD RUN (#949). Resolved HERE rather than
    // read off the renderer's card, because `prepare` resolves the same
    // reference the same way — one answer, from one call, so the folder the
    // dialog shows is the folder the spawn uses. An unresolvable session costs
    // the line and nothing else; see the "never refuses" note above.
    const resolved = usable ? deps.contextDeps.queries.resolve(sessionId) : undefined;
    const currentAi = resolved?.ok === true ? resolved.value.providerId : undefined;
    // "RUN IT ON" (#1296): every registered AI, and its login state. The
    // author's own AI is not asked about — it is running a session right now —
    // and the others are asked in parallel, each bounded by
    // `OPTIONS_LOGIN_WAIT_MS`: an answer already known, or `unknown`.
    //
    // ⚠️ ONLY FOR A SESSION THAT RESOLVES. The palette reads this channel at
    // app mount with `''`, for the template names alone; asking about logins
    // there would start a Codex check on every launch for a list nobody opened.
    const providers = providerList();
    const ais = await Promise.all(
      providers.map(async (p) => ({
        id: p.id,
        name: p.name,
        login:
          currentAi === undefined || p.id === currentAi
            ? ('unknown' as const)
            : await loginOf(p.id, OPTIONS_LOGIN_WAIT_MS),
      }))
    );
    return {
      templates: offered().map(asDto),
      ais,
      ...(currentAi === undefined ? {} : { currentAi }),
      ...(task === undefined || task.trim() === '' ? {} : { taskStatement: task }),
      ...(resolved?.ok === true ? { folder: resolved.value.folder } : {}),
    };
  });

  broker.handle('dispatch:prepare', async (_e, req: unknown): Promise<DispatchPrepared> => {
    // §5.29: validate the shape where it enters. A wire type that claims a union
    // is a promise only the check makes true (`sessions:create`'s rule).
    const r = req as Partial<{
      from: string;
      templateId: string;
      taskStatement: string;
      acceptanceCriteria: string;
      targetProviderId: string;
    }> | null;
    if (!r || typeof r !== 'object') return refuse('dispatch:prepare', 'a request object is required');
    if (typeof r.from !== 'string' || r.from === '') {
      return refuse('dispatch:prepare', 'from must be a non-empty session id');
    }
    if (typeof r.templateId !== 'string' || r.templateId === '') {
      return refuse('dispatch:prepare', 'templateId must be a non-empty string', { from: r.from });
    }
    for (const field of ['taskStatement', 'acceptanceCriteria'] as const) {
      const v = r[field];
      if (v !== undefined && typeof v !== 'string') {
        return refuse('dispatch:prepare', `${field} must be a string`, { from: r.from });
      }
    }
    if (r.targetProviderId !== undefined && !isProviderIdShape(r.targetProviderId)) {
      return refuse('dispatch:prepare', 'targetProviderId must be a provider id', { from: r.from });
    }

    // ⚠️ RESOLVED FROM THE ID, WITH `templateById` — #946's contract, and the one
    // line of this file that item asked for by name. A template OBJECT on this
    // channel could only be validated with `isSaneRoleTemplate`, which refuses
    // the `builtin:` namespace and would therefore refuse the three templates a
    // fresh install has.
    const template = templateById(r.templateId, deps.listTemplates());
    if (!template) {
      return refuse('dispatch:prepare', 'no such template', {
        from: r.from,
        templateId: r.templateId,
      });
    }

    // THE POLICY REFUSALS, BEFORE ANY WORK. Same answer the list greyed the row
    // out with, re-asked here rather than trusted: the list is a snapshot and the
    // setting it depends on can move while a dialog is open, which is exactly the
    // stale-`true` failure `DispatchGates.forkEnabled` warns about.
    const blocked = templateRefusalKey(template, { forkEnabled: deps.experimentalFork() });
    if (blocked) {
      log.info('dispatch refused by policy', {
        from: r.from,
        templateId: template.id,
        reasonKey: blocked,
      });
      return { ok: false, reason: `template policy is not available: ${blocked}`, reasonKey: blocked };
    }

    // ── WHICH AI IT RUNS ON ("Run it on", #1296) ──────────────────────────
    //
    // The user's pick, or the author's own AI when the request names none —
    // which is what every pre-#1296 caller sends, and what a dispatch did
    // before there was a choice to make (a dispatched card used to start on the
    // DEFAULT provider; for a Claude author that is the same answer).
    //
    // ⚠️ REFUSED, NEVER SWAPPED. The dialog's list is a snapshot, and an AI can
    // stop being registered (or be logged out) while it is open. Running the
    // role on some other AI instead would hand the user "a second opinion"
    // from the very AI they were trying to get away from, with nothing on
    // screen to say so.
    const author = deps.contextDeps.queries.resolve(r.from);
    if (!author.ok) return refuse('dispatch:prepare', author.reason, { from: r.from });
    const target = r.targetProviderId ?? author.value.providerId;
    const targetEntry = providerList().find((p) => p.id === target);
    if (!targetEntry) {
      log.warn('dispatch refused: the chosen AI is not set up', { from: r.from, target });
      return {
        ok: false,
        reason: `the AI "${target}" is not set up on this computer`,
        reasonKey: 'dispatch.refusal.aiMissing',
      };
    }
    // Only a DEFINITE logged-out refuses; `unknown` goes ahead (fail-open), and
    // the author's own AI is not asked — it is running a session right now.
    if (target !== author.value.providerId && (await loginOf(target)) === 'logged-out') {
      log.warn('dispatch refused: the chosen AI is not logged in', { from: r.from, target });
      return {
        ok: false,
        reason: `the AI "${target}" is not logged in`,
        reasonKey: 'dispatch.refusal.aiLoggedOut',
      };
    }

    const got = await buildDispatchContext(deps.contextDeps, {
      from: r.from,
      policy: template.contextPolicy,
      targetProviderId: target,
      // THE TASK OVERRIDE, and this is its only caller — which is why #947 did
      // not add the field. An untouched dialog sends nothing and the bundle reads
      // the transcript, byte for byte as it did before this item.
      ...(r.taskStatement === undefined ? {} : { taskStatement: r.taskStatement }),
      ...(r.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: r.acceptanceCriteria }),
    });
    if (!got.ok) {
      log.warn('dispatch context could not be built', {
        from: r.from,
        templateId: template.id,
        reason: got.reason,
      });
      return {
        ok: false,
        reason: got.reason,
        ...(got.reasonKey === undefined ? {} : { reasonKey: got.reasonKey }),
      };
    }

    // WHERE IT RUNS. `same-folder` is the only policy that got past the refusal
    // above, so the folder is the author's — read from the resolved session
    // rather than from the request, which never carried one.
    const resolved = deps.contextDeps.queries.resolve(r.from);
    if (!resolved.ok) {
      // Unreachable in practice: `buildDispatchContext` resolved the same
      // reference one line ago. Kept as a refusal rather than a `!` because a
      // session can be closed between two synchronous reads separated by an
      // await, and the alternative is a thrown TypeError on the spawn path.
      return refuse('dispatch:prepare', resolved.reason, { from: r.from });
    }

    const dispatchId = randomUUID();
    // BOUNDED BEFORE THE INSERT, so the map can never exceed the cap even for an
    // instant. Oldest first: insertion order is `Map`'s own iteration order, and
    // the newest entry is the one the user is about to spawn.
    while (pending.size >= MAX_PENDING_DISPATCHES) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
      log.warn('dropped the oldest prepared dispatch to stay under the cap', {
        cap: MAX_PENDING_DISPATCHES,
      });
    }
    pending.set(dispatchId, {
      context: got.value,
      template,
      from: resolved.value.id,
      folder: resolved.value.folder,
      providerId: target,
      // read at the check above, not again here: the name is the one the user
      // just picked from, and the card names it if that AI is gone by the spawn
      providerName: targetEntry.name,
      at: Date.now(),
    });
    log.info('dispatch prepared', {
      dispatchId,
      from: resolved.value.id,
      templateId: template.id,
      source: got.value.source,
      target,
    });
    // NOTHING TO HAND OVER IS SAID IN THE LOG, not on the wire — see the note at
    // the bottom of `dispatch-wire.ts` for why the dialog does not show a size.
    // It is still worth recording: "the reviewer had nothing to review" is the
    // first question to ask about a dispatch that came back with nothing, and
    // without this line the only evidence would be the reviewer's own puzzlement.
    if (got.value.source !== 'fork-adoption' && got.value.empty) {
      log.warn('dispatching with an empty briefing — no diff and no task', {
        from: resolved.value.id,
        templateId: template.id,
      });
    }
    return { ok: true, dispatchId, folder: resolved.value.folder, templateName: template.name };
  });

  /**
   * Expiry is decided on READ rather than swept on a timer: a timer would be a
   * second thing to tear down per wiring, and an entry nobody reads costs a map
   * slot that `MAX_PENDING_DISPATCHES` already bounds.
   *
   * An expired entry is DROPPED as it is read, from `peek` — so the slot is freed by
   * the read that noticed it, and the warning is logged once rather than again on
   * every later remount of the same card.
   */
  const live = (dispatchId: unknown): PendingDispatch | undefined => {
    if (typeof dispatchId !== 'string' || dispatchId === '') return undefined;
    const found = pending.get(dispatchId);
    if (!found) return undefined;
    if (Date.now() - found.at > DISPATCH_TTL_MS) {
      pending.delete(dispatchId);
      log.warn('a prepared dispatch expired before its card started', {
        dispatchId,
        templateId: found.template.id,
        ageMs: Date.now() - found.at,
      });
      return undefined;
    }
    return found;
  };

  return {
    peek: live,
    consume: (dispatchId: unknown): void => {
      if (typeof dispatchId !== 'string') return;
      if (pending.delete(dispatchId)) log.debug('prepared dispatch spent', { dispatchId });
    },
  };
}
