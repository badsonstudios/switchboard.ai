// The `/` popup's list, per AI (#1288): builtins, plus the provider's own
// command files when it can find them.
import { describe, it, expect, vi } from 'vitest';
import { slashCommandsFor } from './slash-commands-for';
import type { SlashCommand } from '../shared/slash-commands';

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
