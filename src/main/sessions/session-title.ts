// What a NEW session is called (#1282).
//
// ONE RULE, TWO CALLERS. `sessions:create` applies it to the card it is about
// to start, and `sessions:suggestTitle` applies it to a name the user has not
// committed to yet, so the naming dialog can show the name the session will
// really get. It used to live inline in `sessions:create`, which meant the
// renderer never knew the final name in advance; restating it in the renderer
// would have given two copies to drift apart.
//
// The rule is the one Dan asked for in round 4 of Phase 1: a second session in
// the same folder must not read IDENTICALLY in the rail and the grid, so a name
// already in use gets the first free `-N`, starting at `-2` (there is no `-1`:
// the first one is the plain name). "In use" is every SAVED record, open or
// not, and compared without case — `Foo` and `foo` read as the same name.
// Renames stay free-form; nothing here touches an existing card.

import { MAX_SESSION_TITLE } from '../../shared/sessions';

export { MAX_SESSION_TITLE };

/**
 * `wanted`, or `wanted-N` for the first free N from 2, given every title
 * already saved.
 *
 * Byte-for-byte the rule `sessions:create` always had, including where the cut
 * falls: `wanted` is cut to the limit first, and the suffixed name is cut
 * again. (So a name already at the limit loses its suffix to the second cut.
 * That is today's behaviour, kept exactly — this item lifts the rule, it does
 * not change it.)
 */
export function uniqueSessionTitle(wanted: string, takenTitles: Iterable<string>): string {
  const title = wanted.slice(0, MAX_SESSION_TITLE);
  const taken = new Set<string>();
  for (const t of takenTitles) {
    // fail-open: a malformed record must not stop a session from being named
    if (typeof t === 'string') taken.add(t.toLowerCase());
  }
  if (!taken.has(title.toLowerCase())) return title;
  let n = 2;
  while (taken.has(`${title}-${n}`.toLowerCase())) n++;
  return `${title}-${n}`.slice(0, MAX_SESSION_TITLE);
}
