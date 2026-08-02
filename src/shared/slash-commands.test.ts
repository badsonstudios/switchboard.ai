import { describe, expect, it } from 'vitest';
import {
  commandsFromCli,
  filterCommands,
  insertCommand,
  isCompleteCommand,
  mergeCommands,
  SlashCommand,
  slashToken,
} from './slash-commands';

const cmd = (name: string, source: SlashCommand['source'] = 'builtin'): SlashCommand => ({
  name,
  source,
});

describe('slashToken (popup trigger rule)', () => {
  it('empty token right after a leading slash', () => {
    expect(slashToken('/', 1)).toBe('');
  });

  it('partial name while the caret stays in the first token', () => {
    expect(slashToken('/cle', 4)).toBe('cle');
    expect(slashToken('/cle rest of prompt', 4)).toBe('cle'); // text after caret is fine
  });

  it('NO popup when the slash is mid-sentence', () => {
    expect(slashToken('say /', 5)).toBeNull();
    expect(slashToken('look at c:/tmp', 14)).toBeNull();
  });

  it('NO popup once the caret leaves the first token', () => {
    expect(slashToken('/clear now', 8)).toBeNull(); // caret in "now"
    expect(slashToken('/clear ', 7)).toBeNull(); // caret right after the space
  });

  it('NO popup with the caret at position 0 or an empty draft', () => {
    expect(slashToken('/clear', 0)).toBeNull();
    expect(slashToken('', 0)).toBeNull();
  });
});

describe('filterCommands', () => {
  const list = [cmd('compact'), cmd('clear'), cmd('mcp'), cmd('recall', 'project-command')];

  it('empty token keeps everything', () => {
    expect(filterCommands(list, '')).toHaveLength(4);
  });

  it('prefix matches rank before substring matches', () => {
    expect(filterCommands(list, 'c').map((c) => c.name)).toEqual(['clear', 'compact', 'mcp', 'recall']);
  });

  it('is case-insensitive and drops non-matches', () => {
    expect(filterCommands(list, 'CLE').map((c) => c.name)).toEqual(['clear']);
  });
});

describe('insertCommand', () => {
  it('replaces the token and appends a space', () => {
    expect(insertCommand('/cle', 4, 'clear')).toBe('/clear ');
  });

  it('keeps whatever already follows the caret, without doubling a space', () => {
    expect(insertCommand('/cle the rest', 4, 'clear')).toBe('/clear the rest');
    expect(insertCommand('/clethe rest', 4, 'clear')).toBe('/clear the rest');
  });
});

// #163 hand-test, 2026-08-02. Dan: "/usage does not work, nor does /agents,
// /model, etc. It seems like NONE of the slash commands work" in Direct mode.
// The CLI was innocent — every one of those returns renderable text over
// stream-json. The composer never sent them: the popup claimed Enter to
// CONFIRM a completion, so typing a command IN FULL and pressing Enter
// replaced `/usage` with `/usage ` and ran nothing, which is indistinguishable
// from being ignored.
describe('isCompleteCommand (Enter runs it when there is nothing to complete)', () => {
  it('a fully typed command is complete', () => {
    expect(isCompleteCommand('usage', 'usage')).toBe(true);
  });

  it('a partial token is NOT — Enter still completes it', () => {
    expect(isCompleteCommand('usa', 'usage')).toBe(false);
    expect(isCompleteCommand('', 'usage')).toBe(false);
  });

  it('a token that merely CONTAINS the name is not complete either', () => {
    // filterCommands matches on substring, so the popup can offer `/usage`
    // for the token `usages` — which is not the same command
    expect(isCompleteCommand('usages', 'usage')).toBe(false);
  });

  it('case-insensitive: /Usage is the command the user meant to run', () => {
    expect(isCompleteCommand('Usage', 'usage')).toBe(true);
    expect(isCompleteCommand('usage', 'Usage')).toBe(true);
  });
});

describe('mergeCommands (precedence)', () => {
  it('builtin beats a same-named project command', () => {
    const merged = mergeCommands([cmd('clear')], [cmd('clear', 'project-command')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('builtin');
  });

  it('project command beats user command; commands beat skills', () => {
    const merged = mergeCommands(
      [cmd('deploy', 'user-command'), cmd('review', 'project-skill')],
      [cmd('deploy', 'project-command'), cmd('review', 'project-command')]
    );
    expect(merged.find((c) => c.name === 'deploy')!.source).toBe('project-command');
    expect(merged.find((c) => c.name === 'review')!.source).toBe('project-command');
  });

  it('dedupes case-insensitively and sorts by name', () => {
    const merged = mergeCommands([cmd('B'), cmd('a')], [cmd('b', 'user-command')]);
    expect(merged.map((c) => c.name)).toEqual(['a', 'B']);
  });
});

describe('commandsFromCli (P2-E18-09: the CLI advertises its own commands)', () => {
  const known: SlashCommand[] = [
    { name: 'clear', source: 'builtin', description: 'Clear conversation history' },
    { name: 'doctor', source: 'builtin', description: 'Diagnose your installation' },
    { name: 'startup', source: 'project-skill', description: 'Load project context' },
  ];

  it('keeps our description and badge for a name we can classify', () => {
    const out = commandsFromCli([{ name: 'startup' }], known);
    expect(out).toEqual([
      { name: 'startup', source: 'project-skill', description: 'Load project context' },
    ]);
  });

  it('REPLACES rather than merges: what the CLI does not advertise is gone', () => {
    // `doctor` is in our curated list and not in the CLI's. A stale curated
    // entry disappearing is the whole point of the item.
    const out = commandsFromCli([{ name: 'clear' }], known);
    expect(out.map((c) => c.name)).toEqual(['clear']);
  });

  it('surfaces a command we could never have enumerated, tagged builtin', () => {
    const out = commandsFromCli([{ name: 'some-plugin:thing' }], known);
    expect(out).toEqual([{ name: 'some-plugin:thing', source: 'builtin', description: undefined }]);
  });

  it("a CLI-supplied description wins over ours; ours fills in when there is none", () => {
    const out = commandsFromCli(
      [
        { name: 'clear', description: 'Wipe it all' },
        { name: 'startup' },
      ],
      known
    );
    expect(out.find((c) => c.name === 'clear')!.description).toBe('Wipe it all');
    expect(out.find((c) => c.name === 'startup')!.description).toBe('Load project context');
  });

  it('matches our knowledge case-insensitively but types the CLI spelling', () => {
    const out = commandsFromCli([{ name: 'Startup' }], known);
    expect(out[0]).toMatchObject({ name: 'Startup', source: 'project-skill' });
  });

  it('dedupes repeats, drops blanks, and sorts by name', () => {
    const out = commandsFromCli(
      [{ name: 'b' }, { name: '  ' }, { name: 'a' }, { name: 'B', description: 'second' }],
      []
    );
    expect(out.map((c) => c.name)).toEqual(['a', 'b']);
    expect(out.find((c) => c.name === 'b')!.description).toBeUndefined(); // first won
  });

  it('an empty CLI list means an empty popup, not a silent fallback', () => {
    // The fallback decision belongs to the caller, which knows whether the CLI
    // has spoken at all. Deciding it here would make "the CLI told us nothing"
    // indistinguishable from "the CLI has not told us yet".
    expect(commandsFromCli([], known)).toEqual([]);
  });
});
