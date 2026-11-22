import { describe, it, expect } from 'vitest';
import {
  placeAfterStart,
  isPlausibleFolder,
  nextWorkPlace,
  otherConversationFolders,
  sanitizeWorkPlace,
  workFolderOf,
} from './work-folder';
import type { WorkdirEvent } from './engine-events';

const HOME = 'C:\\repo';
const WT = 'C:\\repo\\.claude\\worktrees\\probe';
const card = (workFolder?: string) => ({ identity: { folder: HOME }, ...(workFolder ? { workFolder } : {}) });
const ev = (move: WorkdirEvent['move'], cwd: string): WorkdirEvent => ({ type: 'workdir', move, cwd });
const yes = (): boolean => true;

describe('nextWorkPlace (#1616)', () => {
  it('entering a worktree moves the card and draws a line', () => {
    expect(nextWorkPlace(card(), ev('entered', WT), yes)).toEqual({ workFolder: WT, marker: 'entered' });
  });

  it('leaving it, back home, clears the work folder and draws a line', () => {
    expect(nextWorkPlace(card(WT), ev('left', HOME), yes)).toEqual({ workFolder: undefined, marker: 'left' });
  });

  it('home is compared by path key: case and a trailing slash are not a move', () => {
    expect(nextWorkPlace(card(WT), ev('left', 'c:/REPO/'), yes)).toEqual({ workFolder: undefined, marker: 'left' });
    expect(nextWorkPlace(card(), ev('entered', 'c:/repo'), yes)).toBeNull();
  });

  it('a repeated move draws nothing twice', () => {
    expect(nextWorkPlace(card(WT), ev('entered', WT), yes)).toBeNull();
  });

  it('a restatement corrects a card that believes it moved, silently', () => {
    expect(nextWorkPlace(card(WT), ev('reported', HOME), yes)).toEqual({ workFolder: undefined });
    expect(nextWorkPlace(card(WT), ev('reported', 'C:\\repo\\other'), yes)).toEqual({ workFolder: 'C:\\repo\\other' });
  });

  it('...but never starts one moving: its own folder spelled another way is not a move', () => {
    expect(nextWorkPlace(card(), ev('reported', 'C:\\REPO~1'), yes)).toBeNull();
  });

  it('a folder that is not there, or not a path, changes nothing (P6)', () => {
    expect(nextWorkPlace(card(), ev('entered', WT), () => false)).toBeNull();
    expect(nextWorkPlace(card(), ev('entered', 'relative/dir'), yes)).toBeNull();
    expect(nextWorkPlace(card(), ev('entered', ''), yes)).toBeNull();
    expect(nextWorkPlace(card(), ev('entered', `C:\\x${'y'.repeat(5000)}`), yes)).toBeNull();
  });

  it('asks the disk only about a change it would make', () => {
    let asked = 0;
    nextWorkPlace(card(WT), ev('entered', WT), () => (asked++, true));
    expect(asked).toBe(0);
  });
});

describe('isPlausibleFolder', () => {
  it('takes absolute paths on either platform', () => {
    expect(isPlausibleFolder('C:\\x')).toBe(true);
    expect(isPlausibleFolder('/home/u')).toBe(true);
    expect(isPlausibleFolder('\\\\server\\share')).toBe(true);
    expect(isPlausibleFolder('x')).toBe(false);
    expect(isPlausibleFolder('C:\\a\0b')).toBe(false);
    expect(isPlausibleFolder(7)).toBe(false);
  });
});

describe('workFolderOf / otherConversationFolders', () => {
  it('a card works where it moved to, else where it started', () => {
    expect(workFolderOf(card())).toBe(HOME);
    expect(workFolderOf(card(WT))).toBe(WT);
  });

  it('lists the other folders a conversation may be filed under, never the run folder, at most three', () => {
    expect(otherConversationFolders(card(WT), HOME)).toEqual([WT]);
    expect(otherConversationFolders(card(WT), WT)).toEqual([HOME]);
    expect(otherConversationFolders({ ...card(WT), filedUnder: 'C:\\gone' }, 'C:\\main')).toEqual([
      WT,
      'C:\\gone',
      HOME,
    ]);
    expect(otherConversationFolders(card(), HOME)).toEqual([]);
    expect(otherConversationFolders(undefined, HOME)).toEqual([]);
  });
});

describe('placeAfterStart (sessions:create)', () => {
  const isDir = (p: string): boolean => p !== 'C:/gone';
  const start = (resumed: boolean, resumeFolder?: string) => ({ runFolder: HOME, resumed, resumeFolder, isDirectory: isDir });

  it('a resume keeps the work folder, and files nothing extra when the conversation was there', () => {
    expect(placeAfterStart(card(WT), start(true, WT))).toEqual({ workFolder: WT, filedUnder: undefined });
    expect(placeAfterStart(card(WT), start(true, HOME))).toEqual({ workFolder: WT, filedUnder: undefined });
  });

  it('a resume whose worktree was removed comes home, and remembers where the conversation is filed', () => {
    expect(placeAfterStart(card('C:/gone'), start(true, 'C:/gone'))).toEqual({
      workFolder: undefined,
      filedUnder: 'C:/gone',
    });
  });

  it('a start that did not resume drops the work folder but keeps the pointer (#484)', () => {
    expect(placeAfterStart(card(WT), start(false))).toEqual({ workFolder: undefined, filedUnder: WT });
    expect(placeAfterStart({ ...card(), filedUnder: 'C:/f' }, start(false))).toEqual({
      workFolder: undefined,
      filedUnder: 'C:/f',
    });
  });

  it('a NEW card resumed from another folder records it (#1643)', () => {
    expect(placeAfterStart(undefined, start(true, 'C:/gone'))).toEqual({ workFolder: undefined, filedUnder: 'C:/gone' });
    expect(placeAfterStart(undefined, start(true, HOME))).toEqual({ workFolder: undefined, filedUnder: undefined });
    expect(placeAfterStart(undefined, start(false))).toEqual({ workFolder: undefined, filedUnder: undefined });
  });
});

describe('sanitizeWorkPlace (store load)', () => {
  it('drops a ragged or start-folder value, keeps a good one, and returns the same card when nothing changed', () => {
    const good = card(WT);
    expect(sanitizeWorkPlace(good)).toBe(good);
    expect(sanitizeWorkPlace({ ...card(), workFolder: 'rel' })).toEqual(card());
    expect(sanitizeWorkPlace({ ...card(), workFolder: 'c:/repo' })).toEqual(card());
    expect(sanitizeWorkPlace({ ...card(), filedUnder: 42 as unknown as string })).toEqual(card());
    expect(sanitizeWorkPlace({ ...card(), filedUnder: 'C:\\gone' })).toEqual({ ...card(), filedUnder: 'C:\\gone' });
  });
});
