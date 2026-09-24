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
//   1. the OS credential store — DESIGN.md §5.29's home for credentials, and
//      where a token pasted into Help ▸ Report a problem… lands. Built by
//      `credentialStoreTokenFrom(store)`, which means it is INJECTED at every
//      call site rather than sitting in a module-scope default: the source
//      needs a `SecretStore` instance, and there is nothing sensible to read
//      at module scope (see `DEFAULT_TOKEN_SOURCES` below).
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
 * DESIGN.md §5.29's OS credential store — the slot, filled in #815 and wired to
 * every consumer in **#856**.
 *
 * This was a documented no-op for two items, because there was no credential
 * store to read and building one for an update checker would have been the tail
 * wagging the dog. `secrets/store.ts` now exists (safeStorage, ciphertext at
 * `<userData>/secrets.json`), so the slot can finally be filled.
 *
 * **WHO USES IT — all three, and #856 is the item that made that true.** For
 * one release it was the report path alone (`diagnostics/report-ipc.ts`), while
 * `UpdateService` and `UpdateInstaller` fell through to `DEFAULT_TOKEN_SOURCES`
 * and its no-op entry. One token, two subsystems, opposite answers: a user
 * pasted a token into Help ▸ Report a problem…, filed an issue successfully,
 * and update checks stayed silently disabled. All three now inject this source.
 *
 * **ONE `SecretStore` INSTANCE, SHARED — that is load-bearing, not tidiness.**
 * `SecretStore.get()` caches a MISS for the life of the object, and only
 * `set()`/`clear()` on that same object repair it. So a token pasted at 14:02
 * is visible to a check at 14:03 through *that* store and no other: a second
 * one constructed for the update side would go on reading the miss it had
 * already cached, and #856 would survive its own fix in a shape much harder to
 * see. `index.ts` builds the store once, above both consumers.
 *
 * The honest limit of that: a token written into `secrets.json` by something
 * other than the running app is invisible until the app restarts. Every way the
 * app offers to save one goes through `set()`, so no shipped flow hits it.
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

/**
 * **The chain, in one place.** Every consumer in the app calls this rather than
 * writing the array out: the update check, the update download, and the problem
 * reporter.
 *
 * It exists because #856 was not really a missing argument — it was the *order*
 * living in two heads. The report path spelled the array out in
 * `report-ipc.ts`; the update path never spelled it at all and inherited a
 * default with a no-op in slot 1. Two spellings is how you get two subsystems
 * with opposite answers about one token, and a third call site written next
 * year would have had to notice a decision documented in a file it does not
 * import.
 *
 * So the ordering decision — **a token the user deliberately pasted beats
 * whatever `gh` happens to be signed in as** — now lives next to the comment
 * that explains it, and adding a source later is one edit rather than a search.
 */
export function tokenSourcesFor(secrets: SecretReader): TokenSource[] {
  return [credentialStoreTokenFrom(secrets), ghCliToken];
}

/**
 * The fallback chain for a caller with no store to hand — and it is `gh` ALONE.
 *
 * It used to carry a `credentialStoreToken` no-op in slot 1, which was honest
 * while there was no store and became a lie once there was one: a default chain
 * that *looks* like it consults the credential store and structurally cannot.
 * #856 deleted it. A source that reads the store needs a `SecretStore`
 * instance, so the only way to get one is to inject it — which is now what
 * every consumer in the app does, and the absence of a third spelling is what
 * stops a future call site from quietly getting the no-op again.
 *
 * Exported so a test can substitute the whole set.
 */
export const DEFAULT_TOKEN_SOURCES: TokenSource[] = [ghCliToken];

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
