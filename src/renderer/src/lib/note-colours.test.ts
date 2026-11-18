// #1601: the notes' picked colours as the window keeps them. The ink maths
// is `shared/note-colour-math.test.ts`'s. Sample colours come from the group
// palette, so no colour is written out here.
import { beforeEach, describe, expect, it } from 'vitest';
import { GROUP_PALETTE } from '../../../shared/group-palette';
import {
  NOTE_COLOURS_KEY,
  contrast,
  initNoteColours,
  noteColoursOf,
  noteVars,
  resetNoteColoursForTests,
  setNoteColour,
  useNoteColours,
} from './note-colours';
import { uiDelete, uiGet, uiSet } from './ui-state';

const [A, B] = GROUP_PALETTE.map((c) => c.toLowerCase());

describe('the picked colours, stored (#1601)', () => {
  beforeEach(() => {
    uiDelete([NOTE_COLOURS_KEY]);
    resetNoteColoursForTests();
  });

  it("defaults to today's colours: nothing is picked and no variable is set", () => {
    expect(noteColoursOf(undefined)).toEqual({});
    expect(noteVars('waiting', {})).toEqual({});
    expect(noteVars('session', {})).toEqual({});
  });

  it('keeps only well-formed colours from a stored blob', () => {
    expect(noteColoursOf({ waiting: A.toUpperCase(), session: 'green' })).toEqual({ waiting: A });
    expect(noteColoursOf('nope')).toEqual({});
  });

  it('a pick sets the fill and its inks; the waiting note keeps its yellow edge', () => {
    const w = noteVars('waiting', { waiting: A }) as Record<string, string>;
    expect(w['--waiting-paper']).toBe(A);
    expect(contrast(w['--waiting-ink'], A)).toBeGreaterThanOrEqual(4.5);
    // the edge is drawn from --status-needs-input, which no pick sets
    expect(Object.keys(w)).not.toContain('--status-needs-input');
    const s = noteVars('session', { session: B }) as Record<string, string>;
    expect(s['--note-paper']).toBe(B);
    expect(s['--note-ai-ink']).toBe(s['--note-ink']);
  });

  it('stores each kind separately, and reset forgets just that one', () => {
    setNoteColour('waiting', A);
    setNoteColour('session', B.toUpperCase());
    expect(uiGet(NOTE_COLOURS_KEY, undefined)).toEqual({ waiting: A, session: B });
    setNoteColour('waiting', null);
    expect(uiGet(NOTE_COLOURS_KEY, undefined)).toEqual({ session: B });
  });

  it('reads what was stored when the window starts', () => {
    uiSet(NOTE_COLOURS_KEY, { session: B });
    initNoteColours();
    expect(useNoteColours).toBeTypeOf('function');
    setNoteColour('waiting', A);
    expect(uiGet(NOTE_COLOURS_KEY, undefined)).toEqual({ session: B, waiting: A });
  });
});
