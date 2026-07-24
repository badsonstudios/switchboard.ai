import { describe, expect, it } from 'vitest';
import { filterCommands, insertCommand, mergeCommands, SlashCommand, slashToken } from './slash-commands';

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
