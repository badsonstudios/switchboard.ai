// The one impure edge of presentation state (P2-E15-08): the ui blob on one
// side, the store on the other. Kept out of both — lib/presentation.ts stays
// pure so its rules are testable, and the store stays free of the preload
// bridge (P2-E15-07's whole point).
//
// Call this ONCE, after loadUiState() and before anything can write: an early
// setPresentation would persist an empty blob over the saved one.
import { sessionStore } from '../store/session-store';
import { loadPresentation, persistablePresentation, PRESENTATION_KEY } from './presentation';
import { loadPolicyBook, POLICY_KEY } from './presentation-policy';
import { uiAll, uiDelete, uiGet, uiSet } from './ui-state';

export function initPresentation(): void {
  const { map, legacyKeys } = loadPresentation(uiAll());
  sessionStore.initPresentation(map);
  sessionStore.setPresentationPersister((blob) => uiSet(PRESENTATION_KEY, blob));
  // §5.8's presentation POLICY (P2-E9-06) rides the same edge, and must be
  // seeded in the same pass: a policy read before the blob has been loaded
  // would answer "always-visible" for a user who chose otherwise, and the very
  // first prompt they submitted would leave a card where they asked it not to.
  //
  // `null` from persistablePolicies means "nothing worth writing" — an untouched
  // book must not put a record in the blob, exactly as an untouched card's
  // presentation does not.
  sessionStore.initPolicies(loadPolicyBook(uiGet<unknown>(POLICY_KEY, null)));
  sessionStore.setPolicyPersister((blob) => {
    if (blob) uiSet(POLICY_KEY, blob);
    else uiDelete([POLICY_KEY]);
  });
  if (legacyKeys.length > 0) {
    // WRITE THE NEW HOME FIRST. initPresentation deliberately doesn't persist
    // (it only read the blob), so deleting the legacy keys on their own would
    // leave the migrated tabs in renderer memory and nowhere else until some
    // later write happened to save them.
    uiSet(PRESENTATION_KEY, persistablePresentation(map));
    // and only then forget the old home: one fact, one place
    uiDelete(legacyKeys);
  }
}
