import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ensureFolderTrusted, projectKey } from './trust';

let cfgPath: string;
beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trust-'));
  cfgPath = path.join(home, '.claude.json');
});

function writeCfg(obj: unknown): void {
  fs.writeFileSync(cfgPath, JSON.stringify(obj));
}
function readCfg(): { projects: Record<string, Record<string, unknown>> } & Record<string, unknown> {
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

describe('projectKey', () => {
  it('uses forward slashes (how Claude Code keys projects)', () => {
    expect(projectKey('C:\\Games')).toBe('C:/Games');
    expect(projectKey('C:/Games/')).toBe('C:/Games');
  });
});

describe('ensureFolderTrusted', () => {
  it('sets the trust flag under the forward-slash key, merging other config', () => {
    writeCfg({ projects: { 'C:/Games': { allowedTools: ['Read'] } }, hasCompletedOnboarding: true });
    expect(ensureFolderTrusted('C:\\Games', undefined, cfgPath)).toBe(true);
    const cfg = readCfg();
    expect(cfg.projects['C:/Games'].hasTrustDialogAccepted).toBe(true);
    expect(cfg.projects['C:/Games'].allowedTools).toEqual(['Read']); // untouched
    expect(cfg.hasCompletedOnboarding).toBe(true); // untouched
  });

  it('creates the project entry when absent', () => {
    writeCfg({ projects: {} });
    ensureFolderTrusted('C:\\New\\Folder', undefined, cfgPath);
    expect(readCfg().projects['C:/New/Folder'].hasTrustDialogAccepted).toBe(true);
  });

  it('is a no-op when already trusted (keeps other fields)', () => {
    writeCfg({ projects: { 'C:/Games': { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 5 } } });
    expect(ensureFolderTrusted('C:\\Games', undefined, cfgPath)).toBe(true);
    expect(readCfg().projects['C:/Games'].projectOnboardingSeenCount).toBe(5); // not reset
  });

  it('fails open (returns false, no throw) when the config is unreadable', () => {
    // cfgPath not written
    expect(ensureFolderTrusted('C:\\Games', undefined, cfgPath)).toBe(false);
  });
});
