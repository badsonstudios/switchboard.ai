// What the three chord families say, and when (#581).
//
// The sentence IS the product of this item: it has no pixels, no layout and no
// button, so "it renders" proves nothing and the words are the only thing a user
// ever receives. Two halves, and both matter for a different reason:
//
//   • THE WORDS, against the real `en.json` through the real ICU chain. A key
//     written `{{title}}` renders its braces verbatim to the user and every
//     mustache-era harness was green while doing it (#207) — `test-i18n.ts` says
//     why there is one way to initialise i18next and this is it.
//   • WHEN. Each family learns its outcome differently — two synchronously, one
//     only when the store says so — and the failure mode of getting that wrong is
//     an announcement that is confidently false, which §5.32's own note calls
//     worse than silence.
import { describe, it, expect, beforeEach } from 'vitest';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import {
  ladderSaid,
  pinSaid,
  reorderSaid,
  sayPinToggled,
  sayReordered,
  stepLadderAloud,
  type Translate,
} from './session-voice';
import { announce, resetAnnouncementsForTest, subscribeAnnouncements } from './live-region';
import { LADDER_ORDER } from './ladder';
import type { Ladder } from './presentation';
import { sessionStore } from '../store/session-store';
import type { RailGroup, RailSession } from '../model/types';

const t: Translate = (key, vars) => String(i18next.t(key, vars));

/** everything said during one case, in order */
let heard: string[] = [];

/** let the ladder's promise chain settle — it announces in a microtask, because
 *  the truth about a rung is only available once the transition is over */
const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

// `sessionStore` is a module singleton and card ids are uuids in the app, so each
// case mints its own rather than sharing "c1" with the case before it.
let n = 0;
const card = (): string => `card-${n++}`;

const session = (id: string, title = id, over: Partial<RailSession> = {}): RailSession => ({
  id,
  title,
  folder: `C:/Projects/${title}`,
  status: 'idle',
  ...over,
});

beforeEach(async () => {
  await initI18nForTests();
  resetAnnouncementsForTest();
  heard = [];
  subscribeAnnouncements((text) => heard.push(text));
  sessionStore.setSessions([]);
  sessionStore.setGroups([]);
});

describe('the words, through the real ICU chain', () => {
  it('says the pin STATE, not the gesture', () => {
    expect(pinSaid(t, 'switchboard', true)).toBe('switchboard pinned');
    expect(pinSaid(t, 'switchboard', false)).toBe('switchboard unpinned');
  });

  it('names the position for a move, in the menu path\u2019s own sentence', () => {
    // `rail.reordered` VERBATIM: §5.32's "never a parallel path that can drift"
    // is about the words as much as about the write, and the rail's menu has been
    // speaking this one since #559
    const said = reorderSaid(t, {
      title: 'switchboard',
      group: 'Work',
      position: 2,
      count: 5,
      moved: true,
    });
    expect(said).toBe('switchboard is now 2 of 5 in Work');
    expect(said).toBe(
      t('rail.reordered', { title: 'switchboard', position: 2, count: 5, group: 'Work' })
    );
  });

  it('names the position for a REFUSED move too', () => {
    // the menu dims an unavailable step and a screen reader reads it as
    // unavailable (#559). A chord has no such affordance, so silence at the top
    // of a list is indistinguishable from a dead keybinding.
    expect(
      reorderSaid(t, { title: 'switchboard', group: 'Work', position: 1, count: 5, moved: false })
    ).toBe('switchboard is still 1 of 5 in Work');
  });

  it('gives every rung words a person would use', () => {
    expect(ladderSaid(t, 'switchboard', 'expanded')).toBe('switchboard expanded');
    expect(ladderSaid(t, 'switchboard', 'collapsed')).toBe('switchboard collapsed to the strip');
    expect(ladderSaid(t, 'switchboard', 'tabbed')).toBe(
      'switchboard stacked with the tabbed sessions'
    );
    expect(ladderSaid(t, 'switchboard', 'hidden')).toBe('switchboard hidden');
  });

  it('has words for EVERY rung the ladder defines, not just the four listed above', () => {
    // driven off `LADDER_ORDER` rather than a hand-written list, because
    // `ladder.rung.${rung}` is a dynamic key: a fifth rung would ship a missing
    // one, and i18next renders a missing key as the key itself — a screen reader
    // reading out "ladder.rung.floating" to the user
    expect(LADDER_ORDER.length).toBeGreaterThan(0);
    for (const rung of LADDER_ORDER) {
      const said = ladderSaid(t, 'switchboard', rung);
      expect(said, `no words for the '${rung}' rung`).not.toContain('ladder.rung');
      expect(said).toContain('switchboard');
      expect(said).not.toBe('switchboard '); // a key that resolved to nothing
    }
  });

  it('says "already" when the step had nowhere to go', () => {
    expect(ladderSaid(t, 'switchboard', 'hidden', false)).toBe('switchboard is already hidden');
  });

  it('leaves no placeholder unexpanded in any of them', () => {
    // the #207 defect, caught at the one layer that sees the real catalog AND the
    // real interpolator: a brace reaching this assertion reached the user
    const all = [
      pinSaid(t, 'x', true),
      pinSaid(t, 'x', false),
      reorderSaid(t, { title: 'x', group: 'g', position: 1, count: 2, moved: true }),
      reorderSaid(t, { title: 'x', group: 'g', position: 1, count: 2, moved: false }),
      ladderSaid(t, 'x', 'expanded'),
      ladderSaid(t, 'x', 'collapsed'),
      ladderSaid(t, 'x', 'tabbed'),
      ladderSaid(t, 'x', 'hidden'),
      ladderSaid(t, 'x', 'hidden', false),
    ];
    for (const s of all) {
      expect(s).not.toMatch(/[{}]/);
      // a missing key renders as the key itself, which is the other silent failure
      expect(s).not.toMatch(/^(rail|ladder)\./);
    }
  });
});

describe('Mod+Alt+P — the pin', () => {
  it('reads the state back out of the store rather than assuming a flip', () => {
    // synchronous write, so the store already holds the answer — and reading it
    // is what makes this true of a pin something ELSE changed in between
    const c = card();
    sessionStore.setSessions([session(c, 'switchboard')]);

    sessionStore.togglePin(c);
    sayPinToggled(c);
    expect(heard).toEqual(['switchboard pinned']);

    sessionStore.togglePin(c);
    sayPinToggled(c);
    expect(heard).toEqual(['switchboard pinned', 'switchboard unpinned']);
  });

  it('says nothing about a card the rail has never heard of', () => {
    // the rail's "the row is gone: drop the whole errand". A ghost announcement
    // names a session the user cannot find.
    sayPinToggled(card());
    expect(heard).toEqual([]);
  });
});

describe('Mod+Alt+Arrow — the rail order', () => {
  const group: RailGroup = { id: 'g1', name: 'Work', color: 'var(--faint)' };

  it('announces the position the store settled on', () => {
    const [a, b, c] = [card(), card(), card()];
    sessionStore.setGroups([group]);
    sessionStore.setSessions([
      session(a, 'alpha', { groupId: 'g1' }),
      session(b, 'bravo', { groupId: 'g1' }),
      session(c, 'charlie', { groupId: 'g1' }),
    ]);

    const moved = sessionStore.reorderSession(a, 1);
    sayReordered(a, moved);

    expect(moved).toBe(true);
    expect(heard).toEqual(['alpha is now 2 of 3 in Work']);
  });

  it('announces the position it is STILL in when the step was refused', () => {
    const [a, b] = [card(), card()];
    sessionStore.setGroups([group]);
    sessionStore.setSessions([
      session(a, 'alpha', { groupId: 'g1' }),
      session(b, 'bravo', { groupId: 'g1' }),
    ]);

    const moved = sessionStore.reorderSession(a, -1); // already first
    sayReordered(a, moved);

    expect(moved).toBe(false);
    expect(heard).toEqual(['alpha is still 1 of 2 in Work']);
  });

  it('calls the loose bucket what the rail calls it', () => {
    const [a, b] = [card(), card()];
    sessionStore.setSessions([session(a, 'alpha'), session(b, 'bravo')]);

    sayReordered(a, sessionStore.reorderSession(a, 1));
    expect(heard).toEqual(['alpha is now 2 of 2 in Ungrouped']);
  });

  it('names an auto-group by its leaf, the way its own card header does', () => {
    // two sessions in one folder cluster on their own (E12-05), and the bucket key
    // is the whole path — reading that out would be a sentence nobody can follow
    const [a, b] = [card(), card()];
    const folder = 'C:/Projects/shared-repo';
    sessionStore.setSessions([
      session(a, 'alpha', { folder }),
      session(b, 'bravo', { folder }),
    ]);

    sayReordered(a, sessionStore.reorderSession(a, 1));
    expect(heard).toEqual(['alpha is now 2 of 2 in shared-repo']);
  });

  it('stays silent about a card that has left the rail', () => {
    sayReordered(card(), true);
    expect(heard).toEqual([]);
  });
});

describe('Mod+Shift+Arrow — the ladder', () => {
  /** a card sitting on a rung, ready to be stepped */
  const on = (rung: Ladder, title = 'switchboard'): string => {
    const c = card();
    sessionStore.setSessions([session(c, title)]);
    sessionStore.setPresentation(c, { ladder: rung });
    return c;
  };

  it('announces the rung the transition settled on, once it is over', async () => {
    // `stepCardLadder` resolves when the move is FINISHED, so the rung read here
    // is the one the store committed to
    const c = on('expanded');
    stepLadderAloud(c, 'down', async () => {
      await Promise.resolve(); // the dockview half, as a round trip
      sessionStore.setPresentation(c, { ladder: 'collapsed' });
    });
    await flush();
    expect(heard).toEqual(['switchboard collapsed to the strip']);
  });

  it('claims nothing while the transition is still in flight', async () => {
    const c = on('hidden');
    let land = (): void => {};
    stepLadderAloud(c, 'up', () => new Promise<void>((res) => (land = res)));
    await flush();
    expect(heard).toEqual([]); // nothing said yet

    sessionStore.setPresentation(c, { ladder: 'tabbed' });
    land();
    await flush();
    expect(heard).toEqual(['switchboard stacked with the tabbed sessions']);
  });

  it('announces where it ENDED, not what the key asked for', async () => {
    // `toTabbed` can land somewhere else entirely, and a predicted rung would be
    // a confident lie — which §5.32 calls worse than saying nothing
    const c = on('hidden');
    stepLadderAloud(c, 'up', () => {
      sessionStore.setPresentation(c, { ladder: 'expanded' }); // not 'tabbed'
    });
    await flush();
    expect(heard).toEqual(['switchboard expanded']);
  });

  it('SAYS SO when the transition moved nothing at all', async () => {
    // THE CASE THAT REWROTE THIS FUNCTION. `moveCardToRung` bails without writing
    // a rung when a transition is already in flight for that card, and `toTabbed`
    // bails when the card's record vanishes under it. The first version watched
    // the STORE for a rung change, so a bail left a listener armed for good — and
    // the next rung change from anywhere (the strip row, the card header, a layout
    // sweep moving a dozen cards) was then announced as this keypress's outcome.
    // Waiting on the command's own promise ends the errand either way.
    const c = on('collapsed');
    stepLadderAloud(c, 'up', () => {
      /* refused: laddering guard. Nothing is written. */
    });
    await flush();
    expect(heard).toEqual(['switchboard is already collapsed to the strip']);

    // ...and nothing is left listening: a later rung change is NOT attributed to
    // the keypress above
    heard = [];
    sessionStore.setPresentation(c, { ladder: 'tabbed' });
    sessionStore.setPresentation(c, { ladder: 'hidden' });
    await flush();
    expect(heard).toEqual([]);
  });

  it('says "already" for the end of the ladder, before the command even runs', async () => {
    // pure functions decide this: a step that reaches the rung it started on
    // cannot be anything but a no-op, so there is nothing to wait for
    const c = on('hidden');
    stepLadderAloud(c, 'down', () => {}); // hidden is the bottom
    expect(heard).toEqual(['switchboard is already hidden']); // synchronous

    sessionStore.setPresentation(c, { ladder: 'expanded' });
    heard = [];
    stepLadderAloud(c, 'up', () => {}); // expanded is the top
    expect(heard).toEqual(['switchboard is already expanded']);
  });

  it('uses the name the session has NOW, not the one it had when the key went down', async () => {
    const c = on('hidden', 'old name');
    stepLadderAloud(c, 'up', () => {
      sessionStore.setSessions([session(c, 'renamed mid-move')]);
      sessionStore.setPresentation(c, { ladder: 'tabbed' });
    });
    await flush();
    expect(heard).toEqual(['renamed mid-move stacked with the tabbed sessions']);
  });

  it('drops the errand when the session ends mid-move', async () => {
    // the rail's guard, for the rail's reason: the announcement would name a
    // session that is no longer anywhere the user can look
    const c = on('hidden');
    stepLadderAloud(c, 'up', () => {
      sessionStore.setPresentation(c, { ladder: 'tabbed' }); // it landed...
      sessionStore.setSessions([]); // ...and then the session ended
    });
    await flush();
    expect(heard).toEqual([]);
  });

  it('runs the command even for a card the rail has forgotten', async () => {
    // the VOICE is the optional half. A missing title must not swallow the
    // keystroke — fail-open (PHILOSOPHY §3): our breakage never blocks a session.
    let ran = 0;
    stepLadderAloud(card(), 'down', () => {
      ran++;
    });
    await flush();
    expect(ran).toBe(1);
    expect(heard).toEqual([]);
  });

  it('reports the state a FAILED command left behind, and never rejects', async () => {
    // Two claims, and the second one needs its own listener to be worth anything:
    // `expect(heard)` alone is satisfied with the catch deleted, and the only thing
    // that would go red is vitest's file-level unhandled-rejection report — which
    // gets attributed to whichever test happens to be running.
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const c = on('expanded');
      stepLadderAloud(c, 'down', () => Promise.reject(new Error('dockview said no')));
      await flush();
      // the command failed, so the card did not move — and that is what it says,
      // rather than going silent on a keypress the user made
      expect(heard).toEqual(['switchboard is already expanded']);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it('reports the rung a command wrote before it threw', async () => {
    // the other half of the same argument: a throw AFTER the write still moved the
    // card, so the store — not the promise's fate — decides what is said
    const c = on('expanded');
    stepLadderAloud(c, 'down', () => {
      sessionStore.setPresentation(c, { ladder: 'collapsed' });
      return Promise.reject(new Error('threw on the way out'));
    });
    await flush();
    expect(heard).toEqual(['switchboard collapsed to the strip']);
  });

  it('a throwing subscriber never becomes an unhandled rejection out of the chord', async () => {
    // The whole path, fail-open end to end: `announce` catches the subscriber and
    // the chain's trailing catch is there for anything left (a malformed ICU string
    // building the sentence, which cannot be provoked from here without mocking the
    // catalog). Either way a keydown handler must not leave a rejection behind.
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on('unhandledRejection', onRejection);
    try {
      resetAnnouncementsForTest();
      subscribeAnnouncements(() => {
        throw new Error('a listener with a bug');
      });
      const c = on('expanded');
      stepLadderAloud(c, 'down', () => {
        sessionStore.setPresentation(c, { ladder: 'collapsed' });
      });
      await flush();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
  });
});

describe('the announcer is not this module\u2019s private channel', () => {
  it('shares the region with anything else that ever needs it', () => {
    // #581's brief was a GLOBAL region, not a chord-specific one: the next
    // keyboard gesture with no surface of its own should not need a second
    announce('some other surface, later');
    expect(heard).toEqual(['some other surface, later']);
  });
});
