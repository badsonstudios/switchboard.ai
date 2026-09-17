// The vocabulary of a context drop (P2-E11-10, §5.5) — shared because both ends
// speak it and neither may be the only one that knows the words.
//
// MAIN BUILDS THE OFFER, and it is the only side that can: `renderPackage` sits
// beside the transcript readers in `src/main`, and the renderer cannot import
// from there. That is not a style rule — #846 recorded it after a helper placed
// on the wrong side of the line forced the Feed to keep a private copy of a
// regex. So the split is: main renders every string, the renderer chooses
// between them and holds the winner in the target card's composer.
//
// ── NOTHING HERE MEANS "SEND IT" ────────────────────────────────────────────
//
// `sibling-message.ts` makes the same promise in the same way, for §5.4's rule,
// and this file inherits it by shape: an offer is a list of things to SHOW and a
// string to PARK in a composer. There is no field a caller could set to submit
// one, so the renderer cannot be told to. The only code in the app that can
// start a turn from held text is the composer's own Enter, and a dropped context
// block reaches it exactly as a sibling's message does — by waiting.

/**
 * The transfer type a context chip drags under.
 *
 * A custom type rather than `text/plain`, for the reason `SessionsRail`'s
 * `application/x-switchboard-card` is one: the composer already accepts dropped
 * FILES and would otherwise have to guess, from a string, whether it had been
 * handed a session reference or something a user dragged out of a text editor.
 * A type nothing else in the world advertises is not a guess.
 */
export const CONTEXT_DND_TYPE = 'application/x-switchboard-context';

/**
 * The three fidelities §5.5's drop dialog offers, in the order it names them:
 * *"last response | summary handoff | full excerpt"*.
 *
 * Each one maps onto something the Level-2 package (#766) ALREADY computes, and
 * that is the whole reason the list is these three rather than three others:
 *
 *  - `state`   — the package's "Where it left off" section. §5.5's *last
 *                response*, and genuinely the last thing the session said.
 *  - `package` — the whole handoff document. §5.5's *summary handoff*, and its
 *                stated DEFAULT.
 *  - `excerpt` — the package's "Recent activity" section: the prose and tool
 *                calls at the end of the conversation. §5.5's *full excerpt*,
 *                with the emphasis on the honest word — it is the largest
 *                mechanical excerpt we have, not the whole transcript, which
 *                §5.5 rules out in its opening paragraph (100k+ tokens would
 *                consume the target's window and its rate limit).
 */
export const CONTEXT_FIDELITIES = ['state', 'package', 'excerpt'] as const;

export type ContextFidelity = (typeof CONTEXT_FIDELITIES)[number];

/**
 * What the dialog opens on — §5.5 names Level 2 as the default in so many words.
 *
 * Declared here rather than as a literal in the component so the test that pins
 * "the default is the summary handoff" and the component that implements it read
 * the same constant. A default that drifts is a spec violation nobody notices.
 */
export const DEFAULT_FIDELITY: ContextFidelity = 'package';

/** One row of the dialog. */
export interface ContextOfferOption {
  id: ContextFidelity;
  /**
   * The size estimate the dialog shows — READ FROM THE PACKAGE'S OWN SECTION
   * ESTIMATE, never recomputed here or in the renderer.
   *
   * That is the item's done-when, and it is not pedantry: a second estimator
   * would be a second answer to "how big is this", and the two would disagree
   * the first time either one's caps moved. `ContextPackage.tokens`' own doc
   * already says it exists to be "what the drop dialog compares against the
   * other fidelity options".
   *
   * ⚠️ IT MEASURES THE CONTENT, NOT THE DOCUMENT — the same gap the package
   * documents for itself: `text` below carries a heading and a short preamble on
   * top, so what actually lands is a little larger. Stated rather than quietly
   * corrected, because the alternative is recomputing, and then the number in
   * the dialog stops being the number the package reports.
   */
  tokens: number;
  /**
   * This option's section held nothing.
   *
   * The done-when asks that the dialog "say what is thin rather than offering an
   * empty option that looks full". The option is still OFFERED and still
   * selectable — `text` is the package's own empty-section sentence, which tells
   * the target something true — but it is MARKED, so a user cannot pick a
   * 0-token handoff believing it carries the work.
   */
  empty: boolean;
  /**
   * Exactly what will be injected if this option is chosen.
   *
   * ⚠️ SHIPPED UP FRONT, WITH THE NUMBERS, FROM ONE BUILD OF ONE PACKAGE. The
   * obvious alternative — sizes now, fetch the text on OK — is two reads of a
   * LIVE transcript with a human pause between them, so the estimate shown and
   * the text delivered would describe different conversations. A package
   * measures ~3,100 tokens and ~11 ms (#766), so carrying all three bodies costs
   * nothing and removes that disagreement by construction rather than by care.
   */
  text: string;
}

/** Everything the drop dialog needs, from one build of one package. */
export interface ContextOffer {
  /** the SOURCE session — whose chip was dragged */
  from: { id: string; name: string };
  /**
   * How much of the source conversation the package saw (#766's `coverage`).
   *
   * Carried to the dialog as well as into every option's text, because the
   * person choosing a fidelity is owed the same caveat the receiving model is.
   * "The most recent part of it" changes which option is the honest one.
   */
  coverage: 'whole' | 'recent' | 'unreadable';
  options: ContextOfferOption[];
}

function isFidelity(v: unknown): v is ContextFidelity {
  return (CONTEXT_FIDELITIES as readonly unknown[]).includes(v);
}

/**
 * Guard for an offer arriving from main.
 *
 * A boundary check like every other one in `shared/`: the renderer is reading a
 * structured-cloned value over IPC, and a malformed one must land as "no offer"
 * — which the caller shows as a refusal — rather than as a dialog rendering
 * `undefined` rows. Fail-open in the direction that needs a human (PHILOSOPHY
 * §3): the cost of refusing a good offer is one more drag.
 */
export function isContextOffer(v: unknown): v is ContextOffer {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const from = o.from as Record<string, unknown> | undefined;
  if (!from || typeof from !== 'object') return false;
  if (typeof from.id !== 'string' || from.id === '') return false;
  if (typeof from.name !== 'string') return false;
  if (o.coverage !== 'whole' && o.coverage !== 'recent' && o.coverage !== 'unreadable') return false;
  if (!Array.isArray(o.options) || o.options.length === 0) return false;
  return o.options.every((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const r = raw as Record<string, unknown>;
    return (
      isFidelity(r.id) &&
      typeof r.tokens === 'number' &&
      Number.isFinite(r.tokens) &&
      typeof r.empty === 'boolean' &&
      typeof r.text === 'string'
    );
  });
}
