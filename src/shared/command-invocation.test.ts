// #846 — telling a slash command apart from something a person said.
//
// The shapes below are the REAL ones, taken from the owner's transcripts while
// diagnosing the bug: the CLI writes the tags on separate lines with leading
// whitespace, which is why every rule here trims and none of them anchor to a
// bare `<`. Two exports, because the prompt readers skip these lines and the
// Feed renders them.
import { describe, it, expect } from 'vitest';
import { commandInvocation, isCommandPlumbing } from './command-invocation';

/** Verbatim from a real transcript, newlines and indentation included. */
const REAL_CLEAR =
  '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';

describe('isCommandPlumbing', () => {
  it('catches a command invocation, however the CLI indents it', () => {
    expect(isCommandPlumbing(REAL_CLEAR)).toBe(true);
    expect(isCommandPlumbing('<command-name>/clear</command-name>')).toBe(true);
    expect(isCommandPlumbing('   \n  <command-name>/x</command-name>')).toBe(true);
  });

  it('catches a bare <command-message>, which the CLI also writes first', () => {
    // one transcript in the measured sample opens with this rather than
    // <command-name>, so the list is two tags and not one
    expect(isCommandPlumbing('<command-message>clear</command-message>')).toBe(true);
  });

  it('does NOT catch a prompt that merely mentions the markup', () => {
    // this repo talks about `<command-name>` in prose constantly — including
    // the conversation that produced this fix. A prompt is still a prompt.
    expect(isCommandPlumbing('why does <command-name> show up in the history?')).toBe(false);
    expect(isCommandPlumbing('fix the <command-name> leak')).toBe(false);
  });

  it('leaves <local-command-*> alone — that family is handled before this', () => {
    // `isPlumbing` in main/feed/blocks.ts drops these, and the stdout echo
    // becomes an assistant block. Claiming them here would be a second rule.
    expect(isCommandPlumbing('<local-command-caveat>Caveat: …</local-command-caveat>')).toBe(false);
    expect(isCommandPlumbing('<local-command-stdout>out</local-command-stdout>')).toBe(false);
  });

  it('is not fooled by <command-args>, which never opens a line', () => {
    expect(isCommandPlumbing('<command-args>818</command-args>')).toBe(false);
  });

  it('says no to empty text rather than throwing', () => {
    expect(isCommandPlumbing('')).toBe(false);
    expect(isCommandPlumbing('   ')).toBe(false);
  });
});

describe('commandInvocation', () => {
  it('renders a bare command as the user typed it — no trailing space', () => {
    expect(commandInvocation(REAL_CLEAR)).toBe('/clear');
    expect(commandInvocation('<command-name>/clear</command-name>')).toBe('/clear');
  });

  it('carries the arguments, which is why it beats a bare name', () => {
    expect(
      commandInvocation(
        '<command-name>/next-item</command-name>\n<command-args>818</command-args>'
      )
    ).toBe('/next-item 818');
  });

  it('tolerates the tags in either order and across lines', () => {
    expect(
      commandInvocation('<command-args>818</command-args>\n<command-name>/next-item</command-name>')
    ).toBe('/next-item 818');
  });

  it('CLAMPS a pasted-briefing argument to one short line', () => {
    // Measured, and the reason this function does not just join and return: in
    // this repo `/startup` and `/next-item` are run with a whole briefing as the
    // argument. Of the 10 commands carrying non-empty args in the 1,200 newest
    // transcripts, 7 are 1,907-5,929 characters with 32-94 newlines. Both
    // callers draw this on ONE line — the Feed in a `nowrap` span that is also
    // an expander button's accessible name — so an unbounded blob would take
    // over the marker instead of labelling it.
    const briefing = `line one\n${'x'.repeat(3000)}\nline three`;
    const label = commandInvocation(
      `<command-name>/next-item</command-name><command-args>${briefing}</command-args>`
    );
    expect(label).not.toBeNull();
    expect(label!.length).toBeLessThanOrEqual(80);
    expect(label).not.toContain('\n');
    expect(label!.startsWith('/next-item ')).toBe(true);
    expect(label!.endsWith('…')).toBe(true);
  });

  it('leaves a short command alone — no ellipsis, no reflow', () => {
    expect(commandInvocation('<command-name>/next-item</command-name><command-args>818</command-args>')).toBe(
      '/next-item 818'
    );
    expect(commandInvocation('<command-name>/clear</command-name>')).toBe('/clear');
  });

  it('flattens an argument that merely spans lines, rather than truncating it', () => {
    // short enough to keep whole; the newline still must not survive
    const label = commandInvocation(
      '<command-name>/review</command-name><command-args>the diff\nplease</command-args>'
    );
    expect(label).toBe('/review the diff please');
  });

  it('answers null for text that is not a command at all', () => {
    expect(commandInvocation('what did we decide about the cache')).toBeNull();
    expect(commandInvocation('')).toBeNull();
    // args without a name is not a command we can name
    expect(commandInvocation('<command-args>818</command-args>')).toBeNull();
  });

  it('answers null for an EMPTY command rather than a blank string', () => {
    // a caller that renders this would otherwise draw an empty chip; null lets
    // every caller fall through to whatever it does when there is no command
    expect(commandInvocation('<command-name></command-name>')).toBeNull();
    expect(commandInvocation('<command-name>   </command-name>')).toBeNull();
  });
});
