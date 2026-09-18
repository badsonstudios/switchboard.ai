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
import { shell } from 'electron';
import { IpcBroker } from '../ipc/broker';
import type { Logger } from '../log/logger';
import { buildBundle, type BundleDeps } from './bundle';
import { composeIssueBody } from './report-body';
import { createIssue, type CreateIssueResult } from './github-issue';
import { credentialStoreTokenFrom, ghCliToken, type TokenSource } from '../update/token';
import type { SecretStore } from '../secrets/store';
import {
  GITHUB_TOKEN_SECRET_KEY,
  REPORT_EMAIL_TO,
  isFilable,
  type BundleResult,
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

/**
 * A `mailto:` carries the SUBJECT and a pointer, never the diagnostics.
 *
 * Two reasons, and the second is the one that bites: `mailto:` cannot attach a
 * file at all, and its total length is capped low enough by Windows and by mail
 * clients that a body with a log in it is silently truncated — which would be
 * the same defect as a button that claims to send logs and does not.
 */
export function mailtoFor(subject: string, bundlePath: string | null): string {
  const body = [
    // NOT "is attached" — it is not, and this is the line a recipient skims.
    'The diagnostic bundle was written to:',
    bundlePath ?? '(the bundle could not be written — see the app log)',
    '',
    'Please attach the zip above before sending — it is revealed in Explorer.',
    '',
  ].join('\n');
  return (
    `mailto:${REPORT_EMAIL_TO.join(',')}` +
    `?subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(body)}`
  );
}

export function registerReportIpc(deps: ReportIpcDeps): void {
  const { broker, log, secrets } = deps;
  const sh = deps.sh ?? electronReportShell;
  const fileIssue = deps.fileIssue ?? createIssue;

  /**
   * The chain, with the credential store's slot FILLED (#815).
   *
   * `gh` first would be wrong: a token the user deliberately pasted is a
   * stronger statement of intent than whatever `gh` happens to be logged in as,
   * and this is the order `update/token.ts` already declares.
   */
  const tokenSources =
    deps.tokenSources ?? ((): TokenSource[] => [credentialStoreTokenFrom(secrets), ghCliToken]);

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
    const destination = draft.destination === 'github' || draft.destination === 'email' ? draft.destination : 'zip';

    const empty: BundleResult = { ok: false, path: null, bytes: 0, skipped: [] };
    if (!isFilable({ subject })) {
      return { ok: false, destination, url: null, number: null, bundle: empty, problem: 'empty-subject' };
    }

    const bundleDeps = deps.bundleDeps();
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
        log.warn('could not reveal the bundle', { error: String(err) });
      }
    }

    if (destination === 'zip') {
      return { ok: bundle.ok, destination, url: null, number: null, bundle };
    }

    if (destination === 'email') {
      try {
        await sh.openExternal(mailtoFor(subject, bundle.path));
      } catch (err) {
        log.warn('could not open the mail client', { error: String(err) });
      }
      return { ok: true, destination, url: null, number: null, bundle };
    }

    const body = composeIssueBody({
      description,
      version: bundleDeps.version,
      identity: bundleDeps.identity,
      logsDir: bundleDeps.logsDir,
      bundlePath: bundle.path,
      uptimeMs: bundleDeps.uptimeMs,
    });

    const filed: CreateIssueResult = await fileIssue({
      title: subject,
      body,
      version: bundleDeps.version,
      tokenSources: tokenSources(),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      log: (msg, fields) => log.info(msg, fields),
    });

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
