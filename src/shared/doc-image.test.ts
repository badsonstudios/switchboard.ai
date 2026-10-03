// The URL a picture in a document rides on (#1080, §5.30).
import { describe, it, expect } from 'vitest';
import { DOC_IMAGE_SCHEME, docImageMime, docImagePath, docImageUrl } from './doc-image';

describe('docImageUrl / docImagePath — the path arrives as it left', () => {
  const paths = [
    '/home/dan/sb/docs/img/shot.png',
    'C:\\Projects\\Switchboard.ai\\docs\\img\\shot.png',
    '/home/dan/a folder/with #hash & ?query/100%.png',
    '/home/dan/sb/../../etc/shadow.png',
    '/home/dan/ünïcødé/图.png',
  ];
  for (const p of paths) {
    it(`round-trips ${p}`, () => {
      expect(docImagePath(docImageUrl(p))).toBe(p);
    });
  }

  it('answers null for anything that is not one of ours', () => {
    for (const url of [
      undefined,
      42,
      '',
      'not a url',
      'https://local/?path=%2Fa.png',
      `${DOC_IMAGE_SCHEME}://elsewhere/?path=%2Fa.png`,
      `${DOC_IMAGE_SCHEME}://local/`,
      `${DOC_IMAGE_SCHEME}://local/?path=`,
    ]) {
      expect(docImagePath(url)).toBeNull();
    }
  });
});

describe('docImageMime — a picture by name, and nothing else', () => {
  it('knows the picture types, in any case', () => {
    expect(docImageMime('/a/b.png')).toBe('image/png');
    expect(docImageMime('/a/b.JPG')).toBe('image/jpeg');
    expect(docImageMime('C:\\a\\b.Svg')).toBe('image/svg+xml');
  });

  it('refuses everything else, including an object-prototype name', () => {
    for (const p of ['/a/b.txt', '/a/b', '/a/b.png.exe', '/a/.ssh/id_rsa', '/a/b.constructor', '/a/b.']) {
      expect(docImageMime(p)).toBeUndefined();
    }
  });
});
