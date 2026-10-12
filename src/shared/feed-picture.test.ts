import { describe, expect, it } from 'vitest';
import { DOC_IMAGE_SCHEME, docImagePath, docImageUrl } from './doc-image';
import {
  feedPictureHandle,
  feedPictureUrl,
  isFeedPictureHandle,
  isFeedPictureType,
  isFeedPictureUrl,
} from './feed-picture';

const ID = 'abcdef11-2222-4333-8444-555555555555';

describe('a conversation picture’s URL (#1240)', () => {
  it('carries the handle on the picture scheme’s `feed` host, and reads back', () => {
    const url = feedPictureUrl(ID);
    expect(url).toBe(`${DOC_IMAGE_SCHEME}://feed/?id=${ID}`);
    expect(isFeedPictureUrl(url)).toBe(true);
    expect(feedPictureHandle(url)).toBe(ID);
  });

  it('is never mistaken for a picture by PATH, nor the other way round', () => {
    expect(docImagePath(feedPictureUrl(ID))).toBeNull();
    expect(isFeedPictureUrl(docImageUrl('C:\\a.png'))).toBe(false);
    expect(feedPictureHandle(docImageUrl('C:\\a.png'))).toBeNull();
  });

  it('accepts a handle and nothing else', () => {
    expect(isFeedPictureHandle(ID)).toBe(true);
    for (const bad of ['', 'abc', `${ID} `, `../${ID}`, ID.toUpperCase(), `${ID}.png`, null, 3]) {
      expect(isFeedPictureHandle(bad), String(bad)).toBe(false);
    }
    expect(feedPictureHandle(`${DOC_IMAGE_SCHEME}://feed/?id=..%2Fx`)).toBeNull();
    expect(feedPictureHandle(`https://feed/?id=${ID}`)).toBeNull();
    expect(feedPictureHandle(undefined)).toBeNull();
  });

  it('draws the API’s four picture types and no other', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(isFeedPictureType(t)).toBe(true);
    for (const t of ['image/svg+xml', 'image/tiff', 'text/html', 'toString', '', undefined]) {
      expect(isFeedPictureType(t), String(t)).toBe(false);
    }
  });
});
