// Where the bundled user manual is on this install (Help ▸ User manual).
//
// A function of three facts rather than three lines inside `index.ts`, so the
// packaging test can hold it against `electron-builder.js`: the folder the
// installer copies the pages TO and the folder a packaged build looks IN are
// two strings in two files, and the dev build — which reads the repository's
// own copy — keeps working whichever of them is wrong.
import path from 'path';

/** `extraResources`' `to` in electron-builder.js — the folder under resources/. */
export const MANUAL_RESOURCE_DIR = 'manual';

export function bundledManualDir(at: {
  /** `app.isPackaged` */
  packaged: boolean;
  /** `process.resourcesPath` — where `extraResources` lands */
  resourcesPath: string;
  /** `app.getAppPath()` — the repository root in an unpackaged run */
  appPath: string;
}): string {
  // Packaged: REAL FILES beside app.asar, not members of it. The read scope
  // decides on `realpath`, the viewer follows the open file with a directory
  // watch, and Open externally hands a path to another program — none of which
  // an archive member can answer.
  //
  // Unpackaged: the repository's own pages, so the page being written is the
  // page shown.
  return at.packaged
    ? path.join(at.resourcesPath, MANUAL_RESOURCE_DIR)
    : path.join(at.appPath, 'docs', 'manual');
}
