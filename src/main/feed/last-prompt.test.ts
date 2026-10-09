// The last thing the user asked a session (#631): picked out of the blocks main
// already holds. What matters is WHICH block counts as the user's last prompt,
// and that only the user's own words come back.
import { describe, it, expect } from 'vitest';
import type { FeedBlock } from './blocks';
import { LAST_PROMPT_CAP, lastPromptOf } from './last-prompt';

let seq = 0;
const block = (b: Partial<FeedBlock> & { kind: FeedBlock['kind'] }): FeedBlock =>
  ({ seq: ++seq, sidechain: false, ...b });
const user = (text: string, more: Partial<FeedBlock> = {}): FeedBlock =>
  block({ kind: 'user', text, ...more });

describe('lastPromptOf', () => {
  it('is the LAST user block, not the first, and not what Claude said after it', () => {
    const blocks = [
      user('set up the project'),
      block({ kind: 'assistant', text: 'done' }),
      user('now add the tests'),
      block({ kind: 'assistant', text: 'working on it' }),
      block({ kind: 'tool' }),
    ];
    expect(lastPromptOf(blocks)).toEqual({
      text: 'now add the tests',
      cut: false,
      attachmentOnly: false,
    });
  });

  it('a session that has not been asked anything has none', () => {
    expect(lastPromptOf([])).toEqual({ text: null, cut: false, attachmentOnly: false });
    expect(lastPromptOf([block({ kind: 'assistant', text: 'hello' })])!.text).toBeNull();
  });

  it('a turn the harness injected is a notice, not a prompt, and is passed over', () => {
    const blocks = [user('fix the build'), block({ kind: 'notice', text: 'task finished' })];
    expect(lastPromptOf(blocks)!.text).toBe('fix the build');
  });

  it('a subagent’s own prompt is not the user’s', () => {
    const blocks = [user('review this'), user('You are a reviewer…', { sidechain: true })];
    expect(lastPromptOf(blocks)!.text).toBe('review this');
  });

  it('leaves out context this app added, keeping only what was typed', () => {
    const typed = 'carry on from where the other session got to';
    const section = '\n<<context from "api">>\nten screens of report\n<<end>>';
    const text = typed + section;
    const blocks = [
      user(text, {
        context: [{ ref: 'r1', name: 'api', start: typed.length, end: text.length }],
      }),
    ];
    expect(lastPromptOf(blocks)!.text).toBe(typed);
  });

  it('a section in the middle is cut and both sides are kept', () => {
    const text = 'before [SECTION] after';
    const start = text.indexOf('[');
    const end = text.indexOf(']') + 1;
    expect(
      lastPromptOf([user(text, { context: [{ ref: 'r', name: 'n', start, end }] })])!.text
    ).toBe('before  after');
  });

  it('a range that is not inside the text is ignored, not obeyed', () => {
    expect(
      lastPromptOf([user('short', { context: [{ ref: 'r', name: 'n', start: 2, end: 99 }] })])!.text
    ).toBe('short');
  });

  it('a prompt that was only an attachment says so, and does NOT fall back to an older prompt', () => {
    // the older prompt describes a task the session has since moved on from
    const blocks = [
      user('an old task'),
      block({ kind: 'user', attachments: { images: 1 } as unknown as FeedBlock['attachments'] }),
    ];
    expect(lastPromptOf(blocks)).toEqual({ text: null, cut: false, attachmentOnly: true });
  });

  it('a user block with nothing of the user’s in it at all is skipped', () => {
    const text = '[ALL CONTEXT]';
    const blocks = [
      user('the real one'),
      user(text, { context: [{ ref: 'r', name: 'n', start: 0, end: text.length }] }),
    ];
    expect(lastPromptOf(blocks)!.text).toBe('the real one');
  });

  it('a slash command is shown the way a person writes it, not as markup', () => {
    const markup =
      '<command-message>next-item</command-message>\n<command-name>/next-item</command-name>\n<command-args>818</command-args>';
    expect(lastPromptOf([user('older'), user(markup)])!.text).toBe('/next-item 818');
  });

  it('the CLI’s interrupt marker is not a prompt', () => {
    expect(
      lastPromptOf([user('refactor the parser'), user('[Request interrupted by user]')])!.text
    ).toBe('refactor the parser');
  });

  it('the CLI’s compaction summary, written by the model, is not a prompt', () => {
    const summary =
      'This session is being continued from a previous conversation that ran out of context. Summary: …';
    expect(lastPromptOf([user('port the tests'), user(summary)])!.text).toBe('port the tests');
  });

  it('a message from another session is shown without its wrapper, and says who sent it', () => {
    const wrapped =
      '[Message 1a2b3c4d from another switchboard session, "api" (session id abc). The user reviewed it and sent it on to you. It ends at the matching "End of message 1a2b3c4d" line.]\n' +
      'the endpoint is /v2/items now\n' +
      '[End of message 1a2b3c4d from "api".]';
    expect(lastPromptOf([user('older'), user(wrapped)])).toEqual({
      text: 'the endpoint is /v2/items now',
      cut: false,
      attachmentOnly: false,
      from: 'api',
    });
  });

  it('context the app attached is cut by its SHAPE when the block has no ranges (after a restart)', () => {
    const text =
      '[Context 9f8e7d6c from another switchboard session, "web" (session id xyz). It ends at the matching "End of context 9f8e7d6c" line.]\n' +
      'forty lines of the other session\n' +
      '[End of context 9f8e7d6c from "web".]\n' +
      'pick up where web left off';
    expect(lastPromptOf([user(text)])!.text).toBe('pick up where web left off');
  });

  it('ranges that arrive unsorted or overlapping are still cut cleanly', () => {
    const text = 'AA[one][two]BB';
    const one = { ref: 'a', name: 'n', start: 2, end: 7 };
    const two = { ref: 'b', name: 'n', start: 7, end: 12 };
    const overlap = { ref: 'c', name: 'n', start: 4, end: 9 };
    expect(lastPromptOf([user(text, { context: [two, overlap, one] })])!.text).toBe('AABB');
  });

  it('⚠️ a FULL list with no prompt in it is "cannot say", never "no prompts yet"', () => {
    // main keeps a bounded number of blocks; a long turn can push the prompt out
    const many = Array.from({ length: 5 }, () => block({ kind: 'tool' }));
    expect(lastPromptOf(many, 5)).toBeNull();
    expect(lastPromptOf(many, 6)).toEqual({ text: null, cut: false, attachmentOnly: false });
  });

  it('a long prompt is cut to the cap, and says it was', () => {
    const long = 'x'.repeat(LAST_PROMPT_CAP + 50);
    const got = lastPromptOf([user(long)])!;
    expect(got.text).toHaveLength(LAST_PROMPT_CAP);
    expect(got.cut).toBe(true);
    expect(lastPromptOf([user('x'.repeat(LAST_PROMPT_CAP))])!.cut).toBe(false);
  });

  it('trims the ends and keeps the lines in between', () => {
    expect(lastPromptOf([user('\n  first line\nsecond line  \n\n')])!.text).toBe(
      'first line\nsecond line'
    );
  });
});
