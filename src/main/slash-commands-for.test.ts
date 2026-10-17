// The `/` popup's list, per AI (#1288): builtins, plus the provider's own
// command files when it can find them.
import { describe, it, expect, vi } from 'vitest';
import { slashCommandsFor, slashHintsFor } from './slash-commands-for';
import type { MisplacedSkills, SlashCommand } from '../shared/slash-commands';

const BUILTIN: SlashCommand = { name: 'clear', description: 'Clear', source: 'builtin' };
const MINE: SlashCommand = { name: 'deploy', description: 'Ship it', source: 'project-command' };

describe('slashCommandsFor', () => {
  it('a provider with command files: builtins and files, merged', async () => {
    const scan = vi.fn(async () => [MINE]);
    const out = await slashCommandsFor(
      { slashCommands: () => [BUILTIN], capabilities: { commandFiles: { scan } } },
      '/p',
      vi.fn()
    );
    expect(out.map((c) => c.name)).toEqual(['clear', 'deploy']);
    expect(scan).toHaveBeenCalledWith('/p', expect.any(Function));
  });

  it('a provider that declares no command files: its builtins alone, and no disk read', async () => {
    const out = await slashCommandsFor({ slashCommands: () => [BUILTIN], capabilities: {} }, '/p', vi.fn());
    expect(out).toEqual([BUILTIN]);
  });

  it('a provider that declares nothing at all: an empty list, not an error', async () => {
    expect(await slashCommandsFor({}, '/p', vi.fn())).toEqual([]);
    expect(await slashCommandsFor(undefined, '/p', vi.fn())).toEqual([]);
  });

  it('a scan that THROWS falls open to the builtins and says so', async () => {
    const warn = vi.fn();
    const out = await slashCommandsFor(
      {
        slashCommands: () => [BUILTIN],
        capabilities: {
          commandFiles: {
            scan: () => Promise.reject(new Error('disk gone')),
          },
        },
      },
      '/p',
      warn
    );
    expect(out).toEqual([BUILTIN]);
    expect(warn).toHaveBeenCalledWith('slash-command scan threw', expect.anything());
  });

  it('a project command does not displace a builtin of the same name', async () => {
    // `mergeCommands` ranks builtins first — the same answer the one-pass scan gave.
    const clash: SlashCommand = { name: 'clear', description: 'mine', source: 'project-command' };
    const out = await slashCommandsFor(
      { slashCommands: () => [BUILTIN], capabilities: { commandFiles: { scan: async () => [clash] } } },
      '/p',
      vi.fn()
    );
    expect(out).toEqual([BUILTIN]);
  });
});

describe('slashHintsFor (#1328)', () => {
  const LOOSE: MisplacedSkills = { scope: 'project', shownDir: '.claude/skills', files: ['a.md'] };
  const scan = async (): Promise<SlashCommand[]> => [];

  it('asks the provider what it will not load', async () => {
    const misplaced = vi.fn(async () => [LOOSE]);
    const out = await slashHintsFor({ capabilities: { commandFiles: { scan, misplaced } } }, '/p', vi.fn());
    expect(out).toEqual([LOOSE]);
    expect(misplaced).toHaveBeenCalledWith('/p', expect.any(Function));
  });

  it('a provider with no notion of it, or none at all: no hints', async () => {
    expect(await slashHintsFor({ capabilities: { commandFiles: { scan } } }, '/p', vi.fn())).toEqual([]);
    expect(await slashHintsFor({ capabilities: {} }, '/p', vi.fn())).toEqual([]);
    expect(await slashHintsFor(undefined, '/p', vi.fn())).toEqual([]);
  });

  it('a check that THROWS costs the hint and says so, never rejects', async () => {
    const warn = vi.fn();
    const misplaced = () => Promise.reject(new Error('disk gone'));
    expect(await slashHintsFor({ capabilities: { commandFiles: { scan, misplaced } } }, '/p', warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith('skill layout check threw', { error: expect.stringContaining('disk gone') as unknown });
  });
});
