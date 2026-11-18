// The notes' colours (#1601): Settings ▸ Appearance ▸ Note colours.
//
// Dan, 2026-11-10: "set the color of the sticky notes in the settings. They
// default to this yellowish color, but we can set the color to whatever we
// want." Asked whether that means the green session note too, he said both
// (2026-11-17), so there are two: the WAITING note (yellow, the AI's "I need
// you") and the SESSION note (green, yours or the AI's).
//
// NOTHING IS PICKED UNTIL YOU PICK IT. With no stored colour the notes are
// drawn exactly as before, from the theme's tokens; a picked colour comes with
// an ink chosen here, dark or light, to clear 4.5:1 on it, so no pick can make
// a note unreadable.
//
// THE WAITING NOTE KEEPS SAYING "NEEDS YOU". Its fill is the user's, but its
// bottom edge stays `--status-needs-input` (the #1165 attention colour), so a
// grey or blue waiting note is still marked as one.
//
// APPLIED AS CSS VARIABLES ON EACH NOTE'S OWN ELEMENT, not on the document:
// a popped-out card is a second document (#1022), and a variable set on the
// main window's root would never reach it.
import * as React from 'react';
import { uiGet, uiSet } from './ui-state';

export {
  DEFAULT_NOTE_COLOURS,
  contrast,
  inksFor,
  luminance,
  mixHex,
  noteColoursOf,
  type NoteColours,
  type NoteInks,
  type NoteKind,
} from '../../../shared/note-colour-math';
import { inksFor, noteColoursOf, type NoteColours, type NoteKind } from '../../../shared/note-colour-math';

/** the ui-blob key: `{ waiting?: '#rrggbb', session?: '#rrggbb' }` */
export const NOTE_COLOURS_KEY = 'noteColours';


/**
 * The CSS variables a note surface puts on itself. Empty when nothing is
 * picked, so the theme's own tokens apply exactly as before.
 */
export function noteVars(kind: NoteKind, colours: NoteColours): React.CSSProperties {
  const fill = colours[kind];
  if (!fill) return {};
  const { ink, muted, edge } = inksFor(fill);
  return kind === 'waiting'
    ? ({ '--waiting-paper': fill, '--waiting-ink': ink, '--waiting-ink-muted': muted } as React.CSSProperties)
    : ({
        '--note-paper': fill,
        '--note-paper-edge': edge,
        '--note-ink': ink,
        '--note-ink-muted': muted,
        // the AI's blue byline cannot be promised 4.5:1 on any colour: on a
        // picked one it is written in the ink, and the blue stays on its edge
        '--note-ai-ink': ink,
      } as React.CSSProperties);
}

// ── the store ───────────────────────────────────────────────────────────────

let current: NoteColours = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Read what was stored, once the ui blob has loaded (App calls this). */
export function initNoteColours(): void {
  current = noteColoursOf(uiGet<unknown>(NOTE_COLOURS_KEY, undefined));
  emit();
}

/** Pick a colour for one kind of note, or `null` to go back to the default. */
export function setNoteColour(kind: NoteKind, hex: string | null): void {
  const next: NoteColours = { ...current };
  if (hex && /^#[0-9a-f]{6}$/i.test(hex)) next[kind] = hex.toLowerCase();
  else delete next[kind];
  current = next;
  uiSet(NOTE_COLOURS_KEY, current);
  emit();
}

/** React binding: the picked colours (empty = all default). */
export function useNoteColours(): NoteColours {
  return React.useSyncExternalStore(
    subscribe,
    () => current,
    () => current
  );
}

/** React binding: the variables one kind of note puts on itself. */
export function useNoteVars(kind: NoteKind): React.CSSProperties {
  const colours = useNoteColours();
  const fill = colours[kind];
  // memoised on the one colour, so an unrelated pick does not restyle it
  return React.useMemo(() => noteVars(kind, fill ? { [kind]: fill } : {}), [kind, fill]);
}

/** Tests only. */
export function resetNoteColoursForTests(): void {
  current = {};
  emit();
}
