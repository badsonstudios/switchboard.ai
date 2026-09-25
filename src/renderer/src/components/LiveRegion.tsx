// The DOM half of #581's announcer — mounted once per window, at the app root.
//
// TWO REGIONS, AND THE SECOND ONE IS NOT DECORATION. A live region announces on
// MUTATION, so writing the same string into the same region twice announces it
// once: the second write changes nothing. That is not a corner case here, it is
// the end of every list — `Mod+Alt+ArrowUp` pressed again on the top row, or
// `Mod+Shift+ArrowDown` on a card already at the bottom rung, produces the same
// sentence over and over, and a user who hears it once has no way to tell whether
// the key registered. So each announcement goes into whichever region is empty
// and clears the other, which makes every write a genuine empty → text change.
// (PRESSED, not held: `lib/commands` drops a keydown carrying `repeat`, so
// autorepeat never reaches a command in the first place.)
//
// BOTH ARE IN THE DOM FROM THE FIRST FRAME and both start empty, which is the
// same rule the rail's region (#253) and the events drawer's notices (#222, #358,
// P2-E14-01) each had to learn: a region that is INSERTED already holding its
// text is announced by almost nothing. Always-mounted-and-empty is right for this
// one specifically because it has no content of its own to be conditional on —
// it is a channel, not a notice.
//
// `srOnly` rather than `display: none`, for the reason that module exists:
// display and visibility both take an element out of the accessibility tree,
// which would make this an elaborate way to say nothing.
import React from 'react';
import { subscribeAnnouncements } from '../lib/live-region';
import { srOnly } from './sr-only';

/** The two slots: at most one of them holds text at any moment. */
type Slots = readonly [string, string];

/**
 * A QUEUE PLUS THE SLOTS, IN ONE PIECE OF STATE, and the "one piece" is the
 * correctness argument rather than tidiness.
 *
 * The queue exists because the alternation is a function of what is already
 * RENDERED: two announcements inside one React commit would both be handed the
 * same "which region is free" answer, and the second would overwrite the first
 * before it had ever been in the DOM — a sentence dropped silently, which is the
 * failure this whole component exists to prevent.
 *
 * Holding the two halves apart reintroduced a smaller version of exactly that.
 * Draining with `setPending(rest)` writes a value computed from a RENDER-SCOPE
 * snapshot, so anything enqueued earlier in the same batch is discarded — and
 * "unreachable because this component's effect happens to run before its
 * siblings'" is an ordering invariant nothing states and no test holds. Together,
 * every write is one functional update over one atomic value.
 */
interface Voice {
  readonly pending: readonly string[];
  readonly slots: Slots;
}

const SILENT: Voice = { pending: [], slots: ['', ''] };

export function LiveRegion(): React.JSX.Element {
  const [voice, setVoice] = React.useState<Voice>(SILENT);

  React.useEffect(() => {
    return subscribeAnnouncements((text) => {
      setVoice((v) => ({ ...v, pending: [...v.pending, text] }));
    });
  }, []);

  // One per commit: each flush is an empty -> text change in a region that was
  // empty, which is the mutation a screen reader announces.
  React.useEffect(() => {
    if (voice.pending.length === 0) return;
    setVoice((v) => {
      if (v.pending.length === 0) return v; // drained by a concurrent pass
      const [next, ...rest] = v.pending;
      const [a] = v.slots;
      return { pending: rest, slots: a ? ['', next] : [next, ''] };
    });
  }, [voice]);

  return (
    <>
      <div role="status" aria-live="polite" data-live-region="a" style={srOnly}>
        {voice.slots[0]}
      </div>
      <div role="status" aria-live="polite" data-live-region="b" style={srOnly}>
        {voice.slots[1]}
      </div>
    </>
  );
}
