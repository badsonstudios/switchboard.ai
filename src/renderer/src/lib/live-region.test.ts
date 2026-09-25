// The channel half of #581. Small surface, three properties worth pinning —
// each one is a way the announcer could go quiet without a single test failing.
import { describe, it, expect, beforeEach } from 'vitest';
import { announce, resetAnnouncementsForTest, subscribeAnnouncements } from './live-region';

beforeEach(() => resetAnnouncementsForTest());

describe('the global announcer', () => {
  it('reaches every listener', () => {
    // per-window, not per-surface: a second listener is how a popped-out window
    // or a future surface joins without a registry
    const a: string[] = [];
    const b: string[] = [];
    subscribeAnnouncements((t) => a.push(t));
    subscribeAnnouncements((t) => b.push(t));

    announce('Work is now 2 of 5 in Projects');

    expect(a).toEqual(['Work is now 2 of 5 in Projects']);
    expect(b).toEqual(a);
  });

  it('stops after the unsubscribe', () => {
    const heard: string[] = [];
    const off = subscribeAnnouncements((t) => heard.push(t));
    announce('one');
    off();
    announce('two');
    expect(heard).toEqual(['one']);
  });

  it('drops the empty string rather than passing it on', () => {
    // "announce nothing" is the absence of a call. Letting '' through would CLEAR
    // whichever region is mid-sentence, which is worse than silence: it truncates
    // the announcement the user is currently being read.
    const heard: string[] = [];
    subscribeAnnouncements((t) => heard.push(t));
    announce('');
    expect(heard).toEqual([]);
  });

  it('survives a listener that unsubscribes itself mid-announcement', () => {
    // the iteration is over a copy for exactly this: a listener removing itself
    // must not make the fan-out skip the one after it
    const heard: string[] = [];
    const off = subscribeAnnouncements(() => off());
    subscribeAnnouncements((t) => heard.push(t));
    announce('still said');
    expect(heard).toEqual(['still said']);
  });

  it('lets one broken listener cost only itself', () => {
    // fail-open (PHILOSOPHY §3): our announcer must never be the reason a
    // keystroke throws. Today the store's own notify loop has this property and
    // this is the assertion that says the announcer needs it too.
    const heard: string[] = [];
    subscribeAnnouncements(() => {
      throw new Error('a subscriber with a bug');
    });
    subscribeAnnouncements((t) => heard.push(t));
    expect(() => announce('said anyway')).not.toThrow();
    expect(heard).toEqual(['said anyway']);
  });

  it('says nothing when nobody is listening', () => {
    // the command deps call this unconditionally, including in tests that never
    // mount the region — a throw here would be a keystroke that died
    expect(() => announce('into the void')).not.toThrow();
    // ...and a listener added afterwards does not receive the backlog: this is a
    // live region, not a message queue, and replaying a stale sentence at whoever
    // mounts next is how a popout opens by reading out what happened before it
    const heard: string[] = [];
    subscribeAnnouncements((t) => heard.push(t));
    expect(heard).toEqual([]);
  });
});
