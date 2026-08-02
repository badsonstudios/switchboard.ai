import { describe, expect, it } from 'vitest';
import { StreamCommands } from './stream-commands';

const init = (slash_commands: unknown): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  slash_commands,
});

describe('StreamCommands (P2-E18-09)', () => {
  it('takes the name list off system:init', () => {
    const s = new StreamCommands();
    s.offer('a', init(['clear', 'compact', 'startup']));
    expect(s.commandsFor('a')).toEqual([
      { name: 'clear', description: undefined },
      { name: 'compact', description: undefined },
      { name: 'startup', description: undefined },
    ]);
  });

  // THE ONCE-PER-TURN PIN. S-11 measured 26 inits for 25 turns; an appending
  // consumer grows without bound over a working day, and appending is the
  // obvious way to write this.
  it('a SECOND system:init replaces rather than appends', () => {
    const s = new StreamCommands();
    s.offer('a', init(['clear', 'compact']));
    s.offer('a', init(['clear', 'compact']));
    expect(s.commandsFor('a')).toHaveLength(2);
  });

  it('a later init that drops a command drops it here too', () => {
    const s = new StreamCommands();
    s.offer('a', init(['clear', 'gone']));
    s.offer('a', init(['clear']));
    expect(s.commandsFor('a')!.map((c) => c.name)).toEqual(['clear']);
  });

  // Shape read out of the shipped extension bundle, not guessed: it stores
  // `e.commands` and renders `.name` / `.description` off each entry.
  it('takes the OBJECT list off system:commands_changed, descriptions and all', () => {
    const s = new StreamCommands();
    s.offer('a', init(['clear']));
    s.offer('a', {
      type: 'system',
      subtype: 'commands_changed',
      commands: [
        { name: 'clear', description: 'Clear conversation history', argumentHint: '[all]' },
        { name: 'brand-new', description: 'Just installed' },
      ],
    });
    expect(s.commandsFor('a')).toEqual([
      { name: 'clear', description: 'Clear conversation history' },
      { name: 'brand-new', description: 'Just installed' },
    ]);
  });

  it('is per session', () => {
    const s = new StreamCommands();
    s.offer('a', init(['only-a']));
    s.offer('b', init(['only-b']));
    expect(s.commandsFor('a')!.map((c) => c.name)).toEqual(['only-a']);
    expect(s.commandsFor('b')!.map((c) => c.name)).toEqual(['only-b']);
  });

  // The store reports the FACT; `sessions:slashCommands` decides what to show
  // for each, and gives both the same answer (its own test pins that).
  it('null until the CLI has spoken — which is not the same as empty', () => {
    const s = new StreamCommands();
    expect(s.commandsFor('never-seen')).toBeNull();
    s.offer('a', init([]));
    expect(s.commandsFor('a')).toEqual([]); // it spoke, and said nothing
  });

  it('ignores messages that carry no command list', () => {
    const s = new StreamCommands();
    s.offer('a', init(['clear']));
    s.offer('a', { type: 'assistant', message: {} });
    s.offer('a', { type: 'system', subtype: 'status' });
    s.offer('a', { type: 'result', subtype: 'success' });
    expect(s.commandsFor('a')!.map((c) => c.name)).toEqual(['clear']);
  });

  // Fail-open (P6): a stale list beats an empty popup, and a malformed payload
  // must never be the reason autocomplete stops working.
  it('keeps the prior list when a payload is malformed or absent', () => {
    const s = new StreamCommands();
    s.offer('a', init(['clear']));
    s.offer('a', { type: 'system', subtype: 'init' }); // no slash_commands at all
    s.offer('a', init('clear,compact')); // a string, not an array
    s.offer('a', { type: 'system', subtype: 'commands_changed', commands: null });
    expect(s.commandsFor('a')!.map((c) => c.name)).toEqual(['clear']);
  });

  it('drops junk entries without dropping their neighbours', () => {
    const s = new StreamCommands();
    s.offer('a', init(['clear', '', '   ', null, 42, { noName: true }, { name: 'ok' }]));
    expect(s.commandsFor('a')!.map((c) => c.name)).toEqual(['clear', 'ok']);
  });

  it('hands out copies, so a caller cannot mutate the store', () => {
    const s = new StreamCommands();
    s.offer('a', init(['clear']));
    s.commandsFor('a')!.push({ name: 'injected' });
    s.commandsFor('a')![0].name = 'clobbered';
    expect(s.commandsFor('a')!.map((c) => c.name)).toEqual(['clear']);
  });

  it('forgets a session', () => {
    const s = new StreamCommands();
    s.offer('a', init(['clear']));
    s.forgetSession('a');
    expect(s.commandsFor('a')).toBeNull();
  });
});
