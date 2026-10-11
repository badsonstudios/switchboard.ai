// The small picture that says what kind of step a block is (#757, moved by
// #1207).
//
// #757 put it after the tool's name, inside the box. The owner then approved a
// mock that moves it: the picture REPLACES the grey dot in the timeline gutter
// and the box goes back to the name and its subject. The gutter is the column
// you already run your eye down to find where things happened; now it also
// says what each of them was.
//
// DRAWN, NOT TYPED. The app's other marks are text glyphs from the locale file,
// and the first ticket's first choice was the same. These are inline SVG
// instead, for one reason: they have to be told apart at about 13px and look
// the same on Windows, Linux and macOS, in the main window and a popped-out
// one. A glyph is whatever the fallback font on that machine draws, and the
// candidates (a magnifier, a robot, a plug) are emoji on some and missing on
// others. A handful of small paths, no dependency, no icon font.
//
// SHAPE CARRIES IT, NOT COLOUR. Every icon is `currentColor`: it takes the ink
// of the gutter and no hue of its own, so nothing here can become a new
// meaning for a colour (and none of it can be yellow).
//
// REINFORCEMENT, NOT INFORMATION. The tool's name is still in the box; the
// icon is `aria-hidden` and a screen reader hears exactly what it heard before.
//
// THE DRAWINGS ARE A FIRST PASS. The ticket leaves the final art to the
// designer; what is fixed here is which block gets which KIND
// (`shared/tool-icon`), so redrawing one is a change to one entry below.
import React from 'react';
import type { ToolIconKind } from '../../../shared/tool-icon';

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
  // a neutral diamond: "some tool". Not drawn in the gutter (an unrecognised
  // tool keeps the plain dot); kept so the kind always has a picture.
  other: (
    <>
      <path d="M8 2.5l5.5 5.5L8 13.5 2.5 8z" />
      <circle cx="8" cy="8" r="1.3" />
    </>
  ),
  // a page with a plus: a whole new file
  write: (
    <>
      <path d="M4 2.5h5.5L12 5v8.5H4z" />
      <path d="M9.5 2.5V5H12" />
      <path d="M8 7.5v4M6 9.5h4" />
    </>
  ),
  // a bound notebook: a spine with rings, and a page
  notebook: (
    <>
      <rect x="4" y="2.5" width="8.5" height="11" rx="1" />
      <path d="M6.5 2.5v11" />
      <path d="M2.8 5h2M2.8 8h2M2.8 11h2" />
    </>
  ),
  // two magnifiers, one behind the other: a burst of looking around
  explore: (
    <>
      <circle cx="6.2" cy="8.2" r="3.4" />
      <path d="M8.7 10.7L12 14" />
      <path d="M8.4 3.4a3.4 3.4 0 0 1 4.3 4.9" />
    </>
  ),
  // a branch: a line, a fork, three nodes
  git: (
    <>
      <circle cx="4.5" cy="3.5" r="1.4" />
      <circle cx="4.5" cy="12.5" r="1.4" />
      <circle cx="11.5" cy="6" r="1.4" />
      <path d="M4.5 4.9v6.2" />
      <path d="M11.5 7.4c0 2.2-2.6 2.6-7 2.9" />
    </>
  ),
  // a hexagon: the package manager's own shape
  node: (
    <>
      <path d="M8 2l5.2 3v6L8 14l-5.2-3V5z" />
      <path d="M8 8v6M8 8l5.2-3M8 8L2.8 5" />
    </>
  ),
  // two interlocked bars with an eye each: the two-snake mark, simplified
  python: (
    <>
      <path d="M6 2.5h3a2 2 0 0 1 2 2V7H6a2 2 0 0 0-2 2v2.5" />
      <path d="M10 13.5H7a2 2 0 0 1-2-2V9h5a2 2 0 0 0 2-2V4.5" />
      <path d="M7.2 4.5v.1M8.8 11.4v.1" />
    </>
  ),
  // a slanted terminal with a chevron and an underline
  powershell: (
    <>
      <path d="M4.2 3h10l-2.4 10h-10z" />
      <path d="M5.8 6l2.4 2-3 2.1" />
      <path d="M8.2 10.6h2.4" />
    </>
  ),
  // a box of stacked blocks: a container
  container: (
    <>
      <rect x="2.5" y="8" width="11" height="5" rx="1" />
      <path d="M4.5 8V5.5h3V8M7.5 8V5.5h3V8M6 5.5V3h3v2.5" />
    </>
  ),
};

/** one object for every icon: a long conversation draws thousands of these */
const ICON_STYLE: React.CSSProperties = { display: 'block', flexShrink: 0 };

/** How big the picture is in the gutter. The dot it replaces is 6px; this is
 *  centred on the same point and overhangs it, so nothing beside it moves. */
export const GUTTER_ICON_PX = 13;

/**
 * One picture, by kind.
 *
 * It has no margin and no alignment of its own: the gutter cell that holds it
 * centres it. `size` is in px.
 */
export function ToolIcon(props: { kind: ToolIconKind; size?: number }): React.JSX.Element {
  const size = props.size ?? GUTTER_ICON_PX;
  return (
    <svg
      aria-hidden
      focusable="false"
      data-tool-icon={props.kind}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={ICON_STYLE}
    >
      {PATHS[props.kind]}
    </svg>
  );
}

/**
 * The timeline gutter's cell for one row: the picture for its kind, a plain
 * dot, or nothing but the space.
 *
 * ALWAYS 6px WIDE, whatever it draws. That is the width the dot has always
 * had, and every row reserves it, so the boxes to its right start on one line
 * whether the row has a picture, a dot or neither. The picture is 13px and is
 * centred on the cell by the flex box, overhanging it equally on both sides
 * into the gap that was already there; in a right-to-left layout that is still
 * the centre.
 */
export function GutterMark(props: {
  /** the picture to draw, or null for the dot */
  icon: ToolIconKind | null;
  /** draw the dot when there is no picture (false: just the space) */
  dot: boolean;
  /** the dot's ink, when it is one */
  dotColor?: string;
  /** what the row is, for a test or a stylesheet to find it by */
  mark?: string;
}): React.JSX.Element {
  const attrs = props.icon
    ? { 'data-feed-glyph': props.icon }
    : props.dot
      ? { 'data-feed-dot': props.mark ?? '' }
      : {};
  return (
    <span
      {...attrs}
      aria-hidden
      style={{
        inlineSize: 6,
        blockSize: 6,
        flexShrink: 0,
        marginBlockStart: 5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // the readable grey: a picture has to be made out, which the dot's
        // paler ink never had to be
        color: 'var(--muted)',
        ...(!props.icon && props.dot
          ? { borderRadius: '50%', background: props.dotColor ?? 'var(--faint)' }
          : {}),
      }}
    >
      {props.icon && <ToolIcon kind={props.icon} />}
    </span>
  );
}
