// Resolving the token the update check reads the private repo with
// (P2-E19-03, plan §E19 decision 1).
//
// THE RULE, borrowed from ClaudeMon and non-negotiable: **never embed a token
// in the shipped app.** The repo is private, so the check needs credentials —
// and the only acceptable credentials are ones already on the machine.
//
// The resolution order is an ORDERED SEAM, deliberately, so that adding a
// source later is one entry in the array and not a rewrite:
//
//   1. the OS credential store — DESIGN.md §5.29's home for credentials.
//      **A documented no-op today.** There is no credential-store subsystem in
//      this codebase yet, and building one for an update checker would be the
//      tail wagging the dog (orchestrator call, recorded in the #259 hand-off).
//      When §5.29's store lands, this slot is where it plugs in.
//   2. `gh auth token` — zero setup on Dan's machines, and the CLI already
//      holds exactly the scope this needs. `gh` may not be installed: that is
//      an ordinary outcome, not an error.
//   3. nothing. Checks are silently disabled, and the app behaves exactly as
//      it did before this feature existed.
//
// Nothing here throws, and nothing here logs the token.
import { execFile } from 'child_process';
import { GITHUB_TOKEN_SECRET_KEY } from '../../shared/diagnostics';

/** One place a token might come from. Resolves null when it has none. */
export interface TokenSource {
  /** for the debug log line — never the value */
  id: string;
  resolve: () => Promise<string | null>;
}

/** How long `gh` gets before we decide it is not going to answer. */
const GH_TIMEOUT_MS = 5_000;

/**
 * The bit of `secrets/store.ts` this needs. An interface rather than the class
 * so the token layer stays testable with no Electron and no keyring.
 */
export interface SecretReader {
  get(key: string): string | null;
}

/**
 * DESIGN.md §5.29's OS credential store — **the slot, now filled (#815).**
 *
 * This was a documented no-op for two items, because there was no credential
 * store to read and building one for an update checker would have been the tail
 * wagging the dog. `secrets/store.ts` now exists (safeStorage, ciphertext at
 * `<userData>/secrets.json`), so the slot can finally be filled.
 *
 * **WHO ACTUALLY USES IT, stated plainly because the obvious reading is wrong:**
 * only the #815 report path (`diagnostics/report-ipc.ts`) passes this in.
 * `UpdateService` still resolves `DEFAULT_TOKEN_SOURCES` below, whose
 * credential-store entry is the no-op — so a token pasted into the report
 * dialog does NOT yet switch update checks back on. That is a real
 * inconsistency for a user who does it, and it is written down rather than left
 * silent: see **#856**. Wiring it means threading `tokenSources` through
 * `UpdateService`, which is release-critical code and did not belong in the
 * diff that filled this slot.
 *
 * A factory rather than a const because the store is constructed in
 * `index.ts` with the app's paths; there is nothing sensible to read at module
 * scope.
 */
export function credentialStoreTokenFrom(secrets: SecretReader): TokenSource {
  return {
    id: 'credential-store',
    resolve: () => {
      try {
        const token = secrets.get(GITHUB_TOKEN_SECRET_KEY);
        return Promise.resolve(token && token.trim() ? token.trim() : null);
      } catch {
        // A store that throws is a store with no token — same as everything
        // else in this chain, and never a reason to fail a check or a report.
        return Promise.resolve(null);
      }
    },
  };
}

/**
 * The unconfigured form, kept so `DEFAULT_TOKEN_SOURCES` still resolves without
 * a store wired in (tests, and any caller that has no `SecretStore` to hand).
 * Prefer `credentialStoreTokenFrom` wherever the store exists.
 */
export const credentialStoreToken: TokenSource = {
  id: 'credential-store',
  resolve: () => Promise.resolve(null),
};

/**
 * `gh auth token`.
 *
 * `execFile`, never a shell: no argument is interpolated, but a shell here
 * would be a free injection point for whatever ends up on PATH. `windowsHide`
 * keeps a console window from flashing on every startup check.
 *
 * Every failure — `gh` absent (ENOENT), not logged in (non-zero exit), a hung
 * process (timeout) — is the same answer: no token. The distinction does not
 * change what we do, and pretending otherwise would put a message on screen
 * for a machine that simply has not got `gh`.
 */
export const ghCliToken: TokenSource = {
  id: 'gh-cli',
  resolve: () =>
    new Promise<string | null>((resolve) => {
      try {
        execFile(
          'gh',
          ['auth', 'token'],
          { encoding: 'utf8', timeout: GH_TIMEOUT_MS, windowsHide: true },
          (err, stdout) => {
            if (err) return resolve(null);
            const token = (stdout ?? '').trim();
            // `gh` prints the token and nothing else; anything with whitespace
            // in it is a message we mis-parsed, not a credential.
            resolve(token && !/\s/.test(token) ? token : null);
          }
        );
      } catch {
        // execFile can throw synchronously (EINVAL on a hostile PATH entry)
        resolve(null);
      }
    }),
};

/** The order decided in §E19. Exported so a test can substitute the whole set. */
export const DEFAULT_TOKEN_SOURCES: TokenSource[] = [credentialStoreToken, ghCliToken];

export interface ResolvedToken {
  token: string | null;
  /** which source answered, or 'none' — the one thing worth logging */
  source: string;
}

/** First source with a token wins. Never throws, never logs the value. */
export async function resolveUpdateToken(
  sources: TokenSource[] = DEFAULT_TOKEN_SOURCES
): Promise<ResolvedToken> {
  for (const source of sources) {
    let token: string | null = null;
    try {
      token = await source.resolve();
    } catch {
      token = null; // a broken source is a source with no token
    }
    if (token) return { token, source: source.id };
  }
  return { token: null, source: 'none' };
}
