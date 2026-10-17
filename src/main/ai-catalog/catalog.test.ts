// The shipped catalog (#1291): every entry has what screens 4 and 5 draw, the
// icons are local SVGs, and the vouched entries match the shipped snapshot.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AI_ICON_BASE } from '../../shared/ais';
import { catalogEntries, catalogEntry, catalogEntryForProvider, CLAUDE_CATALOG_ID, shippedRegistry } from './catalog';

const iconDir = path.join(process.cwd(), 'src', 'renderer', 'public', ...AI_ICON_BASE.split('/').filter(Boolean));

describe('the shipped catalog', () => {
  it('Claude Code first, on its native engine, hosted by the claude-code provider', () => {
    const [first] = catalogEntries();
    expect(first.id).toBe(CLAUDE_CATALOG_ID);
    expect(first).toMatchObject({ engine: 'native', providerId: 'claude-code', detectCommand: 'claude' });
    expect(first.launch).toBeUndefined();
    expect(catalogEntryForProvider('claude-code')).toBe(first);
  });

  it('does NOT carry the registry’s own Claude entry (we have the native engine)', () => {
    expect(catalogEntry('claude-acp')).toBeUndefined();
  });

  it('ids are unique, and every entry has what the AIs tab and Add-an-AI draw', () => {
    const ids = catalogEntries().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of catalogEntries()) {
      expect(e.name, e.id).toBeTruthy();
      expect(e.maker, e.id).toBeTruthy();
      expect(e.description, e.id).toBeTruthy();
      expect(e.detectCommand, e.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(typeof e.runsLocalModels, e.id).toBe('boolean');
      expect(['command', 'link'], e.id).toContain(e.install.kind);
      if (e.install.kind === 'link') expect(e.install.url, e.id).toMatch(/^https:\/\//);
      if (e.engine === 'acp') {
        expect(e.launch?.command, e.id).toBeTruthy();
        expect(e.registryId, e.id).toBe(e.id);
      }
    }
  });

  it('the vouched set the item names is in it', () => {
    for (const id of ['codex-acp', 'gemini', 'github-copilot-cli', 'opencode', 'goose', 'qwen-code', 'mistral-vibe']) {
      expect(catalogEntry(id), id).toBeDefined();
    }
    expect(catalogEntry('codex-acp')).toMatchObject({
      providerId: 'codex',
      launch: { command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@2.2.2'] },
    });
  });

  it('local models: OpenCode and goose', () => {
    expect(catalogEntries().filter((e) => e.runsLocalModels).map((e) => e.id).sort()).toEqual(['goose', 'opencode']);
  });

  it('every icon is a local SVG under 50 KB with no script, foreignObject or external reference', () => {
    for (const e of catalogEntries()) {
      expect(e.icon, e.id).toBe(`${e.id}.svg`);
      const file = path.join(iconDir, e.icon!);
      const bytes = fs.readFileSync(file);
      expect(bytes.length, e.id).toBeLessThan(50 * 1024);
      const text = bytes.toString('utf8');
      expect(text, e.id).toMatch(/<svg[\s>]/);
      expect(text, e.id).not.toMatch(/<script|foreignObject|on[a-z]+=|href="(https?:|\/\/)/i);
    }
  });

  it('every vouched entry is in the shipped snapshot, at the version it was copied at', () => {
    const snap = new Map(shippedRegistry().map((a) => [a.id, a]));
    expect(snap.size).toBe(42);
    for (const e of catalogEntries().filter((x) => x.registryId)) {
      expect(snap.get(e.registryId!)?.version, e.id).toBe(e.registryVersion);
    }
  });
});
