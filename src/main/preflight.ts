// First-run preflight (P1-E6-03, §5.25), asked of EVERY registered AI (#1288).
//
// Each provider checks itself through its `preflight` capability (Claude's is
// `providers/claude-preflight.ts`); this module only runs them and reports. The
// TOP-LEVEL answer is the DEFAULT provider's, because that is the AI a new
// session starts on and the one the banner and the status-bar version are
// about — so with only Claude registered the answer is exactly what it was.
//
// A provider that declares no check is NOT reported as broken. "We cannot
// tell" and "it is not installed" are different claims, and only the second
// raises a banner (the renderer's rule since #650: not knowing is not the same
// as a failed preflight). Same for a check that throws: logged, and read as
// "not checked".
import { errorText } from '../shared/error-text';
import type { ProviderPreflight, ProviderCapabilities } from './extensibility/contributions';

/** One registered AI, as preflight needs to see it. */
export interface PreflightTarget {
  providerId: string;
  /** the provider's display name, for the per-provider list */
  name: string;
  capabilities?: ProviderCapabilities;
}

export interface ProviderPreflightReport extends ProviderPreflight {
  providerId: string;
  name: string;
  /** false: this provider declares no check, or its check failed to run */
  checked: boolean;
}

/** The default provider's answer, plus every provider's own. */
export interface PreflightResult extends ProviderPreflight {
  /** which provider the top-level fields describe */
  providerId: string;
  checked: boolean;
  providers: ProviderPreflightReport[];
}

/** Above Claude's own 30 s `--version` limit, so Claude's check is never cut short. */
export const PREFLIGHT_TIMEOUT_MS = 35_000;

const NOT_CHECKED: ProviderPreflight = {
  cliPath: null,
  version: null,
  configPresent: false,
  ok: true,
};

async function checkOne(
  t: PreflightTarget,
  log?: (msg: string, meta?: Record<string, unknown>) => void
): Promise<ProviderPreflightReport> {
  const check = t.capabilities?.preflight;
  if (!check) return { ...NOT_CHECKED, providerId: t.providerId, name: t.name, checked: false };
  try {
    // BOUNDED: the checks run side by side and the DEFAULT provider's answer
    // waits on all of them, so one check that never answers must not hold the
    // banner and the status-bar version hostage. Claude's own has a 30 s limit
    // on `--version`; this is the ceiling for any provider.
    let timer: NodeJS.Timeout | undefined;
    const r = await Promise.race([
      check.check(),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), PREFLIGHT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
    if (r === 'timeout') {
      log?.('preflight check did not answer in time; reporting the provider as not checked', {
        provider: t.providerId,
      });
      return { ...NOT_CHECKED, providerId: t.providerId, name: t.name, checked: false };
    }
    // An answer that is not the promised shape is not evidence of anything —
    // an `ok: undefined` would otherwise raise the "not installed" banner.
    if (!r || typeof r.ok !== 'boolean') {
      log?.('preflight check answered something unreadable; reporting it as not checked', {
        provider: t.providerId,
      });
      return { ...NOT_CHECKED, providerId: t.providerId, name: t.name, checked: false };
    }
    return {
      cliPath: typeof r.cliPath === 'string' ? r.cliPath : null,
      version: typeof r.version === 'string' ? r.version : null,
      configPresent: r.configPresent === true,
      ok: r.ok,
      providerId: t.providerId,
      name: t.name,
      checked: true,
    };
  } catch (err) {
    log?.('preflight check threw; reporting the provider as not checked', {
      provider: t.providerId,
      error: errorText(err),
    });
    return { ...NOT_CHECKED, providerId: t.providerId, name: t.name, checked: false };
  }
}

export async function runPreflight(
  targets: readonly PreflightTarget[],
  defaultProviderId: string,
  log?: (msg: string, meta?: Record<string, unknown>) => void
): Promise<PreflightResult> {
  const providers = await Promise.all(targets.map((t) => checkOne(t, log)));
  const main =
    providers.find((p) => p.providerId === defaultProviderId) ??
    // the default is not registered: nothing to claim about it
    { ...NOT_CHECKED, providerId: defaultProviderId, name: defaultProviderId, checked: false };
  return {
    cliPath: main.cliPath,
    version: main.version,
    configPresent: main.configPresent,
    ok: main.ok,
    providerId: main.providerId,
    checked: main.checked,
    providers,
  };
}
