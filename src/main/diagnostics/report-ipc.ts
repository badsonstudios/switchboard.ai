// The report dialog's IPC (#815).
//
// Three channels, and their shape is the security story — the same one
// `events/push-ipc.ts` tells, for the same reason:
//
//   • `diag:reportStatus` — CAN this machine file an issue? Booleans only.
//   • `diag:setGitHubToken` — write a token INTO the OS store. One direction.
//   • `diag:submit`        — build the bundle and send the report.
//
// **There is no channel that reads a token back, and there will not be one.**
// The renderer runs third-party markdown and remote-ish content; the whole
// point of resolving the credential in main is that a compromise over there
// cannot walk off with it. The dialog shows "a credential is available" or
// "none found", never a value.
//
// It also has no choice: the renderer cannot reach the network at all
// (`connect-src 'self'`), so the POST could not happen there even if we wanted
// it to. The window collects a subject and a description; main does the rest.
import { errorText } from '../../shared/error-text';
import { shell } from 'electron';
import { IpcBroker } from '../ipc/broker';
import type { Logger } from '../log/logger';
import { buildBundle, type BundleDeps } from './bundle';
import { composeBrowserIssue, composeIssueBody } from './report-body';
import { sanitizeSummary } from '../../shared/perf';
import { createIssue, type CreateIssueResult } from './github-issue';
import { tokenSourcesFor, type TokenSource } from '../update/token';
import type { SecretStore } from '../secrets/store';
import {
  GITHUB_TOKEN_SECRET_KEY,
  isFilable,
  type BundleResult,
  type ReportDestination,
  type ReportDraft,
  type ReportResult,
  type ReportStatus,
  type ReportWriteResult,
} from '../../shared/diagnostics';

/** The bits of electron this touches, injectable so tests need no app. */
export interface ReportShell {
  showItemInFolder(p: string): void;
  openExternal(url: string): Promise<void>;
}

export const electronReportShell: ReportShell = {
  showItemInFolder: (p) => shell.showItemInFolder(p),
  openExternal: (url) => shell.openExternal(url),
};

export interface ReportIpcDeps {
  broker: IpcBroker;
  log: Logger;
  secrets: SecretStore;
  /** rebuilt per call — uptime and paths move between reports */
  bundleDeps: () => BundleDeps;
  sh?: ReportShell;
  /** injectable for tests; defaults to the real GitHub call */
  fileIssue?: typeof createIssue;
  fetchImpl?: typeof globalThis.fetch;
  /**
   * The credential chain, injectable — and this seam is not optional politeness.
   *
   * Without it a unit test falls through the fake store to the REAL `ghCliToken`
   * and shells out to `gh auth token` on whoever's machine is running the
   * suite. That is slow, it is a live read of a real credential store from a
   * test, and worst of all it passes for the wrong reason: on a machine where
   * `gh` is signed in, a status test stays green even if the credential-store
   * source were deleted outright. `update/checker.ts` grew `skipToken` for
   * exactly this and said so.
   */
  tokenSources?: () => TokenSource[];
}

export function registerReportIpc(deps: ReportIpcDeps): void {
  const { broker, log, secrets } = deps;
  const sh = deps.sh ?? electronReportShell;
  const fileIssue = deps.fileIssue ?? createIssue;

  /**
   * The chain, with the credential store's slot FILLED (#815) — and built by
   * `token.ts`'s own factory rather than spelled out here (#856).
   *
   * It used to be an array literal in this file, which was fine right up until
   * the update path needed the same chain and got a different one. The order —
   * a token the user deliberately pasted beats whatever `gh` happens to be
   * logged in as — is a decision, and it now has exactly one home.
   */
  const tokenSources = deps.tokenSources ?? ((): TokenSource[] => tokenSourcesFor(secrets));

  const status = async (): Promise<ReportStatus> => {
    let canFileIssue = false;
    for (const source of tokenSources()) {
      try {
        if (await source.resolve()) {
          canFileIssue = true;
          break;
        }
      } catch {
        // a broken source is a source with no token
      }
    }
    return {
      canFileIssue,
      storeAvailable: secrets.available(),
      tokenStored: secrets.has(GITHUB_TOKEN_SECRET_KEY),
    };
  };

  broker.handle('diag:reportStatus', (): Promise<ReportStatus> => status());

  broker.handle('diag:setGitHubToken', async (_e, value: unknown): Promise<ReportWriteResult> => {
    const token = typeof value === 'string' ? value.trim() : '';
    // An empty string FORGETS it — the `push:setSecret` contract, so the two
    // credential surfaces behave the same way.
    const ok = token
      ? secrets.set(GITHUB_TOKEN_SECRET_KEY, token)
      : secrets.clear(GITHUB_TOKEN_SECRET_KEY);
    // The KEY, never the value. Same rule as everywhere else that touches one.
    log.info(token ? 'github token stored' : 'github token forgotten', {
      key: GITHUB_TOKEN_SECRET_KEY,
      ok,
    });
    // `ok` travels. A refused write that answered a bare status would read as
    // success on screen, which is the comfortable lie about credential state
    // this project has already caught itself telling once.
    return { status: await status(), ok };
  });

  broker.handle('diag:submit', async (_e, raw: unknown): Promise<ReportResult> => {
    const draft = (raw ?? {}) as Partial<ReportDraft>;
    const subject = typeof draft.subject === 'string' ? draft.subject.trim() : '';
    const description = typeof draft.description === 'string' ? draft.description : '';
    // Anything else — including the `'email'` an older renderer may still send
    // (#1494 removed it) — is `'zip'`: the evidence is built and revealed, and
    // nothing is sent anywhere the user did not choose.
    const destination: ReportDestination = draft.destination === 'github' ? 'github' : 'zip';

    const empty: BundleResult = { ok: false, path: null, bytes: 0, skipped: [] };
    if (!isFilable({ subject })) {
      return { ok: false, destination, url: null, number: null, bundle: empty, problem: 'empty-subject' };
    }

    // E21's numbers ride in on the DRAFT (#927), so they cross the same trust
    // boundary as everything else the renderer sends. Rebuilt rather than
    // trusted, for the reason the capture file's own sanitizer gives: this one
    // ends up in a GitHub issue body, which is the single point in the app
    // where local data genuinely leaves the machine.
    const perf = sanitizeSummary(draft?.perf);

    const bundleDeps = { ...deps.bundleDeps(), ...(perf ? { perf } : {}) };
    const bundle = await buildBundle(bundleDeps);
    if (!bundle.ok) {
      // NOT a stop. A report with no zip is still worth filing — the inline
      // diagnostics are most of the value, and refusing here would lose the
      // user's typed description as well as the logs.
      log.warn('diagnostic bundle could not be built', { problem: bundle.problem ?? 'unknown' });
    }

    // Revealed for EVERY destination, and before the network is touched: the
    // fail-open half. Whatever happens next, the evidence is on disk and the
    // user is looking at it.
    if (bundle.path) {
      try {
        sh.showItemInFolder(bundle.path);
      } catch (err) {
        log.warn('could not reveal the bundle', { error: errorText(err) });
      }
    }

    if (destination === 'zip') {
      return { ok: bundle.ok, destination, url: null, number: null, bundle };
    }

    const bodyDeps = {
      description,
      version: bundleDeps.version,
      identity: bundleDeps.identity,
      logsDir: bundleDeps.logsDir,
      bundlePath: bundle.path,
      uptimeMs: bundleDeps.uptimeMs,
      ...(perf ? { perf } : {}),
    };

    const filed: CreateIssueResult = await fileIssue({
      title: subject,
      body: composeIssueBody(bodyDeps),
      version: bundleDeps.version,
      tokenSources: tokenSources(),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      log: (msg, fields) => log.info(msg, fields),
    });

    // NO CREDENTIAL IS NOT A DEAD END (#1494). The repo is public, so GitHub's
    // own new-issue form takes the report from anyone signed in to GitHub in
    // their browser. Only `no-token` comes here: a token GitHub REFUSED is a
    // different fact with its own sentence, and quietly swapping paths on it
    // would hide a broken credential the user may want to fix.
    if (filed.problem === 'no-token') {
      try {
        const form = composeBrowserIssue({ ...bodyDeps, title: subject });
        if (!form.ok) {
          log.info('report not handed to the browser: description too long for a link');
          return { ok: false, destination, url: null, number: null, bundle, problem: form.problem };
        }
        await sh.openExternal(form.url);
        // the SIZE, never the words — the same rule Feature request keeps
        log.info('report handed to the browser', { chars: form.url.length });
      } catch (err) {
        // The error's NAME: an `openExternal` rejection may quote the URL, and
        // the URL is the user's description, percent-encoded.
        log.warn('could not hand the report to the browser', {
          error: err instanceof Error ? err.name : 'unknown',
        });
        return { ok: false, destination, url: null, number: null, bundle, problem: 'browser-failed' };
      }
      // `url: null` on purpose: the dialog opens a returned URL, and the form
      // is already open. Opening it twice would be two half-filed reports.
      return { ok: true, destination, url: null, number: null, bundle };
    }

    return {
      ok: filed.ok,
      destination,
      url: filed.url,
      number: filed.number,
      bundle,
      ...(filed.problem ? { problem: filed.problem } : {}),
    };
  });
}
