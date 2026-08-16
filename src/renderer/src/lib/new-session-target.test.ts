import { describe, it, expect } from 'vitest';
import { newSessionHostGroup, type DockGroupLike } from './new-session-target';

const g = (id: string, isPopout: boolean, focused: boolean): DockGroupLike => ({
  id,
  isPopout,
  focused,
});

describe('newSessionHostGroup — which window a new session lands in (#531)', () => {
  it('answers the main window when there are no popouts at all', () => {
    expect(newSessionHostGroup([g('grid-1', false, false), g('grid-2', false, false)])).toBeNull();
  });

  it('answers the main window when there is nothing open anywhere', () => {
    expect(newSessionHostGroup([])).toBeNull();
  });

  it('answers the popout the user is actually looking at', () => {
    const target = g('pop-2', true, true);
    expect(newSessionHostGroup([g('grid-1', false, false), g('pop-1', true, false), target])).toBe(
      target
    );
  });

  it('refuses a popout that is merely OPEN', () => {
    // the #434/#462 rule, restated: a popped-out window sitting behind the main
    // one is not where a keystroke typed in the main window belongs
    expect(newSessionHostGroup([g('pop-1', true, false), g('grid-1', false, false)])).toBeNull();
  });

  it('never answers a grid group, focused or not', () => {
    // a grid group's window IS the main window, and the main window's
    // placement is `sessionCardHome`'s question — the fallback exists so this
    // module never has to have an opinion about it
    expect(newSessionHostGroup([g('grid-1', false, true)])).toBeNull();
  });

  it('picks one when focus is somehow reported twice', () => {
    // focus is sampled, not transactional. Two yeses in one tick must not
    // throw at a user who pressed Mod+N; the first is as good as any.
    const first = g('pop-1', true, true);
    expect(newSessionHostGroup([first, g('pop-2', true, true)])).toBe(first);
  });
});
