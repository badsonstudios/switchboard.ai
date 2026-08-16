// The declarations that make an element INVISIBLE rather than absent.
//
// A live region has to be in the DOM before its news arrives, or nothing is
// announced (#253, #358, and P2-E14-01's events drawer, which learned it the
// expensive way: collapsing the panel by default took all three notice tenants
// out of the tree, so a screen reader stopped hearing about updates entirely).
// `display: none` and `visibility: hidden` both remove an element from the
// accessibility tree, which is why this is the clip-path idiom instead.
//
// EXTRACTED ON THE THIRD COPY, exactly as #367 said to: SessionsRail (#253) and
// SessionGrid (#358) each carried these six lines inline under a comment
// pledging that a third would become a module. `EventsDrawer` was the third.
//
// `whiteSpace: nowrap` matters and is not decoration — without it a 1px box
// wraps its text to one character per line, which some screen readers read out
// letter by letter.
import React from 'react';

export const srOnly: React.CSSProperties = {
  position: 'absolute',
  inlineSize: 1,
  blockSize: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};
