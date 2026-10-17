// The AIs tab's sorting and wording rules (#1292): pure, so pinned here.
import { describe, it, expect } from 'vitest';
import type { AiListItem, AisSnapshot, CatalogEntry, DetectionResult } from '../../../shared/ais';
import { aiName, catalogRows, draftOf, presenceOf, sameProgram, splitArgs, splitAis } from './ais-view';

const det = (over: Partial<DetectionResult> = {}): DetectionResult => ({
  installed: true,
  login: 'unknown',
  probedAt: 1,
  ...over,
});

const entry = (id: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id,
  name: id.toUpperCase(),
  maker: 'Maker',
  description: `the ${id} agent`,
  engine: 'acp',
  install: { kind: 'command', command: `npm i -g ${id}` },
  detectCommand: id,
  runsLocalModels: false,
  icon: `${id}.svg`,
  ...over,
});

function snap(items: AiListItem[], def = 'claude-code', extra: Partial<AisSnapshot['default']> = {}): AisSnapshot {
  return { items, default: { id: def, fellBack: false, ...extra }, detecting: false };
}

const claude: AiListItem = {
  kind: 'catalog',
  entry: entry('claude-code', { name: 'Claude Code', engine: 'native', providerId: 'claude-code' }),
  providerId: 'claude-code',
  registered: true,
  detection: det({ login: 'logged-in', version: '2.1.288' }),
};

describe('presenceOf', () => {
  it('no answer yet is "checking", never "missing"', () => {
    expect(presenceOf(undefined)).toBe('checking');
    expect(presenceOf(det({ installed: true }))).toBe('installed');
    expect(presenceOf(det({ installed: false }))).toBe('missing');
    expect(presenceOf(det({ installed: 'unknown' }))).toBe('unknown');
  });
});

describe('splitAis', () => {
  it('Found = registered, or installed; the rest is Not found', () => {
    const s = snap([
      claude,
      // installed but no provider: found, and not a default choice
      { kind: 'catalog', entry: entry('codex-acp', { providerId: 'codex' }), providerId: 'codex', registered: false, detection: det() },
      // not installed
      { kind: 'catalog', entry: entry('gemini'), registered: false, detection: det({ installed: false }) },
      // not answered yet
      { kind: 'catalog', entry: entry('goose'), registered: false },
      // a registered test fake whose program is gone stays in Found
      { kind: 'provider', entry: { id: 'fake-acp', name: 'Fake ACP' }, providerId: 'fake-acp', registered: true, detection: det({ installed: false }) },
    ]);
    const split = splitAis(s);
    expect(split.found.map((r) => r.key)).toEqual(['claude-code', 'codex-acp', 'fake-acp']);
    expect(split.notFound.map((r) => r.key)).toEqual(['gemini', 'goose']);
    expect(split.choices).toEqual([
      { id: 'claude-code', name: 'Claude Code' },
      { id: 'fake-acp', name: 'Fake ACP' },
    ]);
    expect(split.found.find((r) => r.key === 'codex-acp')!.providerId).toBeUndefined();
  });

  it('the default is marked and drawn first', () => {
    const s = snap(
      [claude, { kind: 'provider', entry: { id: 'fake-acp', name: 'Fake ACP' }, providerId: 'fake-acp', registered: true }],
      'fake-acp'
    );
    const split = splitAis(s);
    expect(split.found.map((r) => [r.key, r.isDefault])).toEqual([
      ['fake-acp', true],
      ['claude-code', false],
    ]);
  });

  it('a catalog row carries its icon from the renderer origin, and its install hint', () => {
    const r = splitAis(snap([claude])).found[0];
    expect(r.iconSrc).toBe('ai-icons/claude-code.svg');
    expect(r.install).toEqual({ kind: 'command', command: 'npm i -g claude-code' });
  });

  it('a custom AI is its own provider', () => {
    const s = snap([
      {
        kind: 'custom',
        entry: { id: 'custom:mine', name: 'Mine', command: 'mine', args: [], addedAt: 1 },
        providerId: 'custom:mine',
        registered: true,
        detection: det(),
      },
    ]);
    const split = splitAis(s);
    expect(split.found[0]).toMatchObject({ key: 'custom:mine', kind: 'custom', providerId: 'custom:mine' });
    expect(split.choices).toEqual([{ id: 'custom:mine', name: 'Mine' }]);
  });
});

describe('aiName', () => {
  it('names a provider id by its entry, else says the id', () => {
    const s = snap([claude]);
    expect(aiName(s, 'claude-code')).toBe('Claude Code');
    expect(aiName(s, 'custom:gone')).toBe('custom:gone');
    expect(aiName(s, undefined)).toBe('');
  });
});

describe('catalogRows', () => {
  const s = snap([
    claude,
    { kind: 'catalog', entry: entry('opencode', { name: 'OpenCode', runsLocalModels: true }), registered: false },
    { kind: 'catalog', entry: entry('gemini', { name: 'Gemini CLI', maker: 'Google' }), registered: false },
    { kind: 'provider', entry: { id: 'fake-acp', name: 'Fake ACP' }, providerId: 'fake-acp', registered: true },
  ]);
  it('lists only the catalog', () => {
    expect(catalogRows(s).map((r) => r.key)).toEqual(['claude-code', 'opencode', 'gemini']);
  });
  it('filters to the ones that run local models', () => {
    expect(catalogRows(s, { localOnly: true }).map((r) => r.key)).toEqual(['opencode']);
  });
  it('searches the name, the maker and the description', () => {
    expect(catalogRows(s, { query: 'google' }).map((r) => r.key)).toEqual(['gemini']);
    expect(catalogRows(s, { query: '  open ' }).map((r) => r.key)).toEqual(['opencode']);
    expect(catalogRows(s, { query: 'the gemini agent' }).map((r) => r.key)).toEqual(['gemini']);
  });
});

describe('the Something else form', () => {
  it('splits the arguments on whitespace', () => {
    expect(splitArgs('  acp   --model\tollama/qwen  ')).toEqual(['acp', '--model', 'ollama/qwen']);
    expect(splitArgs('   ')).toEqual([]);
  });
  it('keeps a command with a space in it whole', () => {
    expect(draftOf({ name: ' Mine ', command: ' C:/Program Files/x/x.exe ', args: 'a b' })).toEqual({
      name: 'Mine',
      command: 'C:/Program Files/x/x.exe',
      args: ['a', 'b'],
    });
  });
  it('Add follows the program Test passed, not the name', () => {
    const a = { name: 'A', command: 'x', args: ['1'] };
    expect(sameProgram(a, { ...a, name: 'B' })).toBe(true);
    expect(sameProgram(a, { ...a, args: ['2'] })).toBe(false);
    expect(sameProgram(a, { ...a, command: 'y' })).toBe(false);
    expect(sameProgram(null, a)).toBe(false);
  });
});
