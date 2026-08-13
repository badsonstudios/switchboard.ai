// The viewer's dispatch table (P2-E16-02, §5.30).
//
// Table-driven, because the table IS the feature: "a `.md` opens rendered by
// default … a `.ts` opens in highlighted source … a PDF and a binary each show
// the card" is three rows of it.
import { describe, it, expect } from 'vitest';
import { classifyDocument, baseName, directoryName, extensionOf } from './document-kind';

describe('path pieces', () => {
  it('splits both platforms’ spellings', () => {
    expect(baseName('C:\\Projects\\sb\\PROGRESS.md')).toBe('PROGRESS.md');
    expect(baseName('/home/dan/sb/PROGRESS.md')).toBe('PROGRESS.md');
    expect(directoryName('C:\\Projects\\sb\\PROGRESS.md')).toBe('C:\\Projects\\sb');
    expect(directoryName('/home/dan/sb/PROGRESS.md')).toBe('/home/dan/sb');
  });

  it('a bare name has no directory, and a root file’s directory is the root', () => {
    expect(directoryName('PROGRESS.md')).toBe('');
    expect(directoryName('/PROGRESS.md')).toBe('/');
  });

  it('a dotfile has no extension — it has a name that starts with a dot', () => {
    expect(extensionOf('/x/.gitignore')).toBe('');
    expect(extensionOf('/x/README')).toBe('');
    expect(extensionOf('/x/a.tar.GZ')).toBe('gz');
  });
});

describe('classifyDocument', () => {
  const cases: Array<[string, string, string]> = [
    // path, kind, defaultMode
    ['/p/PROGRESS.md', 'markdown', 'rendered'],
    ['/p/docs/DESIGN.markdown', 'markdown', 'rendered'],
    ['/p/notes.MD', 'markdown', 'rendered'],
    ['/p/src/index.ts', 'text', 'source'],
    ['/p/.gitignore', 'text', 'source'],
    ['/p/data.json', 'text', 'source'],
    ['/p/report.pdf', 'external', 'source'],
    ['/p/logo.png', 'external', 'source'],
    ['/p/diagram.svg', 'external', 'source'],
    ['/p/app.exe', 'external', 'source'],
    ['/p/archive.zip', 'external', 'source'],
    ['/p/song.mp3', 'external', 'source'],
  ];
  for (const [file, kind, mode] of cases) {
    it(`${file} → ${kind}, opening in ${mode}`, () => {
      const c = classifyDocument(file);
      expect(c.kind).toBe(kind);
      expect(c.defaultMode).toBe(mode);
    });
  }

  it('gives the source body a real Monaco language, not plaintext for everything', () => {
    expect(classifyDocument('/p/src/index.ts').language).toBe('typescript');
    expect(classifyDocument('/p/main.py').language).toBe('python');
    // an unknown extension is still TEXT — most of them are config files, and
    // main's byte sniff is what catches the ones that are not
    expect(classifyDocument('/p/thing.zzz').kind).toBe('text');
  });

  it('carries the name and extension the card needs', () => {
    const c = classifyDocument('C:\\p\\Report Final.PDF');
    expect(c.name).toBe('Report Final.PDF');
    expect(c.extension).toBe('pdf');
  });
});
