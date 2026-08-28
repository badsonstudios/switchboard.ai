// Which typed slash commands switchboard answers itself (#632, #721).
//
// THE RULE UNDER TEST IS THE STRICTNESS, not the match. Recognising `/mcp` is
// one line; the reason this has a test file is everything it must NOT
// recognise. An intercept that swallows a command addressed to the CLI is
// strictly worse than the dead end it replaces — the user loses the command AND
// gets no answer — so every near-miss below is a case where the text has to
// reach the session untouched.
import { describe, it, expect } from 'vitest';
import { interceptSlash } from './slash-intercept';

const kind = (s: string): string => interceptSlash(s).kind;

describe('/mcp opens the manager', () => {
  it('matches the bare command', () => {
    expect(kind('/mcp')).toBe('open-mcp');
  });

  it('tolerates trailing whitespace, which the composer would have trimmed', () => {
    expect(kind('/mcp ')).toBe('open-mcp');
    expect(kind('/mcp\t')).toBe('open-mcp');
  });

  it('is case-insensitive, because the CLI’s own matching is', () => {
    expect(kind('/MCP')).toBe('open-mcp');
    expect(kind('/Mcp')).toBe('open-mcp');
  });
});

// The second command to get a surface (#721). It could only be intercepted once
// there was an outbound control channel to ask the CLI what models exist and to
// tell it which to run — before that, this would have been a dead end with a
// dialog in front of it.
describe('/model opens the picker', () => {
  it('matches the bare command', () => {
    expect(kind('/model')).toBe('open-model');
  });

  it('tolerates trailing whitespace and is case-insensitive', () => {
    expect(kind('/model ')).toBe('open-model');
    expect(kind('/MODEL')).toBe('open-model');
  });

  it('does not shadow /mcp, and /mcp does not shadow it', () => {
    // Cheap, but the two routes now live in one table and a greedy pattern in
    // either would be invisible until someone typed the other command.
    expect(kind('/mcp')).toBe('open-mcp');
    expect(kind('/model')).toBe('open-model');
  });
});

describe('everything else reaches the session untouched', () => {
  const SENDS = [
    // AN ARGUMENT MEANS THE CLI'S PARSER SHOULD SEE IT. `/mcp list` is not the
    // picker, and answering it with our pane would be us deciding we knew
    // better than the command the user actually typed.
    '/mcp list',
    '/mcp add foo',
    // somebody's project command that merely starts the same way
    '/mcp-status',
    '/mcprestart',
    // an argument belongs to the CLI here too
    '/model sonnet',
    '/model-x',
    // the REMAINING picker commands — still #633's, and deliberately NOT ours:
    // an intercept with no surface behind it swallows the command as well as
    // failing to answer it
    '/permissions',
    '/agents',
    '/resume',
    // ordinary prompts, including ones that mention the word
    '/clear',
    'what MCP servers do I have?',
    'run /mcp for me',
    // NOT a command to the CLI either, so not one to us
    ' /mcp',
    ' /model',
    // a newline means there is a second line: a prompt, not a command. The
    // patterns are anchored WITHOUT the `m` flag precisely so this sends.
    '/model\nwhich one should I use?',
    '',
    '/',
  ];

  for (const text of SENDS) {
    it(`sends ${JSON.stringify(text)}`, () => {
      expect(kind(text)).toBe('send');
    });
  }
});
