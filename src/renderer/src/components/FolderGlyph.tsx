// The folder mark of an AUTOMATIC group (E12-05).
//
// Its own file since #1143, when a second surface needed it: the rail's group
// card and the strip's group entry both have to say "this one is a directory,
// and the app made it, not you", and they have to say it with the same mark.
// Solid, in whatever colour the caller sets, at the size a made group's dot
// occupies.
import React from 'react';

export function FolderGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden>
      <path d="M1.9 4.1c0-.6.5-1.1 1.1-1.1h2.7c.35 0 .68.17.88.46l.7 1.04h6c.6 0 1.1.5 1.1 1.1v6c0 .6-.5 1.1-1.1 1.1H3c-.6 0-1.1-.5-1.1-1.1V4.1Z" />
    </svg>
  );
}
