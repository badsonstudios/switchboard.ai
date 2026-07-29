// The one impure edge of presentation state (P2-E15-08): the ui blob on one
// side, the store on the other. Kept out of both — lib/presentation.ts stays
// pure so its rules are testable, and the store stays free of the preload
// bridge (P2-E15-07's whole point).
//
// Call this ONCE, after loadUiState() and before anything can write: an early
// setPresentation would persist an empty blob over the saved one.
import { sessionStore } from '../store/session-store';
import { loadPresentation, persistablePresentation, PRESENTATION_KEY } from './presentation';
import { uiAll, uiDelete, uiSet } from './ui-state';

export function initPresentation(): void {
  const { map, legacyKeys } = loadPresentation(uiAll());
  sessionStore.initPresentation(map);
  sessionStore.setPresentationPersister((blob) => uiSet(PRESENTATION_KEY, blob));
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
