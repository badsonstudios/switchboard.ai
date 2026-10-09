// The small picture beside a tool's name in the conversation (#757).
//
// The owner asked for an icon after each tool name so a block's kind can be
// spotted by shape, without reading: agent, question, read, shell, and so on.
//
// DRAWN, NOT TYPED. The app's other marks are text glyphs from the locale file,
// and the ticket's first choice was the same. These are inline SVG instead, for
// one reason: they have to be told apart at about 11px and look the same on
// Windows, Linux and macOS, in the main window and a popped-out one. A glyph is
// whatever the fallback font on that machine draws, and the candidates (a
// magnifier, a robot, a plug) are emoji on some and missing on others. Ten
// small paths, no dependency, no icon font.
//
// SHAPE CARRIES IT, NOT COLOUR. Every icon is `currentColor`: it takes the ink
// of the name beside it and no hue of its own, so nothing here can become a new
// meaning for a colour (and none of it can be yellow).
//
// REINFORCEMENT, NOT INFORMATION. The name stays; the icon is `aria-hidden` and
// a screen reader hears exactly what it heard before.
import React from 'react';
import type { ToolIconKind } from '../../../shared/tool-icon';
import { toolIconFor } from '../../../shared/tool-icon';

/** each drawn on a 16×16 grid, stroked, round joins */
const PATHS: Record<ToolIconKind, React.JSX.Element> = {
  // a head and shoulders with an antenna: someone else doing the work
  agent: (
    <>
      <rect x="3.5" y="5.5" width="9" height="7" rx="2" />
      <path d="M8 5.5V3" />
      <circle cx="8" cy="2.5" r="0.6" />
      <path d="M6.2 8.6v1M9.8 8.6v1" />
    </>
  ),
  // a question mark in a speech bubble
  question: (
    <>
      <path d="M2.5 3.5h11v7.5H7l-3 2.5v-2.5H2.5z" />
      <path d="M6.6 6.1a1.5 1.5 0 1 1 2.2 1.3c-.5.3-.8.6-.8 1.1" />
      <path d="M8 10.1v.1" />
    </>
  ),
  // a page with lines
  read: (
    <>
      <path d="M4 2.5h5.5L12 5v8.5H4z" />
      <path d="M9.5 2.5V5H12" />
      <path d="M6 8h4M6 10.5h4" />
    </>
  ),
  // a magnifier
  search: (
    <>
      <circle cx="7" cy="7" r="3.8" />
      <path d="M9.8 9.8L13.5 13.5" />
    </>
  ),
  // a terminal: a prompt and a cursor
  shell: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M4.8 6.5L7 8.2 4.8 9.9" />
      <path d="M8.5 10.2h2.8" />
    </>
  ),
  // a pencil
  edit: (
    <>
      <path d="M3 13l.6-2.8L10.9 2.9a1.1 1.1 0 0 1 1.6 0l.6.6a1.1 1.1 0 0 1 0 1.6L5.8 12.4z" />
      <path d="M9.8 4l2.2 2.2" />
    </>
  ),
  // a ticked list
  todos: (
    <>
      <path d="M2.5 4.2l1.2 1.2 2-2.2" />
      <path d="M8 4.5h5.5" />
      <path d="M2.5 9.7l1.2 1.2 2-2.2" />
      <path d="M8 10h5.5" />
    </>
  ),
  // a globe
  web: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11" />
      <path d="M8 2.5c2 1.8 2 9.2 0 11M8 2.5c-2 1.8-2 9.2 0 11" />
    </>
  ),
  // a plug: something connected from outside
  mcp: (
    <>
      <path d="M5.5 2.5v3M10.5 2.5v3" />
      <path d="M4 5.5h8v2.2a4 4 0 0 1-8 0z" />
      <path d="M8 11.7v2" />
    </>
  ),
  // a spanner-less neutral mark: a small gear-like diamond, "some tool"
  other: (
    <>
      <path d="M8 2.5l5.5 5.5L8 13.5 2.5 8z" />
      <circle cx="8" cy="8" r="1.3" />
    </>
  ),
};

/** one object for every icon: a long conversation draws thousands of these */
const ICON_STYLE: React.CSSProperties = {
  display: 'inline-block',
  marginInlineStart: '0.45em',
  verticalAlign: '-0.18em',
};

/**
 * The icon for a tool, by kind or by the tool's raw name.
 *
 * Sized in `em`, so it scales with the header it sits in (the feed's header
 * styles are 10.5px and 11px). It goes INSIDE the element that holds the
 * name, after the text: that is what gives it the name's ink, and the small
 * start margin and downward nudge here are what sit it beside the word.
 */
export function ToolIcon(props: { kind?: ToolIconKind; name?: string }): React.JSX.Element {
  const kind = props.kind ?? toolIconFor(props.name);
  return (
    <svg
      aria-hidden
      focusable="false"
      data-tool-icon={kind}
      viewBox="0 0 16 16"
      width="1.1em"
      height="1.1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={ICON_STYLE}
    >
      {PATHS[kind]}
    </svg>
  );
}
