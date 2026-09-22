// #719 — the heartbeat's count of our own children.
//
// Deltas, never absolutes: the counts are process-wide, and any other suite in
// the same worker may be holding children of its own.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { trackChild, liveChildren } from './live-children';

const fakeChild = (): ChildProcess => new EventEmitter() as unknown as ChildProcess;

describe('live-children (#719)', () => {
  it('counts a child from spawn until it exits', () => {
    const before = liveChildren().git;
    const c = fakeChild();
    trackChild('git', c);
    expect(liveChildren().git).toBe(before + 1);
    c.emit('exit', 0, null);
    expect(liveChildren().git).toBe(before);
  });

  it('releases ONCE when error follows exit (a kill that failed after the death)', () => {
    const before = liveChildren().stream;
    const c = fakeChild();
    trackChild('stream', c);
    c.emit('exit', 1, null);
    c.emit('error', new Error('kill EPERM'));
    expect(liveChildren().stream).toBe(before);
  });

  it('releases on error alone (a spawn that failed never exits)', () => {
    const before = liveChildren().oneshot;
    const c = fakeChild();
    trackChild('oneshot', c);
    c.emit('error', new Error('spawn ENOENT'));
    expect(liveChildren().oneshot).toBe(before);
  });

  it('counts kinds apart, and hands out a snapshot rather than the live record', () => {
    const before = liveChildren();
    const c = fakeChild();
    trackChild('git', c);
    const snap = liveChildren();
    expect(snap.git).toBe(before.git + 1);
    expect(snap.stream).toBe(before.stream);
    snap.git = 999;
    expect(liveChildren().git).toBe(before.git + 1);
    c.emit('exit', 0, null);
  });
});
