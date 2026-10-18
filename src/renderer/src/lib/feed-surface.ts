// What a block in the conversation may need to know about the session it is
// in (#1235).
//
// A feed block is rendered from its DTO alone: `Block` is memoised on the
// block, and a renderer contribution is `render(b)`. That is right, and it is
// why this is a context and not a new argument: a picture in a reply needs
// the session's FOLDER (a relative path means nothing without it), and
// threading that through every renderer's signature and the memo's comparator
// would touch all of them for one consumer.
//
// The default is "nothing known", and a consumer must do the safe thing with
// it: with no folder a picture is a chip.
import React from 'react';
import type { WrittenPage } from './feed-images';

export interface FeedSurface {
  /** the session's working folder: what a relative path in a reply is relative to */
  folder?: string;
  /**
   * the web pages this conversation wrote or edited, per turn (#1278): the
   * only pages a reply naming one in code type has drawn (`writtenPages`)
   */
  pages?: readonly WrittenPage[];
}

const NOTHING_KNOWN: FeedSurface = Object.freeze({});

export const FeedSurfaceContext = React.createContext<FeedSurface>(NOTHING_KNOWN);

export function useFeedSurface(): FeedSurface {
  return React.useContext(FeedSurfaceContext);
}
