import { describe, it, expect, vi } from 'vitest';
import { filterRows, firstRunnable, paletteRows, SESSION_ROW_PREFIX } from './palette';
import { Command, CommandContext } from './commands';

const ctx: CommandContext = {
  sessions: [
    { id: 'card-a', title: 'trading-app' },
    { id: 'card-b', title: 'switchboard' },
  ],
  activeCardId: 'card-a',
  attentionCount: 0,
};

// stand-in translator: 'commands.newSession' -> 'newSession', with params appended
const translate = (key: string, params?: Record<string, unknown>): string => {
  const leaf = key.split('.').pop() ?? key;
  const extra = params ? Object.values(params).join(' ') : '';
  return extra ? `${leaf} ${extra}` : leaf;
};

function cmds(): Command[] {
  return [
    {
      id: 'session.new',
      titleKey: 'commands.newSession',
      categoryKey: 'commands.category.session',
      binding: 'Mod+N',
      scope: 'app',
      run: vi.fn(),
    },
    {
      id: 'session.close',
      titleKey: 'commands.closeSession',
      categoryKey: 'commands.category.session',
      binding: 'Mod+W',
      scope: 'app',
      enabled: (c) => c.activeCardId !== null,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: vi.fn(),
    },
  ];
}

const src = (over: Partial<Parameters<typeof paletteRows>[0]> = {}) => ({
  commands: cmds(),
  ctx,
  translate,
  focusCard: vi.fn(),
  ...over,
});

describe('paletteRows (E9-02)', () => {
  it('lists every registry command, keeping its binding and category', () => {
    const rows = paletteRows(src());
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual(['session.new', 'session.close']);
    expect(rows[0].binding).toBe('Mod+N');
    expect(rows[0].categoryKey).toBe('commands.category.session');
  });

  it('adds a "go to" row per session, in rail order', () => {
    const rows = paletteRows(src()).filter((r) => r.id.startsWith(SESSION_ROW_PREFIX));
    expect(rows.map((r) => r.id)).toEqual([
      `${SESSION_ROW_PREFIX}card-a`,
      `${SESSION_ROW_PREFIX}card-b`,
    ]);
    expect(rows[0].title).toContain('trading-app');
  });

  it('a go-to row focuses its card', () => {
    const focusCard = vi.fn();
    const rows = paletteRows(src({ focusCard }));
    rows.find((r) => r.id === `${SESSION_ROW_PREFIX}card-b`)!.run();
    expect(focusCard).toHaveBeenCalledWith('card-b');
  });

  it('unmet preconditions render disabled WITH a reason, never hidden', () => {
    const rows = paletteRows(src({ ctx: { ...ctx, activeCardId: null } }));
    const close = rows.find((r) => r.id === 'session.close')!;
    expect(close.enabled).toBe(false);
    expect(close.disabledReasonKey).toBe('commands.disabled.noActiveSession');
  });

  it('a throwing precondition disables the row instead of exploding', () => {
    const bad = cmds();
    bad[0].enabled = () => {
      throw new Error('nope');
    };
    expect(() => paletteRows(src({ commands: bad }))).not.toThrow();
    expect(paletteRows(src({ commands: bad }))[0].enabled).toBe(false);
  });
});

describe('filterRows', () => {
  const rows = () => paletteRows(src({ ctx: { ...ctx, activeCardId: null } }));

  it('an empty query shows everything, enabled rows first', () => {
    const out = filterRows('', rows());
    expect(out).toHaveLength(4);
    expect(out[out.length - 1].id).toBe('session.close'); // the disabled one
  });

  it('filters by title and carries the matched indices for highlighting', () => {
    const out = filterRows('trad', rows());
    expect(out[0].id).toBe(`${SESSION_ROW_PREFIX}card-a`);
    expect(out[0].indices.length).toBe(4);
  });

  it('a query matching nothing yields no rows', () => {
    expect(filterRows('zzzz', rows())).toEqual([]);
  });

  it('firstRunnable skips disabled rows so Enter never hits an inert one', () => {
    const disabledFirst = [
      { ...rows()[0], enabled: false },
      { ...rows()[1], enabled: true },
    ];
    expect(firstRunnable(disabledFirst)).toBe(1);
    expect(firstRunnable([{ ...rows()[0], enabled: false }])).toBe(-1);
  });
});
