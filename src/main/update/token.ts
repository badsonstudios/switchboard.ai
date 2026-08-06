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

/** One place a token might come from. Resolves null when it has none. */
export interface TokenSource {
  /** for the debug log line — never the value */
  id: string;
  resolve: () => Promise<string | null>;
}

/** How long `gh` gets before we decide it is not going to answer. */
const GH_TIMEOUT_MS = 5_000;

/**
 * DESIGN.md §5.29's OS credential store.
 *
 * Intentionally empty. Kept as a real entry rather than a comment so the order
 * is expressed in code — the day the credential store exists, this function
 * gets a body and no caller changes.
 */
export const credentialStoreToken: TokenSource = {
  id: 'credential-store',
  resolve: async () => null,
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
