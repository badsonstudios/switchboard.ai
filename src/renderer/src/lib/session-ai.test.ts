import { describe, it, expect } from 'vitest';
import type { AiListItem, CatalogEntry } from '../../../shared/ais';
import type { AisState } from './ais-store';
import { isClaudeAi, sessionAi } from './session-ai';

const entry = (id: string, name: string, providerId?: string): CatalogEntry => ({
  id,
  name,
  maker: '',
  description: '',
  engine: id === 'claude-code' ? 'native' : 'acp',
  install: { kind: 'link', url: 'https://example.invalid' },
  detectCommand: id,
  runsLocalModels: false,
  ...(providerId ? { providerId } : {}),
});

const ITEMS: AiListItem[] = [
  { kind: 'catalog', entry: entry('claude-code', 'Claude Code', 'claude-code'), providerId: 'claude-code', registered: true },
  { kind: 'catalog', entry: entry('codex-acp', 'Codex', 'codex'), providerId: 'codex', registered: true },
  { kind: 'provider', entry: { id: 'fake-acp', name: 'Fake ACP' }, providerId: 'fake-acp', registered: true },
];
const LIST: AisState = { items: ITEMS, defaultId: 'claude-code' };
const NO_LIST: AisState = { items: null, defaultId: null };

describe('which AI a sentence names (#1316)', () => {
  it("names the session's AI from the catalog", () => {
    expect(sessionAi(LIST, 'codex')).toEqual({ name: 'Codex', claude: false });
    expect(sessionAi(LIST, 'claude-code')).toEqual({ name: 'Claude Code', claude: true });
    expect(sessionAi(LIST, 'fake-acp')).toEqual({ name: 'Fake ACP', claude: false });
  });

  it("falls back to the provider's own name, never to its raw id", () => {
    expect(sessionAi(NO_LIST, 'codex', 'Codex')).toEqual({ name: 'Codex', claude: false });
    expect(sessionAi(NO_LIST, 'codex')).toEqual({ name: null, claude: false });
    expect(sessionAi(LIST, 'not-registered')).toEqual({ name: null, claude: false });
  });

  it('an unknown AI is not assumed to be Claude', () => {
    expect(sessionAi(LIST, undefined)).toEqual({ name: null, claude: false });
    expect(isClaudeAi(undefined)).toBe(false);
    expect(isClaudeAi(null)).toBe(false);
  });

  it("knows Claude by its id even before the list arrives — the Claude half is Claude's", () => {
    expect(sessionAi(NO_LIST, 'claude-code').claude).toBe(true);
    expect(isClaudeAi('claude-code')).toBe(true);
  });
});
