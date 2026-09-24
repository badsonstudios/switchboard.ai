// Turns the HARNESS injected, not the human (#704).
//
// The CLI re-invokes the model by writing a turn into the conversation as if a
// user had typed it. A background task that emits an event or ends produces one
// of these:
//
//     <task-notification>
//     <task-id>bvhh1kfa7</task-id>
//     <summary>Monitor event: "CI matrix result for PR #36"</summary>
//     <event>ubuntu-latest: pass</event>
//     If this event is something the user would act on now, send a
//     PushNotification. Routine or benign output doesn't need one.
//     </task-notification>
//
// Nobody typed that. The Feed classified blocks by ROLE, so it got the full
// user-prompt treatment — a NEW PROMPT divider, the prompt pill, and the raw XML
// shown as though it were a sentence someone wrote.
//
// THIS IS THE THIRD INJECTED SHAPE, and the reason it is a module rather than a
// fourth `if` in `deriveIntents`. `isMeta` lines and `<local-command-*>`
// wrappers are the first two, and both are handled where they were met. The CLI
// grows these, so "what is an injected turn" is asked once, here, and the next
// one is a value in `INJECTED_ORIGINS` rather than a third ad-hoc check spread
// across three files.
//
// ── WHAT IS MEASURED, because the standing rule is never to guess a CLI
// contract ────────────────────────────────────────────────────────────────────
//
// The issue proposed detecting these by text shape. The repo's real transcript
// fixture carries a better signal, and it is the CLI's OWN classification: the
// line has a top-level `origin: { kind: 'task-notification' }`.
//
//  * `fixtures/session-transcript.jsonl`: **9 lines carry that origin, all 9 are
//    `type: 'user'`, all 9 also start with the tag — and NO user line starts
//    with the tag without it.** The other 27 origins in the file are
//    `{ kind: 'human' }`.
//  * We already SEND `origin: { kind: 'human' }` on our own turns
//    (`sessions/submit-prompt.ts`), as a top-level sibling of `message` — which
//    is the same place the transcript puts it, and `StreamFeed.onMessage`
//    spreads the whole envelope into `deriveIntents`. So this field is readable
//    on BOTH transports with no new plumbing.
//
// ORIGIN IS CONSULTED FIRST; the text shape decides everything it does not
// settle. That ordering is what makes the issue's own worry cheap: a prompt the
// CLI tagged `human` stays a prompt even if it *starts* with the tag, not merely
// if it mentions it mid-sentence.
//
// ⚠️ **AND REVIEW NARROWED IT, against the binary rather than the fixture.** The
// first cut treated every `origin.kind === 'task-notification'` as a background
// task. The CLI's own zod schema (PATH binary, read 2026-09-24) says that arm is
// wider than that — it carries an optional `subkind`:
//
//     d({kind:A("task-notification"),
//        subkind:V(["scheduled-trigger","peer-send-message","projects-relay"])
//          .optional().describe("Present when the delivery is the fired stored
//          prompt of a scheduled task/routine … or a coordinator co-member
//          SendMessage delivery ('peer-send-message': model-authored text fr…")
//
// A scheduled routine's fired prompt is the session's actual instruction, and a
// `peer-send-message` is another of the user's own sessions talking — which is
// §5.4's subject matter, not a background task. Either one rendered as a
// collapsed "Background task" row would be a confident mislabel, and the fixture
// could never have caught it: all 9 of its lines carry no `subkind` at all.
// That is exactly why the schema is the thing to read.
//
// So a `task-notification` origin is taken at face value ONLY when it carries no
// `subkind`. One that does falls through to the text test, which lets the ones
// still wearing the `<task-notification>` wrapper through and leaves the rest as
// prompts — today's behaviour, and the safe direction.

/** What an injected turn turned out to be — the block's `notice.source`. */
export type InjectedSource = 'task-notification';

/**
 * Origins that mean "the harness wrote this turn", and what each one is called.
 *
 * ONE ENTRY TODAY, and this map is the seam: `classifyInjected` returns the
 * value, `deriveIntents` stamps it on the block, and the renderer dispatches on
 * it — so adding a wrapper really is an edit here and nowhere else. (It was a
 * bare `Set` first, with the source hardcoded downstream. Review pointed out
 * that a second member would then have been stamped `task-notification`, which
 * is a seam in the comments only.)
 *
 * The CLI stamps plenty of other origins — `coordinator`, `observer`,
 * `auto-continuation`, `channel`, `peer`, `unclassified` — and several of them
 * are plainly not the person either. They are deliberately absent because no
 * transcript on this machine shows what their BODIES look like, and a row that
 * promised to summarise a payload whose shape was guessed would be this
 * module's own bug, one wrapper along. They join when there is a line to
 * measure; until then they fall through to the text test, which is the safe
 * direction.
 */
const INJECTED_ORIGINS: Readonly<Record<string, InjectedSource>> = {
  'task-notification': 'task-notification',
};

/**
 * Origins that mean a PERSON typed it — the only veto, and deliberately short.
 *
 * ⚠️ THIS LIST INVERTED IN REVIEW, and the reason is worth keeping. It was a
 * `KNOWN_ORIGINS` list of every origin found by grepping constructed literals
 * out of the binary, with "known but not injected" read as "this is the human".
 * Two things were wrong with that. The literal grep was not the schema, so the
 * list was both incomplete and padded with arms of OTHER unions; and it read
 * `unclassified` as a person, which the schema says in as many words it is not:
 *
 *     "Injected turn whose ingress classification found no provenance. Framed
 *      by the harness as a non-user source in both drains; never presumed
 *      human, never host-replayed."
 *
 * A veto is a strong claim, so it is made only where the CLI makes it: `human`
 * is the one arm the schema says a host "must stamp explicitly" for keyboard
 * input, and it is the one we stamp ourselves. Everything else — known,
 * unknown, or unclassified — falls through to the text test, where a turn that
 * does not look like a notification stays a prompt anyway.
 */
const HUMAN_ORIGINS = new Set<string>(['human']);

/** The wrapper tag a task notification is written in. */
const TASK_TAG = 'task-notification';

/**
 * The reminder wrapper the CLI says these normally arrive inside.
 *
 * Verbatim from the PATH binary's own guidance to the model (2026-09-24):
 * "Worker results arrive as **user-role messages** containing
 * `<task-notification>` XML, delivered as harness input, normally inside a
 * `<system-reminder>` …". Our fixture holds zero wrapped instances, so this is
 * robustness rather than a live defect — and it is only the TEXT fallback that
 * needs it, because a wrapped payload still carries its origin.
 *
 * KNOWN LIMIT, stated rather than papered over: this skips the opening tag
 * only. The same sentence says the reminder "opens with" a preamble string, and
 * a payload behind one of those will not match this anchor — it renders as a
 * prompt, which is today's behaviour and the safe direction. Widening the
 * anchor to "contains the tag somewhere" would swallow the bug report that
 * QUOTES one, which is the case the issue asked to protect.
 */
const REMINDER_OPEN = '<system-reminder>';

/** What one injected turn turned out to be. */
export interface InjectedTurn {
  /** which wrapper this is — the `notice.source` the renderer dispatches on */
  source: InjectedSource;
  /** the one line a collapsed row shows */
  summary: string;
  /** `completed` / `failed`, or the word for "this was an event" */
  status?: string;
  /** the CLI's task id, when the payload named one */
  taskId?: string;
  /** where the task's full output was written, when the payload named one */
  outputFile?: string;
}

/** The origin a line declares, when it declares a readable one. */
function origin(entry: Record<string, unknown>): { kind?: string; subkind?: string } | null {
  const raw = entry.origin;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { kind, subkind } = raw as { kind?: unknown; subkind?: unknown };
  return {
    ...(typeof kind === 'string' && kind !== '' ? { kind } : {}),
    ...(typeof subkind === 'string' && subkind !== '' ? { subkind } : {}),
  };
}

/** Does this text LOOK like an injected payload, wrapper allowed? */
function looksInjected(text: string): boolean {
  const trimmed = text.trimStart();
  const body = trimmed.startsWith(REMINDER_OPEN)
    ? trimmed.slice(REMINDER_OPEN.length).trimStart()
    : trimmed;
  // Anchored at the START on purpose: the tag mentioned mid-sentence is someone
  // TALKING about a notification.
  return body.startsWith(`<${TASK_TAG}>`);
}

/**
 * Is this user turn the harness talking, rather than the person — and if so,
 * which wrapper is it?
 *
 * THREE ANSWERS FROM TWO SIGNALS, and the middle one is the whole reason this
 * is not a one-line `startsWith`:
 *
 *  - origin names an injected kind, unqualified → that kind, whatever the text
 *    says.
 *  - origin says `human` → NOT injected, whatever the text says. This is the
 *    case the issue asked to protect and this protects more of it: a person who
 *    opens a message with the literal tag — quoting a bug report, which is
 *    precisely how #704 itself was filed — keeps their prompt.
 *  - anything else, including a `subkind` we have not measured → the text
 *    decides.
 */
export function classifyInjected(
  entry: Record<string, unknown>,
  text: string
): InjectedSource | null {
  const o = origin(entry);
  if (o?.kind !== undefined) {
    if (HUMAN_ORIGINS.has(o.kind)) return null;
    // A `subkind` means this arm is carrying something other than the generic
    // background-notification frame — see the header. Unqualified only.
    const injected = o.subkind === undefined ? INJECTED_ORIGINS[o.kind] : undefined;
    if (injected !== undefined) return injected;
  }
  return looksInjected(text) ? 'task-notification' : null;
}

/**
 * Read a `<tag>` out of the payload — the first one, non-greedy, across lines.
 *
 * A hand-rolled reader rather than an XML parse, and that is a fail-open
 * decision rather than laziness: this payload is untrusted output from another
 * process, it is not required to be well-formed XML (the instruction sentence
 * sits OUTSIDE any child tag), and a parser that threw on it would take a Feed
 * down over a CLI release note. A miss here costs one field, not the block.
 */
function tag(payload: string, name: string): string | undefined {
  // `String.match` rather than `RegExp.exec`, and not a style preference:
  // `context-package.test.ts` scans every module on the context package's
  // default path for `exec(` — the rule that says nothing down here can run a
  // program. A regex `.exec()` is a false positive for it, and a true rule
  // worth keeping strict is worth spelling around rather than loosening.
  const m = payload.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  const value = m?.[1]?.trim();
  return value ? value : undefined;
}

/** Tags that are the envelope rather than the message. */
const ENVELOPE = new Set([
  `<${TASK_TAG}>`,
  `</${TASK_TAG}>`,
  REMINDER_OPEN,
  '</system-reminder>',
]);

/**
 * The first line worth showing when the payload named no `<summary>`.
 *
 * The wrapper's own tags are skipped — "<task-notification>" as the row's one
 * line would be the raw XML the item exists to stop showing.
 */
function firstUsefulLine(payload: string): string | undefined {
  for (const line of payload.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || ENVELOPE.has(trimmed)) continue;
    return trimmed;
  }
  return undefined;
}

/**
 * What to show for an injected turn — never null, because the caller has
 * already decided this turn IS one.
 *
 * ⚠️ **CLASSIFICATION AND PARSING FAIL SEPARATELY, and that is a deliberate
 * divergence from the issue.** The issue says a payload that does not parse
 * should "fall back to today's behaviour (show the text)". Today's behaviour is
 * the bug — NEW PROMPT plus raw XML — so falling back to it on a malformed
 * payload would reintroduce the defect for exactly the lines least able to
 * explain themselves. Instead: if we are not confident the turn is injected it
 * stays a user prompt (the safe direction, `classifyInjected` above); once we
 * are, an unreadable body costs the SUMMARY, not the block. The raw payload is
 * carried on the block whatever happens, so no content is ever dropped — which
 * is the promise the issue's fail-open clause was actually making.
 *
 * `status` prefers the literal `<status>` the CLI wrote (`completed` /
 * `failed`). An `<event>` payload has no such word — its `<event>` body is
 * several lines of CI results — so the caller is handed `'event'` and the
 * renderer says it in the user's language. Putting the body in the chip would
 * be a paragraph in a badge.
 */
export function describeInjectedTurn(
  source: InjectedSource,
  payload: string,
  cap: number
): InjectedTurn {
  // `IDENTITY_ONLY_CAPS` promises "no text built at all", and the search engine
  // derives EVERY line of a transcript to keep its ordinals in step with the
  // Feed's `seq`. Five full-payload regex scans per notification is exactly the
  // work those caps exist to skip, and every field below would be sliced to ''.
  if (cap <= 0) return { source, summary: '' };
  const summary = tag(payload, 'summary') ?? firstUsefulLine(payload) ?? '';
  const status = tag(payload, 'status') ?? (tag(payload, 'event') === undefined ? undefined : 'event');
  const taskId = tag(payload, 'task-id');
  const outputFile = tag(payload, 'output-file');
  // Absent, never `undefined`-valued — the house rule `originOf` states in
  // `blocks.ts`: a block with nothing to say says nothing, and `{ x: undefined }`
  // is not the same object as `{}` to the pinned shapes in the suite.
  return {
    source,
    summary: summary.slice(0, cap),
    ...(status === undefined ? {} : { status: status.slice(0, cap) }),
    ...(taskId === undefined ? {} : { taskId: taskId.slice(0, cap) }),
    ...(outputFile === undefined ? {} : { outputFile: outputFile.slice(0, cap) }),
  };
}
