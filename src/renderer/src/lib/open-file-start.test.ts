// #569 — where the Open File browser starts.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  forgetOpenFileStart,
  openFileStartFolder,
  rememberOpenedFile,
} from './open-file-start';

beforeEach(() => forgetOpenFileStart());

describe('with nothing opened yet', () => {
  it('starts at the focused session folder — the "working folder"', () => {
    expect(openFileStartFolder('C:/Projects/switchboard')).toBe('C:/Projects/switchboard');
  });

  it('lets the OS decide when there is no session either', () => {
    expect(openFileStartFolder(undefined)).toBeUndefined();
    expect(openFileStartFolder(null)).toBeUndefined();
    expect(openFileStartFolder('')).toBeUndefined();
  });
});

describe('once a file has been opened', () => {
  it('remembers the folder it came out of, and prefers it', () => {
    rememberOpenedFile('C:/notes/2026/august.md');
    // beats the session folder: once you have browsed somewhere, that is the
    // better guess about where you are working
    expect(openFileStartFolder('C:/Projects/switchboard')).toBe('C:/notes/2026');
  });

  it('handles both separators, because main answers in the OS own spelling', () => {
    rememberOpenedFile('C:\\Users\\dan\\Documents\\plan.md');
    expect(openFileStartFolder()).toBe('C:\\Users\\dan\\Documents');
  });

  it('moves with each new file', () => {
    rememberOpenedFile('/home/dan/a/one.md');
    rememberOpenedFile('/home/dan/b/two.md');
    expect(openFileStartFolder()).toBe('/home/dan/b');
  });

  it('is unchanged by a cancelled dialog', () => {
    rememberOpenedFile('/home/dan/a/one.md');
    rememberOpenedFile(null);
    rememberOpenedFile(undefined);
    expect(openFileStartFolder()).toBe('/home/dan/a');
  });
});

describe('paths it cannot take a folder from', () => {
  it.each([
    ['a bare name', 'notes.md'],
    ['a root-level posix file', '/notes.md'],
    ['an empty string', ''],
  ])('ignores %s rather than remembering an empty or root folder', (_why, p) => {
    rememberOpenedFile('/home/dan/good/one.md');
    rememberOpenedFile(p);
    expect(openFileStartFolder()).toBe('/home/dan/good');
  });
});
