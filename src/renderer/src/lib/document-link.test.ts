// What a link in a rendered document means (P2-E16-02, §5.30 + §5.29).
//
// The hostile half of the viewer, and the reason it is a pure function with a
// table: these strings come out of a file we did not write.
import { describe, it, expect } from 'vitest';
import { classifyHref, resolveRelativePath, isAbsolutePath } from './document-link';

const DOC_POSIX = '/home/dan/sb/docs/DESIGN.md';
const DOC_WIN = 'C:\\Projects\\sb\\docs\\DESIGN.md';

describe('classifyHref — schemes', () => {
  it('http, https and mailto are external', () => {
    for (const href of ['http://x.test/a', 'https://x.test/a', 'mailto:a@b.c', 'HTTPS://X.test']) {
      expect(classifyHref(href, DOC_POSIX).kind).toBe('external');
    }
  });

  it('javascript: is BLOCKED and carries no target — "does nothing at all"', () => {
    for (const href of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'jAvAsCrIpT:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'ms-msdt:/id PCWDiagnostic',
      'about:blank',
      'chrome://settings',
    ]) {
      expect(classifyHref(href, DOC_POSIX)).toEqual({ kind: 'blocked', target: '' });
    }
  });

  it('junk of every shape is blocked rather than guessed at', () => {
    for (const href of [null, undefined, 42, {}, '', '   ']) {
      expect(classifyHref(href, DOC_POSIX).kind).toBe('blocked');
    }
  });
});

describe('classifyHref — anchors and relative paths', () => {
  it('#heading scrolls this document', () => {
    expect(classifyHref('#the-hand-off', DOC_POSIX)).toEqual({
      kind: 'anchor',
      target: 'the-hand-off',
    });
  });

  it('a sibling file resolves against the document’s folder', () => {
    expect(classifyHref('PHILOSOPHY.md', DOC_POSIX)).toMatchObject({
      kind: 'relative',
      target: '/home/dan/sb/docs/PHILOSOPHY.md',
    });
  });

  it('DESIGN.md → docs/plans/00-process.md works, which is the §5.30 example', () => {
    expect(classifyHref('plans/00-process.md', DOC_POSIX).target).toBe(
      '/home/dan/sb/docs/plans/00-process.md'
    );
    expect(classifyHref('../PROGRESS.md', DOC_POSIX).target).toBe('/home/dan/sb/PROGRESS.md');
  });

  it('keeps the fragment so a link into a heading lands on it', () => {
    expect(classifyHref('plans/00-process.md#the-hand-off', DOC_POSIX)).toEqual({
      kind: 'relative',
      target: '/home/dan/sb/docs/plans/00-process.md',
      hash: 'the-hand-off',
    });
  });

  it('percent-encoding is decoded, because a path is not a URL', () => {
    expect(classifyHref('my%20notes.md', DOC_POSIX).target).toBe('/home/dan/sb/docs/my notes.md');
  });

  it('a Windows drive letter is a path, not the scheme "c:"', () => {
    expect(isAbsolutePath('C:\\x\\y.md')).toBe(true);
    expect(classifyHref('..\\PROGRESS.md', DOC_WIN)).toMatchObject({
      kind: 'relative',
      target: 'C:\\Projects\\sb\\PROGRESS.md',
    });
    expect(classifyHref('C:/Projects/sb/PROGRESS.md', DOC_WIN).kind).toBe('relative');
  });
});

describe('resolveRelativePath', () => {
  it('keeps the document’s own separator', () => {
    expect(resolveRelativePath(DOC_WIN, 'plans/00.md')).toBe('C:\\Projects\\sb\\docs\\plans\\00.md');
    expect(resolveRelativePath(DOC_POSIX, 'plans/00.md')).toBe('/home/dan/sb/docs/plans/00.md');
  });

  it('collapses . and .. and never climbs above the root', () => {
    expect(resolveRelativePath(DOC_POSIX, './a/./b.md')).toBe('/home/dan/sb/docs/a/b.md');
    expect(resolveRelativePath(DOC_POSIX, '../../../../../../etc/passwd')).toBe('/etc/passwd');
  });

  it('an absolute href stays absolute — main is what decides if it may be read', () => {
    expect(resolveRelativePath(DOC_POSIX, '/etc/passwd')).toBe('/etc/passwd');
  });
});
