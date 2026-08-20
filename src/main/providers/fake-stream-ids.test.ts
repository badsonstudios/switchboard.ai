// #603 — the fake stream CLI's per-spawn conversation ids.
//
// The counter is a FILESYSTEM counter because every fake session is a separate
// child process, so this is the one piece of the fake that cannot be proven by
// calling a function with a fake host: the claim has to happen against real
// directory entries, in a real temp directory, twice, the way two spawns do it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FAKE_SESSION_ID, fakeSessionId, claimFakeSessionId } from './fake-stream-ids';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fake-ids-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('fakeSessionId', () => {
  // The e2e specs that assert a literal id assert THIS one, and they are
  // single-card tests where there was never a collision to have. If the first
  // id ever moves, every one of them has to move with it — so pin it here,
  // where the failure names the reason, rather than discovering it as six
  // unrelated e2e failures under the machine lock.
  it('the first id is the constant that used to serve every session', () => {
    expect(fakeSessionId(0)).toBe('00000000-fake-4000-8000-000000000000');
    expect(FAKE_SESSION_ID).toBe(fakeSessionId(0));
  });

  it('is uuid-SHAPED, so it can be a file name and a session_id unremarked', () => {
    for (const n of [0, 1, 9, 42, 1_000]) {
      expect(fakeSessionId(n)).toMatch(/^[0-9a-f]{8}-fake-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('counts, so ids sort in the order they were handed out', () => {
    const ids = [0, 1, 2, 10].map(fakeSessionId);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('claimFakeSessionId', () => {
  it('hands the first caller the first id and the next caller the next one', () => {
    expect(claimFakeSessionId(dir)).toBe(fakeSessionId(0));
    expect(claimFakeSessionId(dir)).toBe(fakeSessionId(1));
    expect(claimFakeSessionId(dir)).toBe(fakeSessionId(2));
  });

  it('never repeats itself — the defect, stated directly', () => {
    const ids = Array.from({ length: 25 }, () => claimFakeSessionId(dir));
    expect(new Set(ids).size).toBe(ids.length);
  });

  // A card that starts FRESH after a relaunch must not be handed the id the
  // previous launch's card is still pointing at from the workspace file: that
  // is the same two-cards-one-conversation state at one remove, and it is
  // exactly what #539's repair sweep would then try to untangle.
  it('keeps counting across app launches, because the markers persist', () => {
    claimFakeSessionId(dir);
    claimFakeSessionId(dir);
    expect(claimFakeSessionId(dir)).toBe(fakeSessionId(2));
  });

  it('creates the directory it was pointed at', () => {
    const nested = path.join(dir, 'a', 'b', '.fake-stream-ids');
    expect(claimFakeSessionId(nested)).toBe(fakeSessionId(0));
    expect(fs.existsSync(nested)).toBe(true);
  });

  // Fail-open, like the rest of the fake: a directory it cannot use must not
  // take the session down. Falling back to the shared constant is precisely the
  // behaviour that shipped before this function existed.
  it('falls back to the first id rather than throwing', () => {
    const notADir = path.join(dir, 'file');
    fs.writeFileSync(notADir, 'not a directory');
    expect(claimFakeSessionId(path.join(notADir, 'ids'))).toBe(FAKE_SESSION_ID);
  });
});
