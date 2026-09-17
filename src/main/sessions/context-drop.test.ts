// The offer behind a dropped context chip (P2-E11-10, §5.5).
//
// THE CENTRAL CLAIM OF THIS MODULE IS A NEGATIVE ONE — "the sizes are read from
// the package, never recomputed" — and a negative claim is the kind a suite
// passes by accident. A test that built a package and checked the numbers looked
// right would pass just as happily against an implementation that re-estimated
// the text itself, because for a real package the two agree.
//
// So the load-bearing test hands in a package whose section estimates are
// DELIBERATELY WRONG and asserts the offer repeats them. Only a copy does that;
// any recomputation, however careful, corrects them and fails.
import { describe, it, expect } from 'vitest';
import { buildContextOffer } from './context-drop';
import {
  buildContextPackage,
  estimateTokens,
  renderPackage,
  type ContextPackage,
} from './context-package';
import { CONTEXT_FIDELITIES } from '../../shared/context-drop';
import type { SessionSummary } from '../../shared/sessions';

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 'sess-1',
  name: 'TradingApp',
  folder: 'C:/Projects/TradingApp',
  providerId: 'claude-code',
  status: 'working',
  exited: false,
  ...over,
});

const userLine = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const assistantLine = (text: string) =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

const entriesOf = (lines: string[]): Record<string, unknown>[] =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>);

const build = (lines: string[], over: Partial<Parameters<typeof buildContextPackage>[0]> = {}) =>
  buildContextPackage({ session: session(), entries: entriesOf(lines), cut: false, ...over });

const optionOf = (offer: ReturnType<typeof buildContextOffer>, id: string) => {
  const o = offer.options.find((x) => x.id === id);
  if (!o) throw new Error(`no option ${id}`);
  return o;
};

/** A package built by hand, so a section's reported size can be made to lie. */
const packageWith = (over: Partial<ContextPackage> = {}): ContextPackage => ({
  session: session(),
  coverage: 'whole',
  tokens: 999,
  sections: [
    { id: 'goal', title: 'Goal', text: 'ship it', tokens: 1, truncated: false },
    { id: 'instructions', title: 'What the user asked for along the way', text: '- go', tokens: 2, truncated: false },
    { id: 'plan', title: 'Plan / todo state', text: '- [x] a', tokens: 3, truncated: false },
    { id: 'files', title: 'Files touched', text: '- a.ts', tokens: 4, truncated: false },
    { id: 'activity', title: 'Recent activity', text: 'did a thing', tokens: 5, truncated: false },
    { id: 'state', title: 'Where it left off', text: 'stopped here', tokens: 6, truncated: false },
  ],
  ...over,
});

describe('the sizes come from the package, and are not recomputed', () => {
  it('⚠️ REPEATS a section estimate even when it is WRONG — the proof it is copied', () => {
    // Every number here is a lie about its own text: `state` says 6 tokens for
    // twelve characters, the whole package says 999. An implementation that
    // estimated the text would report 3 and something near 21. The done-when is
    // that the dialog shows what the GENERATOR says, so this is the behaviour.
    const offer = buildContextOffer(packageWith());
    expect(optionOf(offer, 'state').tokens).toBe(6);
    expect(optionOf(offer, 'excerpt').tokens).toBe(5); // the `activity` section
    expect(optionOf(offer, 'package').tokens).toBe(999);
    // …and to be explicit about what a recomputation WOULD have said:
    expect(estimateTokens('stopped here')).not.toBe(6);
  });

  it('reads `excerpt` off the ACTIVITY section and `state` off the STATE section', () => {
    // Pinned by giving the two sections distinguishable sizes, because swapping
    // them is the single most plausible wrong edit in this file and every other
    // assertion here would survive it.
    const offer = buildContextOffer(
      packageWith({
        sections: packageWith().sections.map((s) =>
          s.id === 'activity' ? { ...s, tokens: 700 } : s.id === 'state' ? { ...s, tokens: 800 } : s
        ),
      })
    );
    expect(optionOf(offer, 'excerpt').tokens).toBe(700);
    expect(optionOf(offer, 'state').tokens).toBe(800);
  });

  it('offers every fidelity §5.5 names, in that order, for every package', () => {
    const offer = buildContextOffer(build([userLine('go'), assistantLine('done')]));
    expect(offer.options.map((o) => o.id)).toEqual([...CONTEXT_FIDELITIES]);
  });
});

describe('what the target actually receives', () => {
  it('hands the summary handoff over as `renderPackage` wrote it, byte for byte', () => {
    const pkg = build([userLine('Port the settings pane.'), assistantLine('On it.')]);
    expect(optionOf(buildContextOffer(pkg), 'package').text).toBe(renderPackage(pkg));
  });

  it('names the SOURCE session in every option — §5.5 asks for a "Context from @A" header', () => {
    const offer = buildContextOffer(build([userLine('go'), assistantLine('done')]));
    expect(offer.from).toEqual({ id: 'sess-1', name: 'TradingApp' });
    for (const o of offer.options) expect(o.text).toContain('Context from @TradingApp');
  });

  it('⚠️ carries COVERAGE into every option, not just the whole package', () => {
    // The one that would be easiest to lose and worst to lose. A single section
    // lifted out on its own carries no `Covers:` line of its own, so a read that
    // stopped short would reach the next session as a complete account of the
    // work — which is the exact confident wrong answer #766 built `coverage` to
    // prevent, walked back by an excerpt.
    const offer = buildContextOffer(build([userLine('go'), assistantLine('done')], { cut: true }));
    expect(offer.coverage).toBe('recent');
    for (const o of offer.options) {
      expect(o.text).toContain('there is older history not included here');
    }
  });

  it('says an unreadable transcript is a fact about the READ, in every option', () => {
    const offer = buildContextOffer(build([], { unreadable: true }));
    expect(offer.coverage).toBe('unreadable');
    for (const o of offer.options) {
      expect(o.text).toContain('could not be read');
      expect(o.text).toContain('Do not conclude from');
    }
  });
});

describe('a thin option says it is thin, rather than looking full', () => {
  it('marks an empty section and still offers it, carrying the package’s own sentence', () => {
    // A planning-only session: prose, no tools. `activity` has content, but a
    // session that has said nothing has no `state`.
    const offer = buildContextOffer(build([userLine('just thinking out loud')]));
    const state = optionOf(offer, 'state');
    expect(state.empty).toBe(true);
    // #766's wording, not a second sentence invented here.
    expect(state.text).toContain('The session has not said anything yet');
  });

  it('does not drop an empty option — a missing row and a thin one are different claims', () => {
    const offer = buildContextOffer(build([]));
    expect(offer.options.map((o) => o.id)).toEqual([...CONTEXT_FIDELITIES]);
  });

  it('reports a package with nothing in ANY section as empty — a brand-new card', () => {
    expect(optionOf(buildContextOffer(build([])), 'package').empty).toBe(true);
  });

  it('does NOT call a package with real content empty', () => {
    const offer = buildContextOffer(build([userLine('go'), assistantLine('done')]));
    expect(optionOf(offer, 'package').empty).toBe(false);
  });
});

describe('the text is safe to put in front of a person who will press Enter on it', () => {
  it('strips the control and invisible characters a transcript can carry', () => {
    // A tool that printed an ESC, and a tag character — invisible ASCII, the
    // "smuggling" class. A sibling's message is REFUSED for these; a context
    // block is stripped, because there is no sender here to be told otherwise.
    const esc = String.fromCodePoint(0x1b);
    const tag = String.fromCodePoint(0xe0041);
    const offer = buildContextOffer(
      build([userLine('go'), assistantLine(`done${esc}[201~${tag} really`)])
    );
    for (const o of offer.options) {
      expect(o.text).not.toContain(esc);
      expect(o.text).not.toContain(tag);
    }
    // …and the words around them survive: this strips, it does not truncate.
    expect(optionOf(offer, 'state').text).toContain('really');
  });

  it('leaves ordinary model output alone — emoji and their joiners are not smuggling', () => {
    const offer = buildContextOffer(build([userLine('go'), assistantLine('shipped 👩‍💻 ❤️')]));
    expect(optionOf(offer, 'state').text).toContain('👩‍💻');
    expect(optionOf(offer, 'state').text).toContain('❤️');
  });
});
