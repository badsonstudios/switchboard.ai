// A card's name, and where it comes from (#250).
//
// The shipped bug was ORDER: the header read dockview's `props.api.title`,
// which is set once at `addPanel` and never again, so a session renamed from
// the rail kept its old header text forever. The first case below is the one
// that was red.
import { describe, it, expect } from 'vitest';
import { cardHeaderTitle, composerName, COMPOSER_NAME_MAX } from './card-title';

describe('cardHeaderTitle (issue 250)', () => {
  it('prefers the store — the birth-time title is what went stale', () => {
    expect(cardHeaderTitle('renamed', 'at-birth', '/p/acme')).toBe('renamed');
  });

  it('falls back to the birth-time title before the store knows the card', () => {
    // a card mounts before the first `setSessions` lands; for those frames
    // `getCardTitle` has no answer and the panel api's copy is all there is
    expect(cardHeaderTitle(undefined, 'at-birth', '/p/acme')).toBe('at-birth');
  });

  it('falls back to the folder when nothing has named the card', () => {
    // its LAST SEGMENT: an absolute path is a poor name on a tab or in the rail
    expect(cardHeaderTitle(undefined, undefined, 'C:\\Projects\\acme')).toBe('acme');
    expect(cardHeaderTitle(undefined, undefined, '/home/dan/acme/')).toBe('acme');
    expect(cardHeaderTitle(undefined, undefined, 'acme')).toBe('acme');
  });

  it('treats a rename to nothing as no name — the header never goes blank', () => {
    // one can no longer be MADE (#294 rejects it at the rail and in main), but
    // a workspace written before that fix can still hold one, and rendering it
    // would leave the card unidentifiable.
    expect(cardHeaderTitle('', 'at-birth', 'C:\\Projects\\acme')).toBe('at-birth');
    expect(cardHeaderTitle('', '', 'C:\\Projects\\acme')).toBe('acme');
  });

  it('is a string even with nothing to say — the header renders it directly', () => {
    expect(cardHeaderTitle(undefined, undefined, undefined)).toBe('');
  });
});

describe('composerName (#1405)', () => {
  it('leaves a short name alone', () => {
    expect(composerName('Switchboard.ai - for tickets')).toBe('Switchboard.ai - for tickets');
  });
  it('cuts a long one to the limit, ellipsis included', () => {
    const out = composerName('x'.repeat(COMPOSER_NAME_MAX + 10));
    expect(Array.from(out)).toHaveLength(COMPOSER_NAME_MAX);
    expect(out.endsWith('…')).toBe(true);
  });
  it('keeps a name exactly at the limit whole', () => {
    expect(composerName('y'.repeat(COMPOSER_NAME_MAX))).toBe('y'.repeat(COMPOSER_NAME_MAX));
  });
  it('never cuts through an emoji, and drops the space before the ellipsis', () => {
    const name = 'a'.repeat(5) + ' ' + String.fromCodePoint(0x1f600).repeat(20);
    const out = composerName(name, 7);
    expect(out).toBe('aaaaa…');
    expect(composerName(String.fromCodePoint(0x1f600).repeat(10), 4)).toBe(String.fromCodePoint(0x1f600).repeat(3) + '…');
  });
});
