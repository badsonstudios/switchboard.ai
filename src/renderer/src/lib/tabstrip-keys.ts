// Keyboard navigation for the card's view-tab strip (#197, §5.26
// "keyboard-complete"). Pure — SessionGrid applies the result against the real
// DOM; the tests pin the semantics.
//
// WHY A TABLIST HERE AND PLAIN BUTTONS EVERYWHERE ELSE IN THIS SWEEP
//
// #174 established the rule the sweep follows: pick the role that is TRUE, and
// where no true role permits a composite widget, ship plain buttons. The view
// strip is the one surface in #197 where the composite role is the honest one —
// Session / Terminal / Changes select which single panel is shown, which is
// literally what `tablist` / `tab` / `tabpanel` mean. Declaring it therefore
// costs nothing in honesty and buys the announcement ("tab, 2 of 4, selected")
// plus the arrow-key convention users already have.
//
// It also OBLIGES the roving tabindex: a tablist promises exactly one tab stop
// with arrows inside it, and a tablist whose tabs are each a tab stop is the
// same broken promise the strip's sibling comment in UrgencyStrip.tsx refused
// to make. This module is that promise, made keepable.
//
// MANUAL ACTIVATION, not automatic. APG allows either, and points at exactly
// our case for the manual one: arrowing onto a tab must not MOUNT its panel.
// Changes builds a Monaco diff and History reads the transcript off disk, so
// automatic activation would make a walk from Session to History spin up two
// panels the user was only passing through. Arrows move focus; Enter or Space
// selects.

/** What a keystroke inside the tab strip means, or `null` for "not ours". */
export type TabStripAction =
  /** move focus to the tab at this index (0-based, DOM order) */
  | { kind: 'focus'; index: number }
  /** activate the tab that currently has focus */
  | { kind: 'activate' };

export interface TabStripState {
  /** how many tabs the strip is showing, disabled ones included */
  count: number;
  /** index of the focused tab (0-based) */
  current: number;
}

/**
 * Resolve a keystroke against the strip, or `null` for "let the browser have
 * it".
 *
 * Arrows WRAP, unlike the feed's (#174) which stop at the ends. The two are
 * different on purpose: the feed's list is a scroller, so ArrowDown at the
 * bottom has a better job to do than wrapping, while a tab strip is a closed
 * ring of four items with nothing behind it — APG specifies the wrap, and
 * stopping dead at "Changes" would just be a key that does nothing.
 *
 * Home/End are absolute, and are `null` on an empty strip rather than a move to
 * a tab that isn't there.
 */
export function tabStripAction(key: string, state: TabStripState): TabStripAction | null {
  const { count, current } = state;
  if (count <= 0) return null;
  // a `current` outside the strip is treated as "before the first tab", so the
  // first arrow lands somewhere sane instead of computing a negative modulo
  const at = current >= 0 && current < count ? current : 0;

  switch (key) {
    case 'ArrowRight':
      return { kind: 'focus', index: (at + 1) % count };
    case 'ArrowLeft':
      return { kind: 'focus', index: (at - 1 + count) % count };
    case 'Home':
      return { kind: 'focus', index: 0 };
    case 'End':
      return { kind: 'focus', index: count - 1 };
    // Real `<button>`s already activate on both of these; the strip claims them
    // anyway so the keystroke cannot ALSO scroll the card (Space) while it
    // selects. Returning the action rather than swallowing it keeps the caller
    // in charge of what "activate" costs.
    case 'Enter':
    case ' ':
      return { kind: 'activate' };
    default:
      return null;
  }
}
