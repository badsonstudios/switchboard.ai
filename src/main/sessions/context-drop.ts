// What a dropped context chip offers (P2-E11-10, §5.5) — one build, three ways
// to read it.
//
// §5.5's drop dialog asks "Inject: last response | summary handoff | full
// excerpt…" with a size beside each. Every one of those three already exists
// inside the Level-2 package (#766), so this module SELECTS rather than
// extracts: it does not read a transcript, it does not build a second view of
// one, and it never computes a size of its own.
//
// ── WHY THE SIZES ARE NOT RECOMPUTED HERE ───────────────────────────────────
//
// The item's done-when is that the dialog's numbers come "from the generator
// rather than from a second estimate that can disagree with it". A second
// estimator is not a small duplication — `PACKAGE_CAPS`, `CHARS_PER_TOKEN` and
// the section boundaries would all have to be re-read correctly, and the day any
// of them moved, the dialog would quietly start describing a document the
// generator no longer produces. So each option's `tokens` is a field COPIED off
// `PackageSection.tokens` (or off `ContextPackage.tokens` for the whole
// document), and the only arithmetic in this file is none.
//
// The consequence, stated because it is a real gap and not an oversight: those
// numbers measure CONTENT, while what lands also carries a heading and a short
// preamble. `ContextPackage.tokens` documents exactly that gap for itself and
// keeps it deliberately, so all three options are compared on one consistent
// basis. Correcting it here would mean recomputing, which is the thing ruled out.
//
// ── AND WHY THE TEXT TRAVELS WITH THE SIZES ─────────────────────────────────
//
// The dialog could have asked for the chosen text on OK. It does not, and that
// is the one design decision in this file worth defending: the source is a LIVE
// session, so a second read happens after however long the user spent reading
// three options — and the estimate they chose from would then describe a
// conversation that has since moved on. One package answers both halves, so the
// number shown and the block delivered are the same read of the same file, by
// construction rather than by timing.
import {
  COVERAGE_LINE,
  emptySection,
  renderPackage,
  type ContextPackage,
  type SectionId,
} from './context-package';
import { cleanSenderName, stripUnsafeControls } from '../../shared/sibling-message';
import {
  CONTEXT_FIDELITIES,
  type ContextFidelity,
  type ContextOffer,
  type ContextOfferOption,
} from '../../shared/context-drop';

/**
 * Which package section each single-section fidelity reads.
 *
 * `package` is absent because it is not a section — it is the whole document,
 * and `renderPackage` is what produces it. The `Exclude` in the key type is what
 * makes that a compile error rather than a lookup that quietly returns
 * `undefined` if someone adds it later.
 */
const SECTION_FOR: Record<Exclude<ContextFidelity, 'package'>, SectionId> = {
  state: 'state',
  excerpt: 'activity',
};

function sectionOf(pkg: ContextPackage, id: SectionId) {
  return pkg.sections.find((s) => s.id === id);
}

/**
 * One section, as a document the receiving model can act on.
 *
 * THE PREAMBLE IS `renderPackage`'S, deliberately abbreviated but never in the
 * parts that carry a claim. Three things have to survive onto an excerpt or the
 * handoff is dishonest in exactly the way §5.5 spends a paragraph forbidding:
 *
 *  1. **WHO it came from** — the "Context from @A" header §5.5 names.
 *  2. **That no model wrote it.** A document headed "Where it left off" reads as
 *     a summary somebody composed. Saying plainly that it was extracted
 *     mechanically is what makes the rest safe to trust at the level it deserves.
 *  3. **How much of the conversation it saw.** This is the one that matters
 *     most and the one an excerpt would most easily lose: `renderPackage` prints
 *     `Covers:` and a single section, lifted out on its own, would print
 *     nothing — so a read that stopped short would reach the next session as a
 *     complete account of the work. #766 built `coverage` precisely so that
 *     could not happen, and an excerpt that dropped it would walk it back.
 */
function renderExcerpt(pkg: ContextPackage, id: SectionId): string {
  const section = sectionOf(pkg, id);
  const body = (section?.text ?? '').trim();
  const lines: string[] = [];
  // `cleanSenderName`, not the raw title (#799 review). `stripUnsafeControls`
  // deliberately keeps newlines, and no rename path normalises whitespace — so a
  // title carrying one would break the header of a document another model is
  // being asked to trust. The house already solved this for the sibling header;
  // this is the same hazard through a different door, and it also turns a blank
  // title into `(unnamed)` rather than `@`.
  lines.push(`# Context from @${cleanSenderName(pkg.session.name)} — ${section?.title ?? ''}`.trimEnd());
  lines.push('');
  lines.push(
    'This is one section of a handoff extracted mechanically from the session ' +
      'transcript — no model wrote it. It reports what the conversation ' +
      '*contains*, not what it meant.'
  );
  lines.push('');
  lines.push(`- **Session:** ${pkg.session.name} (${pkg.session.providerId})`);
  lines.push(`- **Folder:** ${pkg.session.folder}`);
  lines.push(`- **Covers:** ${COVERAGE_LINE[pkg.coverage]}`);
  lines.push('');
  // The package's OWN empty sentence, not one of ours. It is already
  // coverage-aware — "not in the part of the conversation this covers" versus
  // "this session has not said anything yet" are different claims and #766
  // chose between them carefully. Writing a second sentence here would be a
  // second, worse answer to a question already settled.
  lines.push(body === '' ? emptySection(id, pkg.coverage) : body);
  // A trailing newline for `renderPackage`'s reason: this text is appended to a
  // composer, and its last line must not run into whatever is typed next.
  return lines.join('\n') + '\n';
}

/**
 * Build the offer for a package.
 *
 * Pure, and total: every fidelity produces an option, including one whose
 * section is empty. An option that vanished when it had nothing would be a
 * dialog whose row count changed with the source session — and, worse, would
 * silently answer "there is no last response" by looking identical to a build
 * that never offered one. The `empty` flag is how that is said out loud instead.
 */
export function buildContextOffer(pkg: ContextPackage): ContextOffer {
  const options: ContextOfferOption[] = CONTEXT_FIDELITIES.map((id) => {
    if (id === 'package') {
      return {
        id,
        // The whole document's own estimate — the field whose doc says it exists
        // to be compared against the other options here.
        tokens: pkg.tokens,
        // A package is never blank (every section renders a sentence), so
        // "empty" can only mean the conversation held nothing for ANY section.
        // Reported rather than assumed impossible: a brand-new card is exactly
        // that, and a user dragging its chip deserves to be told.
        empty: pkg.sections.every((s) => s.text.trim() === ''),
        text: renderPackage(pkg),
      };
    }
    const sectionId = SECTION_FOR[id];
    const section = sectionOf(pkg, sectionId);
    return {
      id,
      tokens: section?.tokens ?? 0,
      empty: (section?.text ?? '').trim() === '',
      text: renderExcerpt(pkg, sectionId),
    };
  }).map((o) => ({
    ...o,
    // STRIPPED IN MAIN, WHERE THE TEXT IS BUILT — see `stripUnsafeControls`.
    // This is the last point before the block crosses to a window that will show
    // it to a person and take their Enter on it, and the property that matters
    // is that the text they review is the text the agent reads. A transcript can
    // legitimately carry a control byte; refusing the whole gesture over one
    // would be a refusal addressed to nobody.
    text: stripUnsafeControls(o.text),
  }));

  return {
    from: { id: pkg.session.id, name: pkg.session.name },
    coverage: pkg.coverage,
    options,
  };
}
