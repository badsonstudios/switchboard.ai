// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyPreference, loadPreference, resolveTheme } from './theme';

function mockSystemLight(light: boolean): void {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('light') ? light : !light,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

describe('theme manager', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('defaults to system preference', () => {
    expect(loadPreference()).toBe('system');
  });

  it('resolves system to the OS scheme', () => {
    mockSystemLight(true);
    expect(resolveTheme('system')).toBe('daylight');
    mockSystemLight(false);
    expect(resolveTheme('system')).toBe('nordic');
  });

  it('applies and persists an explicit choice', () => {
    mockSystemLight(false);
    const t = applyPreference('daylight');
    expect(t).toBe('daylight');
    expect(document.documentElement.dataset.theme).toBe('daylight');
    expect(loadPreference()).toBe('daylight');
  });

  it('ignores corrupt storage', () => {
    localStorage.setItem('switchboard.theme', 'neon-vomit');
    expect(loadPreference()).toBe('system');
  });
});
