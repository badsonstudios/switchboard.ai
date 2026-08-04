// Keyboard navigation inside the Session view's conversation (#174, §5.26
// "keyboard-complete"). Pure — FeedView applies these against the real DOM;
// the tests pin the semantics.
//
// WHY A REGION PLUS ARROWS, AND NOT A TAB STOP PER EXPANDER
//
// Every expander in the feed is a real `<button aria-expanded>` (see
// `FeedExpander`), which is what makes the semantics honest: a screen reader
// announces "Bash, Box check, collapsed, button" and its own button quick-nav
// reaches every one of them regardless of tab order. What the buttons must NOT
// do is each claim a Tab stop: a long conversation carries hundreds of them,
// and the prompt composer sits AFTER the conversation in the document — so a
// tab-stop-per-expander would bury the one control the user actually wants
// behind a few hundred presses of Tab.
//
// So the scrolling conversation is ONE tab stop (a labelled `region`), and the
// expanders inside it are `tabindex="-1"`: reached with the arrow keys, which
// is the same shape a message list uses (Slack, Discord). Enter and Space then
// come free — they are real buttons, and the browser activates them.
//
// The rejected alternative was `role="button"` (or a roving tabindex) on the
// BOX itself. That is the ARIA lie #174 was filed over: a tool box contains
// other interactive controls (the Bash IN/OUT expanders), and a `button` may
// not contain them.

/**
 * The contract between the navigation and the renderers: an expander marks
 * itself with this attribute and the arrow keys find it. It lives HERE, next to
 * the keys, rather than in feed-blocks.tsx — a block renderer may ship from any
 * module (§5.23), and what those modules need to know is the contract, not our
 * built-in components.
 *
 * The DOM is the list. It already holds every expander in exactly the order the
 * eye reads them, and blocks stream in and out constantly, so a registry we
 * maintained would only be a second copy to get wrong.
 */
export const FEED_EXPANDER_ATTR = 'data-feed-expander';

/** What a keystroke inside the conversation region means. */
export type FeedKeyAction =
  /** move focus to the expander at this index (0-based, DOM order) */
  | { kind: 'move'; index: number }
  /** hand focus back to the region itself, so the next Tab leaves the feed */
  | { kind: 'exit' };

export interface FeedKeyState {
  /** how many expanders the feed is showing right now */
  count: number;
  /** index of the focused expander, or -1 when focus is on the region itself */
  current: number;
}

/**
 * Resolve a keystroke against the current navigation state, or `null` for
 * "not ours — let the browser have it".
 *
 * `null` is load-bearing at the ENDS of the list: ArrowDown on the last
 * expander returns null so the keystroke falls through and scrolls the
 * conversation, rather than being swallowed into a focus move that changes
 * nothing. A dead key that eats the scroll reads as a broken view.
 */
export function feedKeyAction(key: string, state: FeedKeyState): FeedKeyAction | null {
  const { count, current } = state;
  if (count <= 0) return null;
  const last = count - 1;
  const move = (index: number): FeedKeyAction | null =>
    index === current ? null : { kind: 'move', index };

  switch (key) {
    // Entering from the region (current === -1) is deliberately asymmetric and
    // matches every menu: Down enters at the top, Up enters at the bottom.
    case 'ArrowDown':
      return current < 0 ? move(0) : move(Math.min(current + 1, last));
    case 'ArrowUp':
      return current < 0 ? move(last) : move(Math.max(current - 1, 0));
    case 'Home':
      return current < 0 ? null : move(0);
    case 'End':
      return current < 0 ? null : move(last);
    case 'Escape':
      // only meaningful with focus INSIDE: Escape on the region itself belongs
      // to whatever else may want it (nothing today)
      return current < 0 ? null : { kind: 'exit' };
    default:
      // Enter, Space, Page Up/Down, everything else: the button and the
      // scroller own these, and intercepting them would break both.
      return null;
  }
}
