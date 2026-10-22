// Why a sign-in, a probe or a detection did not work, as a CODE the renderer
// translates (#1365).
//
// These reasons are made in main, which has no `t` (§5.21), and they used to
// reach the AIs tab as English sentences, interpolated raw into
// `ais.loginFailed` / `ais.unknownWhy` / `ais.add.testFailed`. Main now sends a
// code and its values BESIDE the English it always sent: the English stays for
// the log and as the fallback, the code is what the tab says.
//
// FAIL-OPEN BOTH WAYS: a code the renderer does not know, or values of the
// wrong shape, read as the English; a main that sends no code reads exactly as
// before. The values are the variable parts only (a number of seconds, the
// AI's own error text, a command); the AI's own words stay its own.

/** Every reason main gives a code to. */
export const AI_REASON_CODES = [
  // a probe of an ACP agent (`acp-probe.ts`: Test, Log in)
  'command-not-found',
  'no-answer-in-time',
  'cancelled',
  'refused-initialize',
  'no-sign-in-method',
  'sign-in-method-not-offered',
  'choose-sign-in-method',
  'sign-in-failed',
  'could-not-start',
  'exited-before-answering',
  // Codex runs its adapter through npx (`codex-provider.ts`)
  'npx-missing',
  // the default ACP detection (`acp-provider.ts`)
  'reports-at-session-start',
  // the detection runner's own answers (`ai-catalog/detection.ts`, `service.ts`)
  'check-timed-out',
  'check-cancelled',
  'check-failed',
  'check-unreadable',
  'check-not-offered',
  // the sign-in that has nothing to run (`ai-catalog/service.ts`)
  'signs-in-on-its-own',
  'not-set-up',
] as const;

export type AiReasonCode = (typeof AI_REASON_CODES)[number];

/** A reason as main sends it: a code and the values its sentence takes. */
export interface AiReason {
  code: AiReasonCode;
  params?: Record<string, string | number>;
}

/** Build one, dropping empty values so a sentence never shows a blank. */
export function aiReason(code: AiReasonCode, params?: Record<string, string | number | undefined>): AiReason {
  const kept: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === 'number' || (typeof v === 'string' && v !== '')) kept[k] = v;
  }
  return Object.keys(kept).length > 0 ? { code, params: kept } : { code };
}

/**
 * An Error that also carries its code, for a reason made where only a throw
 * reaches the caller (`codexCommand`). Its `message` is the English, so every
 * catch that reads only `message` reads what it always did.
 */
export class AiReasonError extends Error {
  constructor(
    message: string,
    readonly reason: AiReason
  ) {
    super(message);
    this.name = 'AiReasonError';
  }
}

/** The code an error carries, if it is one of ours. */
export function reasonOfError(err: unknown): AiReason | undefined {
  return err instanceof AiReasonError ? err.reason : undefined;
}

const KEYS: Readonly<Record<AiReasonCode, string>> = {
  'command-not-found': 'ais.reason.commandNotFound',
  'no-answer-in-time': 'ais.reason.noAnswerInTime',
  cancelled: 'ais.reason.cancelled',
  'refused-initialize': 'ais.reason.refusedInitialize',
  'no-sign-in-method': 'ais.reason.noSignInMethod',
  'sign-in-method-not-offered': 'ais.reason.signInMethodNotOffered',
  'choose-sign-in-method': 'ais.reason.chooseSignInMethod',
  'sign-in-failed': 'ais.reason.signInFailed',
  'could-not-start': 'ais.reason.couldNotStart',
  'exited-before-answering': 'ais.reason.exitedBeforeAnswering',
  'npx-missing': 'ais.reason.npxMissing',
  'reports-at-session-start': 'ais.reason.reportsAtSessionStart',
  'check-timed-out': 'ais.reason.checkTimedOut',
  'check-cancelled': 'ais.reason.checkCancelled',
  'check-failed': 'ais.reason.checkFailed',
  'check-unreadable': 'ais.reason.checkUnreadable',
  'check-not-offered': 'ais.reason.checkNotOffered',
  'signs-in-on-its-own': 'ais.reason.signsInOnItsOwn',
  'not-set-up': 'ais.reason.notSetUp',
};

/**
 * The keys a code's sentence needs filled. A reason missing one is read as its
 * English rather than shown with a hole in it. Optional values (the agent's
 * stderr tail on an exit) are not listed.
 */
const NEEDS: Readonly<Partial<Record<AiReasonCode, readonly string[]>>> = {
  'command-not-found': ['command'],
  'no-answer-in-time': ['seconds'],
  'refused-initialize': ['message'],
  'sign-in-method-not-offered': ['method'],
  'sign-in-failed': ['message'],
  'could-not-start': ['message'],
  'exited-before-answering': ['code'],
  'check-timed-out': ['seconds'],
  'check-failed': ['message'],
  'signs-in-on-its-own': ['ai'],
};

/**
 * The locale key and values for a reason that arrived over IPC — untrusted, so
 * checked (§5.29). `undefined` for anything that is not a known code with the
 * values its sentence needs: the caller then shows the English.
 */
export function aiReasonKey(v: unknown): { key: string; vars: Record<string, string | number> } | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as { code?: unknown; params?: unknown };
  if (typeof r.code !== 'string' || !Object.prototype.hasOwnProperty.call(KEYS, r.code)) return undefined;
  const code = r.code as AiReasonCode;
  const vars: Record<string, string | number> = {};
  if (r.params !== undefined) {
    if (typeof r.params !== 'object' || r.params === null || Array.isArray(r.params)) return undefined;
    for (const [k, x] of Object.entries(r.params as Record<string, unknown>)) {
      if (typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x))) vars[k] = x;
    }
  }
  for (const need of NEEDS[code] ?? []) if (!(need in vars)) return undefined;
  // `exited-before-answering` has two sentences: with the agent's last words, and without
  const key = code === 'exited-before-answering' && typeof vars.output === 'string' ? `${KEYS[code]}WithOutput` : KEYS[code];
  return { key, vars };
}
