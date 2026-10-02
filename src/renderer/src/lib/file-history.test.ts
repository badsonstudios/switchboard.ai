// "Show me this file's history" (E24 Git v2 item 10).
//
// The seam, tested as a seam. It exists because the gesture STARTS in one tab and
// LANDS in another — card tabs are mutually exclusive — and `PanelContext` carries
// no way to switch views. So the interesting behaviour is not the filter, it is
// what survives the Changes tab being unmounted on the way.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  canShowFileHistory,
  clearFileHistory,
  fileHistoryRequest,
  forgetCardFileHistory,
  requestFileHistory,
  resetFileHistory,
  setFileHistoryOpener,
  subscribeFileHistory,
} from './file-history';

describe('the file-history seam', () => {
  beforeEach(() => resetFileHistory());

  it('pins a path to a card and switches its view (the done-when)', () => {
    const switched: string[] = [];
    setFileHistoryOpener((cardId) => switched.push(cardId));
    expect(requestFileHistory('card-1', '/proj', 'src/a.ts')).toBe(true);
    expect(switched).toEqual(['card-1']);
    expect(fileHistoryRequest('card-1', '/proj')).toEqual({ folder: '/proj', path: 'src/a.ts' });
  });

  it('⚠️ the request SURVIVES the tab that made it being unmounted', () => {
    // The whole reason this is a module and not component state: ⏱ is on a
    // Changes-tab row, and the Changes tab is gone the instant the view switches.
    setFileHistoryOpener(() => undefined);
    requestFileHistory('card-1', '/proj', 'a.ts');
    // nothing re-registers, nothing re-renders — the answer is still there
    expect(fileHistoryRequest('card-1', '/proj')?.path).toBe('a.ts');
  });

  it('⚠️ THE FOLDER IS CHECKED, not just the card', () => {
    // A card's folder can change — a session resumed somewhere else — and a
    // request left over from the old one would filter the NEW repository by a path
    // that means nothing in it: an empty history with a chip blaming a file that
    // is not there.
    setFileHistoryOpener(() => undefined);
    requestFileHistory('card-1', '/old', 'a.ts');
    expect(fileHistoryRequest('card-1', '/old')?.path).toBe('a.ts');
    expect(fileHistoryRequest('card-1', '/new')).toBeNull();
  });

  it('⚠️ A STALE PIN IS DROPPED, NOT MERELY HIDDEN — it must not resurrect', () => {
    // ⚠️ **THE BUG THIS PINS (found in review).** Returning `null` on a folder
    // mismatch while LEAVING the entry in the map made the pin unreachable but
    // alive: the chip correctly vanishes, so the user cannot clear something they
    // cannot see — and if the session is later resumed back in the original
    // folder the History tab silently re-pins itself to a file nobody clicked.
    setFileHistoryOpener(() => undefined);
    requestFileHistory('card-1', '/old', 'a.ts');
    // the card moves…
    expect(fileHistoryRequest('card-1', '/new')).toBeNull();
    // …and moving BACK does not bring the pin with it.
    expect(fileHistoryRequest('card-1', '/old')).toBeNull();
  });

  it('a closed card is forgotten, so the map does not grow for the renderer’s life', () => {
    setFileHistoryOpener(() => undefined);
    requestFileHistory('card-1', '/proj', 'a.ts');
    requestFileHistory('card-2', '/proj', 'b.ts');
    forgetCardFileHistory('card-1');
    expect(fileHistoryRequest('card-1', '/proj')).toBeNull();
    // …and only that card: the grid calls this per closed card.
    expect(fileHistoryRequest('card-2', '/proj')?.path).toBe('b.ts');
    expect(() => forgetCardFileHistory(undefined)).not.toThrow();
  });

  it('one request per card, and cards do not share', () => {
    setFileHistoryOpener(() => undefined);
    requestFileHistory('card-1', '/proj', 'a.ts');
    requestFileHistory('card-2', '/proj', 'b.ts');
    expect(fileHistoryRequest('card-1', '/proj')?.path).toBe('a.ts');
    expect(fileHistoryRequest('card-2', '/proj')?.path).toBe('b.ts');
    // asking again for the same card REPLACES, because one card has one tab
    requestFileHistory('card-1', '/proj', 'c.ts');
    expect(fileHistoryRequest('card-1', '/proj')?.path).toBe('c.ts');
  });

  it('the chip’s ✕ unpins, and notifies', () => {
    setFileHistoryOpener(() => undefined);
    let seen = 0;
    subscribeFileHistory(() => void seen++);
    requestFileHistory('card-1', '/proj', 'a.ts');
    expect(seen).toBe(1);
    clearFileHistory('card-1');
    expect(seen).toBe(2);
    expect(fileHistoryRequest('card-1', '/proj')).toBeNull();
    // clearing nothing notifies nothing — a no-op must not re-render every tab
    clearFileHistory('card-1');
    expect(seen).toBe(2);
  });

  it('⚠️ reports FALSE with no opener, so the row draws no ⏱ at all', () => {
    // The owner's rule about a control that does nothing, applied to the one
    // affordance this item adds.
    expect(canShowFileHistory()).toBe(false);
    expect(requestFileHistory('card-1', '/proj', 'a.ts')).toBe(false);
  });

  it('⚠️ an opener that THROWS does not take the surface with it — AND THE REQUEST STANDS', () => {
    // Deliberate: the view switch failed but the pin is still correct, so a user
    // who clicked ⏱ and then switched tabs by hand still gets the answer.
    setFileHistoryOpener(() => {
      throw new Error('the grid exploded');
    });
    expect(requestFileHistory('card-1', '/proj', 'a.ts')).toBe(false);
    expect(fileHistoryRequest('card-1', '/proj')?.path).toBe('a.ts');
  });

  it('refuses the shapes that cannot mean anything', () => {
    setFileHistoryOpener(() => undefined);
    expect(requestFileHistory(undefined, '/proj', 'a.ts')).toBe(false);
    expect(requestFileHistory('card-1', '', 'a.ts')).toBe(false);
    expect(requestFileHistory('card-1', '/proj', '')).toBe(false);
    expect(fileHistoryRequest(undefined, '/proj')).toBeNull();
  });

  it('unsubscribing stops the notifications', () => {
    setFileHistoryOpener(() => undefined);
    let seen = 0;
    const off = subscribeFileHistory(() => void seen++);
    requestFileHistory('card-1', '/proj', 'a.ts');
    off();
    requestFileHistory('card-1', '/proj', 'b.ts');
    expect(seen).toBe(1);
  });
});
