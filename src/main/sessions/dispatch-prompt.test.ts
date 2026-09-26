// The dispatched session's first turn (P2-E13-03, §5.15, #948).
//
// Small module, three claims worth pinning, and each of them is a claim a
// plausible wrong implementation gets wrong:
//
//  * THE ORDER. The briefing goes first and the role prompt last, because a role
//    prompt is free text a user typed and can contain an UNCLOSED code fence —
//    which, placed first, swallows the top of the briefing into a code block. The
//    test that matters is the adversarial one, not the tidy one.
//  * A FORK GETS NO DOCUMENT. `DispatchFork` carries no text at all (#947: "an
//    instruction, not a document"), so a builder written against
//    `DispatchBriefing` alone would either throw or interpolate `undefined`.
//  * AN EMPTY ROLE PROMPT IS LEGAL. #946 made it storable on purpose, and the
//    result has to be legible rather than a heading with nothing under it.
import { describe, it, expect } from 'vitest';
import {
  FORKED_PREAMBLE,
  NO_ROLE_PROMPT,
  buildDispatchPrompt,
} from './dispatch-prompt';
import { BUILT_IN_TEMPLATES, ROLE_PROMPT_CHAR_CAP, type RoleTemplate } from '../../shared/dispatch';
import type { DispatchContext } from './dispatch-context';

const REVIEWER = BUILT_IN_TEMPLATES[0];

const template = (over: Partial<RoleTemplate> = {}): RoleTemplate => ({
  id: 'user-1',
  name: 'Security review',
  rolePrompt: 'Look for injection.',
  autonomy: 'plan',
  contextPolicy: 'clean-room',
  workspacePolicy: 'same-folder',
  ...over,
});

const briefing = (text: string): DispatchContext => ({
  source: 'artifact-bundle',
  text,
  tokens: 10,
  empty: false,
});

const fork: DispatchContext = {
  source: 'fork-adoption',
  fork: { sourceSessionId: 'c0ffee', sourceFolder: 'C:/Projects/App' },
};

describe('buildDispatchPrompt', () => {
  it('carries the briefing and the role prompt, briefing first', () => {
    const out = buildDispatchPrompt(briefing('# Clean-room handoff\n\nthe diff'), REVIEWER);
    expect(out).toContain('# Clean-room handoff');
    expect(out).toContain('You are reviewing a change you did not write.');
    expect(out.indexOf('# Clean-room handoff')).toBeLessThan(
      out.indexOf('You are reviewing a change you did not write.')
    );
  });

  it('separates them with a heading, so two documents do not read as one', () => {
    const out = buildDispatchPrompt(briefing('the briefing'), template());
    // The briefing's own preamble promises "your own instructions arrive
    // separately from this document"; this is the line that makes it true.
    expect(out).toMatch(/the briefing\n\n## Your instructions\n\nLook for injection\./);
  });

  it('⚠️ an unclosed code fence in the ROLE PROMPT cannot swallow the briefing', () => {
    // THE REASON FOR THE ORDER, as a test. A user who pastes an example into a
    // template has written an unclosed fence; put the role prompt first and
    // everything after it — the briefing's heading, its preamble, the diff — is
    // inside a code block.
    const ROLE = 'Check this pattern:\n\n```ts\nconst x = 1;';
    const BRIEFING = '# Clean-room handoff from @App\n\nThe reasoning was withheld.';
    const out = buildDispatchPrompt(briefing(BRIEFING), template({ rolePrompt: ROLE }));
    // The briefing is ahead of the first fence the role prompt opens, so no
    // arrangement of backticks after it can reach back and enclose it.
    expect(out.indexOf(BRIEFING)).toBeLessThan(out.indexOf('```ts'));
    // And there is nothing after the unclosed fence for it to eat.
    expect(out.slice(out.indexOf('```ts')).trim()).toBe('```ts\nconst x = 1;');
  });

  it('a FORK is told it has the conversation, and carries no document', () => {
    const out = buildDispatchPrompt(fork, template({ contextPolicy: 'full' }));
    expect(out).toContain(FORKED_PREAMBLE);
    expect(out).toContain('Look for injection.');
    // Nothing from the fork operand leaks into the prompt: the conversation id
    // and the source folder are `sessions:create`'s business, not the model's.
    expect(out).not.toContain('c0ffee');
    expect(out).not.toContain('C:/Projects/App');
  });

  it('an empty role prompt says so rather than leaving a heading bare', () => {
    const out = buildDispatchPrompt(briefing('the briefing'), template({ rolePrompt: '' }));
    expect(out).toContain(NO_ROLE_PROMPT);
    // …and the same for whitespace, which is what a cleared textarea leaves.
    expect(buildDispatchPrompt(briefing('x'), template({ rolePrompt: '   \n\t ' }))).toContain(
      NO_ROLE_PROMPT
    );
  });

  it('strips control bytes out of the role prompt — it comes from a hand-edited file', () => {
    // `workspace.json` is a file a user edits, so this text has been through no
    // sanitiser before now. The briefing has: it was cleaned at the door by the
    // module that built it, and re-cleaning a finished document would invalidate
    // the fence it was assembled with (#947's lesson).
    const ESC = String.fromCharCode(27);
    const out = buildDispatchPrompt(
      briefing('the briefing'),
      template({ rolePrompt: `Review${ESC}[31m this` })
    );
    expect(out).not.toContain(ESC);
    expect(out).toContain('Review[31m this');
  });

  it('caps a role prompt at the store\u2019s own bound, with the in-band marker', () => {
    const out = buildDispatchPrompt(
      briefing('x'),
      template({ rolePrompt: 'a'.repeat(ROLE_PROMPT_CHAR_CAP + 500) })
    );
    expect(out).toContain('[truncated]');
    expect(out.length).toBeLessThan(ROLE_PROMPT_CHAR_CAP + 400);
  });

  it('is pure — the same inputs give the same bytes', () => {
    const b = briefing('# Handoff\n\nbody');
    expect(buildDispatchPrompt(b, REVIEWER)).toBe(buildDispatchPrompt(b, REVIEWER));
  });

  it('every built-in produces a prompt containing its own instructions', () => {
    // Generated from the list rather than written out three times, so a fourth
    // built-in is covered the day it ships.
    for (const t of BUILT_IN_TEMPLATES) {
      const out = buildDispatchPrompt(briefing('the briefing'), t);
      expect(out).toContain(t.rolePrompt.split('\n')[0]);
      expect(out).not.toContain(NO_ROLE_PROMPT);
    }
  });
});
