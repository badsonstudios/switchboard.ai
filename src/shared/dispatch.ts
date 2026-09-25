// Role templates — the saved dispatch target (P2-E13-01, §5.15).
//
// The first item of Dispatch v1, and the one every other item in the epic reads.
// This file is the MODEL and nothing else: no IPC, no spawning, no surface. The
// gesture is #948, the context builders are #947, the workspace policy's teeth
// are #949, the round-trip is #950.
//
// ── WHY THE MODEL IS ITS OWN ITEM ───────────────────────────────────────────
//
// §5.15's motivation is one sentence: *the missing context IS the feature.* A
// code review run in a FRESH session finds things an in-context review misses,
// because the in-context reviewer inherits the author's framing and reviews the
// intent, while a clean session has to rebuild its understanding from the
// artifact. So "how much context does this role get" is not a setting bolted
// onto a dispatch button — it is the product, and it has three values whose
// plumbing is genuinely different: clean-room assembles an artifact bundle,
// briefed calls #766's package generator, full needs #801's fork adoption.
// Settling the enum and its storage before anything spawns is what stops the
// dispatch gesture growing three code paths and a default nobody chose.
//
// ── WHERE IT LIVES ──────────────────────────────────────────────────────────
//
// `shared/`, not `main/`, because #948 renders these names in the command
// palette and on the session card, and `main/events/rules.ts` already shows the
// alternative: a vocabulary main owns, with the renderer validating against a
// copy. It does not import `main/` and it cannot (eslint, §5.23) — which is why
// `shared/accents.ts` exists as of this item.
//
// ── THE VALUES ARE THE DEFINITION ───────────────────────────────────────────
//
// Every union below is a `const` array with the type derived from it, following
// `AUTONOMY_MODES` (`shared/sessions.ts`) and `TASK_LABEL_SIZES`
// (`shared/task-label-size.ts`). A fourth policy added to a hand-written union
// would type-check while going unvalidated by the predicate that guards the
// workspace file, and the resulting template would be dropped on load by a
// build that declares it. The list is the thing; the type follows.
import { AutonomyMode, isAutonomyMode } from './sessions';
import { accentByName } from './accents';

/**
 * How much of the author's context the dispatched session receives (§5.15).
 *
 * THE FEATURE, not a knob on it — see the header. Closed on purpose: a fourth
 * amount is a fourth thing to build, and `CONTEXT_SOURCE` below fails `tsc`
 * until someone has said what it reads.
 *
 * - `clean-room` — the artifact only: diff, task statement, acceptance criteria.
 *   No reasoning history. The default for review, and the case §5.15 is about.
 * - `briefed` — the Level-2 handoff package (§5.5): goal, decisions, files
 *   touched. The default for docs and PR authoring.
 * - `full` — fork-session adoption (§5.5 L3). Rare, for continuation work, and
 *   **refused unless the experimental fork flag is on** (#947) — see
 *   `contextPolicyRefusalKey`, and note that it can still be refused after that
 *   for reasons this module cannot see.
 */
export const CONTEXT_POLICIES = ['clean-room', 'briefed', 'full'] as const;
export type ContextPolicy = (typeof CONTEXT_POLICIES)[number];

/**
 * Where a policy's context actually comes from.
 *
 * Named separately from the policy because the two are not the same question and
 * will not stay one-to-one for ever: a policy is what the USER picked, a source
 * is the machinery that satisfies it. Keeping them apart is what lets #947
 * implement two sources without touching the vocabulary the user sees.
 *
 * - `artifact-bundle` — assembled by #947 from the author's diff and task.
 * - `context-package` — #766's `main/sessions/context-package.ts`, which is
 *   mechanical, byte-stable and invokes no model.
 * - `fork-adoption` — #801's experimental Level-3 fork.
 */
export const CONTEXT_SOURCES = ['artifact-bundle', 'context-package', 'fork-adoption'] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

/**
 * THE ONE PLACE A CONTEXT POLICY BECOMES A CONTEXT SOURCE.
 *
 * This record is the done-when's second bullet, and the reason it is a record
 * rather than a `switch` in the dispatcher is the reason `LABEL_LINES` is one:
 * the moment two call sites map the same policy themselves, `briefed` is free to
 * mean the handoff package in one and "whatever the author last said" in the
 * other. #947 reads this. Nothing else decides.
 *
 * `Record<ContextPolicy, …>` makes it TOTAL — a fourth policy does not compile
 * until it has said where its context comes from.
 */
export const CONTEXT_SOURCE: Readonly<Record<ContextPolicy, ContextSource>> = {
  'clean-room': 'artifact-bundle',
  briefed: 'context-package',
  full: 'fork-adoption',
};

/**
 * Where the dispatched session runs (§5.15).
 *
 * All three names are declared even though v1 ships one, because the alternative
 * is changing this type in Phase 3 and re-deciding what a stored template with
 * the missing value means. `workspacePolicyRefusalKey` is how the other two stay
 * honest in the meantime.
 *
 * - `same-folder` — the author's own folder. What v1 ships.
 * - `fresh-worktree` — a worktree checkout of the author's branch, so a reviewer
 *   can run tests without touching the author's tree. §5.15's preference for
 *   review, and Phase 3 work (#949's scope call).
 * - `fresh-clone` — a clone of its own. Also Phase 3.
 */
export const WORKSPACE_POLICIES = ['same-folder', 'fresh-worktree', 'fresh-clone'] as const;
export type WorkspacePolicy = (typeof WORKSPACE_POLICIES)[number];

/** The only workspace policy Dispatch v1 can actually carry out. */
export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = 'same-folder';

/**
 * A saved dispatch target: who to hand work to, and how much to tell them.
 *
 * §5.15 lists five parts and this is those five parts — a startup/role prompt,
 * an autonomy profile, its own identity, a workspace policy, and a context
 * policy. Two things §5.15 mentions are deliberately NOT fields here:
 *
 * - **Ephemerality.** "Dispatched sessions are ephemeral by default, with
 *   linger/pin options like watchers" is §5.15's lifecycle paragraph and it is
 *   #951's item. A field declared here now would be a field #951 has to either
 *   honour or migrate away from, decided by someone who had not yet built the
 *   rail nesting it belongs to.
 * - **An icon.** §5.15 says "icon/colour" and this app has no icon vocabulary
 *   for a session; the one badge slot a card has is §5.11's project-type badge
 *   (`TS`, `Rs`), and overwriting it with a role glyph would make one badge mean
 *   two things — the drift `SessionCardWire`'s header spends a paragraph on.
 *   Colour is what the rail actually paints, so colour is what a template
 *   carries. #948 has the surface, and gets to decide whether a role needs a
 *   glyph of its own.
 */
export interface RoleTemplate {
  /**
   * Stable id. **A user template may not take an id in the `builtin:`
   * namespace** — see `isBuiltInTemplateId`, which is what makes "the built-in
   * is not mutated" a property of the store rather than a promise made by a UI
   * that has not been written yet.
   */
  id: string;
  /** What the user calls it. Shown in the palette and on the dispatch menu. */
  name: string;
  /**
   * The role prompt, sent as the dispatched session's opening instruction.
   *
   * May be EMPTY, and that is not an oversight: #948's editor needs a
   * half-written template to be storable, exactly as `isSaneRule` lets a rule
   * with no actions round-trip. An empty prompt dispatches a session with the
   * context and no instruction, which is legible rather than broken.
   */
  rolePrompt: string;
  /**
   * The autonomy the dispatched session runs at.
   *
   * **The app's own `AutonomyMode`, not a second vocabulary** — the done-when's
   * fourth bullet. It is the same type the chip sets, the same type
   * `PersistedSession.autonomy` stores, and the same type
   * `AUTONOMY_PERMISSION_MODE` maps to the CLI's `--permission-mode`. A
   * dispatch-only spelling of "how much can it do on its own" would be a second
   * place to add a fifth mode to, and the first place to forget.
   */
  autonomy: AutonomyMode;
  contextPolicy: ContextPolicy;
  workspacePolicy: WorkspacePolicy;
  /**
   * The session's identity colour — §5.11's palette, resolved to a hex here so
   * that the rail can paint it with no lookup. Optional: absent means the
   * dispatched session gets whatever `assignAccent` would have given any new
   * session, which is the right answer for a user template nobody coloured.
   */
  accentColor?: string;
}

/**
 * The namespace prefix every built-in id carries.
 *
 * A PREFIX rather than a list of three known ids, because the check that matters
 * is forward-looking: a build that ships a fourth built-in must not find a user
 * template already squatting on its id. Refusing the whole namespace makes that
 * impossible instead of unlikely.
 */
export const BUILT_IN_ID_PREFIX = 'builtin:';

/** Is this id one the app reserves for a code-defined template? */
export function isBuiltInTemplateId(id: string): boolean {
  return id.startsWith(BUILT_IN_ID_PREFIX);
}

/**
 * A sanity bound on a stored prompt, not a product limit.
 *
 * Twenty thousand characters is far past any role prompt a person writes and far
 * short of a size that makes `workspace.json` a problem; a template over it is a
 * corrupt or hand-mangled file, not somebody's reviewer. The workspace store
 * drops what it cannot load and says so (#344), so this is a bound with a
 * warning attached rather than a silent truncation.
 */
export const ROLE_PROMPT_CHAR_CAP = 20_000;

/** Same reasoning, for the name — a line, not a document. */
export const TEMPLATE_NAME_CHAR_CAP = 200;

/**
 * And for the id, which is the one field a UI never shows.
 *
 * Capped for exactly that reason: an uncapped id is an uncapped row in
 * `workspace.json` that nothing on screen would ever reveal as the thing that
 * grew the file.
 */
export const TEMPLATE_ID_CHAR_CAP = 200;

/**
 * The three built-in templates (§5.15), as CODE.
 *
 * **They are never written to the workspace file**, which is the done-when's
 * first bullet and the same rule `defaultRules` follows in `events/rules.ts`:
 * the built-ins are synthesized from the build, so improving one improves it for
 * everybody on upgrade instead of only for installs created afterwards. A user
 * who edits one gets a COPY (`copyOfBuiltIn`); the built-in itself has no
 * mutation path, because there is nowhere to put the mutation.
 *
 * User-defined templates are first-class — same shape, same storage, no "custom"
 * second class. The only asymmetry is the id namespace above, and that exists to
 * protect the user's templates from a future built-in, not the other way round.
 *
 * **The autonomy defaults are deliberately the quiet end of the range**, and
 * that is a judgment call worth naming: a dispatched session is by definition one
 * nobody is watching, so a default that lets it act freely would be autonomy
 * granted by the person who wrote this file rather than by the user. The reviewer
 * gets `plan`, whose write block is the CLI's own and which §5.16's plan-mode
 * rule says nothing in-app can Allow past — the strongest "do not touch my tree"
 * available. The two that must write files get `ask`. Anyone who wants more makes
 * a copy.
 *
 * ⚠️ **ONE THING #948 MUST MEASURE RATHER THAN ASSUME**: whether a plan-mode
 * session can finish unattended at all. `plan` maps to the CLI's
 * `--permission-mode plan` (`main/providers/claude.ts`), and exiting plan mode is
 * an approval the CLI keeps for itself — §5.16's plan-mode rule is explicit that
 * nothing in-app may answer it. If a reviewer therefore parks waiting for a human
 * who by definition is not watching, this default is wrong and the fix is `ask`
 * plus a deny-writes story. That is cheaper to learn before #950 builds the
 * round-trip on it, and the standing rule says measure the CLI, do not guess it.
 *
 * The names and prompts are English literals here for the same reason
 * `PLACEHOLDER_GROUP_NAME` is: they are DATA that happens to be words, an
 * identity a user can replace by copying, not rendered UI chrome.
 */
const BUILT_INS: readonly RoleTemplate[] = [
  {
    id: `${BUILT_IN_ID_PREFIX}code-reviewer`,
    name: 'Code Reviewer',
    rolePrompt: [
      'You are reviewing a change you did not write.',
      '',
      'You have the diff, the task it was meant to accomplish, and its acceptance',
      'criteria — and deliberately nothing else: no reasoning history, no design',
      'discussion. Rebuild your understanding from the artifact alone. Where the',
      'change only makes sense if you assume something the diff does not say, that',
      'assumption is itself a finding.',
      '',
      'Report correctness problems first, then what will be expensive to live with.',
      'Do not edit files.',
    ].join('\n'),
    autonomy: 'plan',
    contextPolicy: 'clean-room',
    workspacePolicy: 'same-folder',
    accentColor: accentByName('coral'),
  },
  {
    id: `${BUILT_IN_ID_PREFIX}doc-writer`,
    name: 'Doc Writer',
    rolePrompt: [
      'You are documenting work another session has just finished.',
      '',
      'You have been briefed: the goal, the decisions taken, and the files touched.',
      'Write for someone who has never read the design docs — plain English, second',
      'person, naming the real buttons and keys. Where the briefing is genuinely',
      'ambiguous, say so rather than inventing the answer.',
    ].join('\n'),
    autonomy: 'ask',
    contextPolicy: 'briefed',
    workspacePolicy: 'same-folder',
    accentColor: accentByName('teal'),
  },
  {
    id: `${BUILT_IN_ID_PREFIX}pr-author`,
    name: 'PR Author',
    rolePrompt: [
      'You are writing the pull request for work another session has just finished.',
      '',
      'You have been briefed: the goal, the decisions taken, and the files touched.',
      'Lead with what changed and why, in plain English, then the detail. Say what',
      'the change deliberately does not do. Describe nothing that is not in the diff.',
    ].join('\n'),
    autonomy: 'ask',
    contextPolicy: 'briefed',
    workspacePolicy: 'same-folder',
    accentColor: accentByName('violet'),
  },
];

/**
 * The built-ins, FROZEN — see `BUILT_INS` above for what they are and why.
 *
 * ⚠️ `readonly RoleTemplate[]` alone would have been a promise the type system
 * does not keep: it freezes the array's slots, not the objects in them, and
 * `allTemplates`/`templateById` hand the constants out BY REFERENCE. One
 * `templateById(id, user)!.autonomy = 'full-auto'` in a later item would change
 * the built-in for the rest of the process — and the workspace store deep-copies
 * everything it hands out precisely so that cannot happen to stored data. So the
 * freeze is real: under ESM's strict mode that assignment throws instead of
 * silently succeeding, which is the loud failure this deserves.
 *
 * Shallow is enough today because every field is a scalar; `copyOfBuiltIn` uses
 * `structuredClone` so that stays true when one is not.
 */
export const BUILT_IN_TEMPLATES: readonly RoleTemplate[] = Object.freeze(
  BUILT_INS.map((t) => Object.freeze(t))
);

/**
 * Is this a template this build can store and load back?
 *
 * The `isSaneRule` analogue, and it guards the same two doors: untrusted input
 * arriving from the renderer, and a `workspace.json` written by another build or
 * edited by hand. A template that fails here is dropped on load with a warn
 * naming what it cost (#344) and refused on upsert.
 *
 * **It refuses a `builtin:` id**, which is the structural half of "the built-in
 * is not mutated": there is no sequence of store calls that puts a user template
 * where a built-in's id would resolve, so `templateById` can answer from code
 * first and never be shadowed.
 *
 * It does NOT refuse an unsupported policy. `fresh-worktree` is a real member of
 * a closed union and a template carrying it is storable and loadable; what it is
 * not is *dispatchable*, and that refusal belongs at the moment of dispatch where
 * there is somewhere to show the reason. See `templateRefusalKey`.
 *
 * ⚠️ **A BUILT-IN FAILS THIS PREDICATE, SO DO NOT REACH FOR IT TO VALIDATE AN
 * ARBITRARY TEMPLATE.** It answers one question — "may this go in the workspace
 * file?" — and a built-in's answer is no. **The contract for #948 is therefore
 * that dispatch passes a template ID over IPC and main resolves it with
 * `templateById`**, never a template object; an object arriving on a channel
 * could only be validated with this, which would refuse the three templates a
 * new install has.
 */
export function isSaneRoleTemplate(t: unknown): t is RoleTemplate {
  const x = t as Partial<RoleTemplate> | null;
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  if (typeof x.id !== 'string' || !x.id) return false;
  if (x.id.length > TEMPLATE_ID_CHAR_CAP) return false;
  if (isBuiltInTemplateId(x.id)) return false;
  if (typeof x.name !== 'string' || !x.name.trim()) return false;
  if (x.name.length > TEMPLATE_NAME_CHAR_CAP) return false;
  // Empty is legal, absent is not — an editor's half-written template still has
  // the field. See the field's note.
  if (typeof x.rolePrompt !== 'string') return false;
  if (x.rolePrompt.length > ROLE_PROMPT_CHAR_CAP) return false;
  if (!isAutonomyMode(x.autonomy)) return false;
  if (!isContextPolicy(x.contextPolicy)) return false;
  if (!isWorkspacePolicy(x.workspacePolicy)) return false;
  // A colour, not an arbitrary string. This value is painted — it reaches the
  // rail and the card header the same way `identity.accentColor` does — and it
  // will arrive over IPC from a template editor in #948, so the vocabulary is
  // checked here rather than trusted there (§5.29). Six-digit hex, which is what
  // `ACCENTS` holds and what `tokens.css` declares.
  if (x.accentColor !== undefined && !isAccentHex(x.accentColor)) return false;
  return true;
}

/** A six-digit `#rrggbb`, the only accent spelling this app stores. */
function isAccentHex(v: unknown): boolean {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

/** Is this stored/IPC value a context amount we still recognise? */
export function isContextPolicy(v: unknown): v is ContextPolicy {
  return typeof v === 'string' && (CONTEXT_POLICIES as readonly string[]).includes(v);
}

/** Is this stored/IPC value a workspace policy we still recognise? */
export function isWorkspacePolicy(v: unknown): v is WorkspacePolicy {
  return typeof v === 'string' && (WORKSPACE_POLICIES as readonly string[]).includes(v);
}

// ── REFUSALS ────────────────────────────────────────────────────────────────
//
// These return CATALOGUE KEYS, not sentences. §5.21's first rule is "no
// hardcoded user-visible strings — ever", and the English lives in
// `shared/i18n/locales/en.json` under `dispatch.refusal.*`. The shape follows
// `main/events/notification-text.ts` (`NOTIFICATION_KIND_KEYS`), which is the
// precedent for "main-side code decides WHICH sentence, the renderer's `t`
// renders it".
//
// The first draft of this file put the sentences here, which `copyOfBuiltIn`
// (below) refuses to do two hundred lines later on exactly these grounds.

/**
 * The catalogue key for why this workspace policy cannot be carried out, or
 * `undefined` if it can.
 *
 * **Declared and refused, never silently degraded** — #949's scope call, and the
 * sharpest reason in the epic: telling a reviewer it has an isolated checkout
 * while it runs tests in the author's live tree is precisely the surprise §5.7's
 * isolation caveat exists to prevent. A `fresh-worktree` template that quietly
 * became `same-folder` would be a lie the user could not see, and the first way
 * they would find out is a test run mutating the tree they were working in.
 *
 * Worktree create-and-merge-back is Phase 3. Half-building it here would grow a
 * second worktree code path for that epic to reconcile against.
 */
export function workspacePolicyRefusalKey(p: WorkspacePolicy): string | undefined {
  return WORKSPACE_POLICY_REFUSAL_KEYS[p];
}

// Not exported: the FUNCTION is the API. A table exported with no reader is the
// speculative surface this file already refused once (see the icon note above).
const WORKSPACE_POLICY_REFUSAL_KEYS: Readonly<Partial<Record<WorkspacePolicy, string>>> = {
  'fresh-worktree': 'dispatch.refusal.freshWorktree',
  'fresh-clone': 'dispatch.refusal.freshClone',
};

/**
 * Facts a refusal depends on that a SHARED module cannot know for itself.
 *
 * Deliberately tiny, and it will stay tiny: this is not a place to accumulate
 * dispatch state. A gate belongs here only when the answer is "the user can turn
 * this on", because that is the case a menu needs to know about BEFORE anyone
 * clicks — every other refusal wants a provider, a record or a folder, and those
 * are settled at the moment of dispatch by `main/sessions/dispatch-context.ts`,
 * which is the only thing that has them.
 */
export interface DispatchGates {
  /**
   * §5.5 Level 3 fork adoption is switched on (Settings → Advanced).
   *
   * OFF WHEN OMITTED, which is what keeps this change safe: a caller written
   * before the gate existed still gets the refusal it was written against, and a
   * caller that forgets to pass the flag fails toward "not available" rather
   * than toward a fork nobody enabled.
   *
   * ⚠️ **READ IT AT RENDER TIME, FROM THE SAME ACCESSOR MAIN READS.** This value
   * and `DispatchContextDeps.experimentalFork` are two independent readings of
   * one setting (`workspace.getExperimentalFork`), and the failure mode is not
   * the omitted direction — it is a menu that passes a CACHED `true` and offers
   * a row that refuses the moment it is clicked. Fail-closed on absence is free;
   * a stale `true` is not.
   */
  forkEnabled?: boolean;
}

/**
 * The catalogue key for why this context amount cannot be supplied, or
 * `undefined` if it can.
 *
 * The issue for #946 only asked for the workspace half to be declared-and-
 * refused. This half gets the same treatment because it is the identical trap
 * one union over: a `full` template that fell back to `briefed` would hand a
 * continuation session a summary and let it believe it had the conversation.
 * §5.5's own honesty rule — "a briefed continuation, never a resumption" — is the
 * same sentence from the other end.
 *
 * ⚠️ **`full` IS CONDITIONAL AS OF #947, AND THAT REVERSES ONE LINE #946 WROTE.**
 * #946 refused it outright on the grounds that Dispatch v1 would not build it.
 * #947's done-when says the opposite — *"Full is reachable only with the
 * experimental flag on"* — and it is right: #801 shipped the fork, the flag is a
 * real setting, and this section's own as-built note in DESIGN §5.15 said "one
 * table entry is the only line that changes when a later item wires it". This is
 * that line. **What has NOT changed is the default**: with no gates passed, or
 * with the flag off, `full` is refused exactly as before.
 *
 * ⚠️ IT IS NOT THE ONLY REFUSAL `full` CAN HIT. A fork is also refused across
 * providers (§5.5: transcript formats are not interchangeable) and for a session
 * that has no conversation yet — both need facts this module does not have, so
 * `undefined` here means "no reason to grey the row out", not "this will work".
 */
export function contextPolicyRefusalKey(
  p: ContextPolicy,
  gates?: DispatchGates
): string | undefined {
  const key = CONTEXT_POLICY_REFUSAL_KEYS[p];
  if (key === undefined) return undefined;
  // The one entry in that table a SETTING can lift. Written as a check against
  // the member rather than as a second table, because a gate table with one row
  // is machinery standing in for a sentence — and the moment there are two, the
  // table earns itself and this becomes it.
  if (p === 'full' && gates?.forkEnabled === true) return undefined;
  return key;
}

const CONTEXT_POLICY_REFUSAL_KEYS: Readonly<Partial<Record<ContextPolicy, string>>> = {
  full: 'dispatch.refusal.fullContext',
};

/**
 * The catalogue key for why this template cannot be dispatched, or `undefined`
 * if it can.
 *
 * The one call #948 makes before spawning, and the one a UI calls to explain
 * itself. Both policies, and the CONTEXT one wins when a template manages both:
 * a menu row has space for one sentence, and the context amount is the half the
 * user actually chose the template for. The second reason surfaces once the first
 * is fixed.
 *
 * `gates` is forwarded, not interpreted — see `contextPolicyRefusalKey`, and
 * note that `undefined` from this function means "nothing to say up front",
 * never "this dispatch will succeed".
 */
export function templateRefusalKey(t: RoleTemplate, gates?: DispatchGates): string | undefined {
  return (
    contextPolicyRefusalKey(t.contextPolicy, gates) ??
    workspacePolicyRefusalKey(t.workspacePolicy)
  );
}

/**
 * Every template on offer: the built-ins, then the user's.
 *
 * Built-ins FIRST because that is the order the palette should offer them in —
 * the three §5.15 names are what a new install has, and a user with twelve
 * templates of their own still reaches for Code Reviewer most. Not sorted by
 * name: a stable order the user can learn beats an alphabetical one that moves
 * when they rename something.
 */
export function allTemplates(user: readonly RoleTemplate[]): RoleTemplate[] {
  return [...BUILT_IN_TEMPLATES, ...user];
}

/**
 * The template with this id, built-in or the user's.
 *
 * Built-ins are checked first and cannot be shadowed, because
 * `isSaneRoleTemplate` refuses a `builtin:` id — so this is not a precedence
 * rule anyone has to remember, it is the only reachable answer.
 */
export function templateById(
  id: string,
  user: readonly RoleTemplate[]
): RoleTemplate | undefined {
  return BUILT_IN_TEMPLATES.find((t) => t.id === id) ?? user.find((t) => t.id === id);
}

/**
 * A user template derived from a built-in — what "editing" a built-in does.
 *
 * The done-when's first bullet in one function: the built-in is a constant, so
 * there is nothing to mutate; what the user gets is a storable copy with an id
 * of their own. Returns `undefined` for an id that is not a built-in, so a caller
 * cannot accidentally deep-copy a user template into a second user template and
 * call it a fork.
 *
 * **The caller supplies the name.** A `(copy)` suffix minted here would be an
 * untranslated English string in `shared/`, which is where the renderer reads
 * from and where §5.21 says user-visible text does not belong. The renderer has
 * the i18n catalogue; it can say "Code Reviewer (copy)" in the user's language.
 */
export function copyOfBuiltIn(
  builtInId: string,
  into: { id: string; name: string }
): RoleTemplate | undefined {
  const src = BUILT_IN_TEMPLATES.find((t) => t.id === builtInId);
  if (!src) return undefined;
  // Clone, then overwrite: a field added to `RoleTemplate` later comes along
  // without anyone remembering to add it here, which is the failure mode a
  // hand-listed copy has every time. `structuredClone` rather than a spread
  // because the source is FROZEN and every field is a scalar only until it is
  // not — a spread would quietly share a nested object with the constant, and
  // the test below (which mutates top-level fields) would still pass.
  return { ...structuredClone(src), id: into.id, name: into.name };
}
