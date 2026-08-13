import { describe, it, expect, beforeEach } from 'vitest';
import {
  findSurfaceFor,
  findSurfaceKey,
  publishFindSurface,
  resetFindSurfaces,
  subscribeFindSurfaces,
} from './find-surfaces';

const surface = (kind: string, tag: string): { kind: string; tag: string } => ({ kind, tag });

beforeEach(() => resetFindSurfaces());

describe('the find surface registry (P2-E17-02)', () => {
  it('keys a surface by CARD and panel, so two cards showing the same panel never collide', () => {
    // This is §5.31's whole argument against `webContents.findInPage`, reduced
    // to one assertion: there is no way to ask for "the feed" — only for a
    // named card's feed.
    publishFindSurface(findSurfaceKey('card-a', 'feed'), surface('feed', 'a'));
    publishFindSurface(findSurfaceKey('card-b', 'feed'), surface('feed', 'b'));

    expect(findSurfaceFor(findSurfaceKey('card-a', 'feed'))).toMatchObject({ tag: 'a' });
    expect(findSurfaceFor(findSurfaceKey('card-b', 'feed'))).toMatchObject({ tag: 'b' });
  });

  it('keeps a card’s panels apart', () => {
    publishFindSurface(findSurfaceKey('card-a', 'feed'), surface('feed', 'f'));
    publishFindSurface(findSurfaceKey('card-a', 'diff'), surface('monaco', 'm'));

    expect(findSurfaceFor(findSurfaceKey('card-a', 'feed'))).toMatchObject({ kind: 'feed' });
    expect(findSurfaceFor(findSurfaceKey('card-a', 'diff'))).toMatchObject({ kind: 'monaco' });
  });

  it('answers null for a panel that has not mounted', () => {
    expect(findSurfaceFor(findSurfaceKey('nobody', 'feed'))).toBeNull();
  });

  it('withdraws on cleanup', () => {
    const off = publishFindSurface(findSurfaceKey('c', 'feed'), surface('feed', 'x'));
    off();
    expect(findSurfaceFor(findSurfaceKey('c', 'feed'))).toBeNull();
  });

  it('a LATE cleanup from the previous instance cannot unpublish the new one', () => {
    // React mounts the next instance before unmounting the previous one under
    // StrictMode and when dockview re-parents a popout. Without the identity
    // check in the cleanup, the old instance's teardown would delete the live
    // surface and Ctrl+F would grey out for no visible reason.
    const key = findSurfaceKey('c', 'feed');
    const offOld = publishFindSurface(key, surface('feed', 'old'));
    publishFindSurface(key, surface('feed', 'new'));
    offOld();
    expect(findSurfaceFor(key)).toMatchObject({ tag: 'new' });
  });

  it('notifies subscribers on publish and on withdraw', () => {
    let n = 0;
    const unsub = subscribeFindSurfaces(() => (n += 1));
    const off = publishFindSurface(findSurfaceKey('c', 'feed'), surface('feed', 'x'));
    expect(n).toBe(1);
    off();
    expect(n).toBe(2);
    unsub();
    publishFindSurface(findSurfaceKey('c', 'feed'), surface('feed', 'y'));
    expect(n).toBe(2);
  });

  it('a throwing subscriber costs its own update, not everyone else’s', () => {
    let good = 0;
    subscribeFindSurfaces(() => {
      throw new Error('boom');
    });
    subscribeFindSurfaces(() => (good += 1));
    publishFindSurface(findSurfaceKey('c', 'feed'), surface('feed', 'x'));
    expect(good).toBe(1);
  });
});
