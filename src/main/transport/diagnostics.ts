// Where StreamService's diagnostics go (#449).
//
// ## The decision, and why
//
// `StreamService` has emitted `StreamDiagnostic` since P2-E18-03 through an
// optional callback, and until this module NOTHING in the app passed one: every
// parse failure, overlong line, CLI stderr byte and dead-pipe write vanished
// the moment it was produced. #449 asked for a ruling - wire it, or delete the
// emitter. It is wired, to the **main log**, for three reasons:
//
//  1. **It is what the spec always said.** `docs/plans/05-transport-migration.md`
//     -> E18-03: "stderr captured separately **and logged**". The channel was
//     never speculative; the wiring item simply never landed.
//
//  2. **`result` errors do not cover it.** #425's corroboration reads a turn
//     that ENDED in an error. A diagnostic says we could not read the CLI at
//     all - precisely the case where no `result` ever arrives. A dropped
//     message is invisible from every other vantage point in the app; the
//     NDJSON decoder's counters exist because that failure is undiagnosable
//     after the fact, and counters nobody prints are counters nobody reads.
//
//  3. **Not the Events panel.** DESIGN 5.12's contract is one item per session,
//     resolved-means-gone, ordered by the attention queue. A parse failure is
//     not addressed to the user, cannot be resolved by them, and would either
//     evict a real attention item or queue behind one. This channel is for the
//     person reading `switchboard.log`, which is us - dogfooding wants clean
//     logging, and clean is not the same as empty.
//
// ## Why it is throttled
//
// A wedged CLI can emit a diagnostic per chunk, indefinitely. `LogSink` rotates
// at 5 MB x 5 files, so the risk is not disk - it is that a flood rotates away
// every OTHER line, and the log stops being able to explain anything. So each
// (session, kind) is logged on a power-of-two schedule - occurrence 1, 2, 4, 8,
// 16, ... - and every line carries the running `count`. The first one is never
// suppressed (it is nearly always the informative one), a flood costs
// logarithmically many lines, and no timer is involved: nothing to leak, and
// the behaviour is a pure function of the count, which is what makes it
// testable.
//
// `detail` is untrusted output from another process (`stderr` verbatim, a
// decoder message quoting the bad line) and is passed as a log FIELD, never
// interpolated into the message - so `LogSink`'s unconditional `redactValue`
// pass sees it and a token the CLI printed does not land in the log in clear.
import type { Logger, LogLevel } from '../log/logger';
import type { StreamDiagnostic } from './stream-service';

/**
 * Level per kind. All `warn`: in stream-json mode the CLI's stdout IS the
 * protocol, so anything arriving on the other two channels - unparseable
 * stdout, any stderr at all, a write to a closed stdin - is by definition
 * unexpected. None is `error`: fail-open means none of these stops a session,
 * and reserving `error` for what actually broke is what keeps it worth
 * grepping for.
 */
const LEVEL: Record<StreamDiagnostic['kind'], LogLevel> = {
  'parse-failure': 'warn',
  'overlong-line': 'warn',
  stderr: 'warn',
  'stdin-write-failed': 'warn',
};

/**
 * Ceiling on the throttle's bookkeeping. One integer per (session, kind), so
 * this is generous - a workspace would need 128 concurrent stream sessions to
 * reach it. On overflow the whole map is dropped rather than evicted one by
 * one: it holds no state anybody reads, and the only cost of forgetting is a
 * few extra log lines. That is strictly better than the alternative, which is
 * unbounded growth across a long-lived process.
 */
const MAX_TRACKED = 512;

/**
 * The sink to hand `StreamService`.
 *
 * Returns a plain function so the transport keeps knowing nothing about
 * `Logger` - the electron-free, logger-free property `stream-service.ts` was
 * built for, and the reason the diagnostic leaves through a callback in the
 * first place, is preserved by putting the translation HERE rather than there.
 */
export function createDiagnosticLogger(log: Logger): (d: StreamDiagnostic) => void {
  const seen = new Map<string, number>();
  return (d: StreamDiagnostic): void => {
    const key = `${d.sessionId} ${d.kind}`;
    const count = (seen.get(key) ?? 0) + 1;
    if (seen.size >= MAX_TRACKED && !seen.has(key)) seen.clear();
    seen.set(key, count);
    // 1, 2, 4, 8, ... - `count & (count - 1)` is zero only for powers of two.
    if ((count & (count - 1)) !== 0) return;
    log[LEVEL[d.kind]]('stream transport diagnostic', {
      sessionId: d.sessionId,
      kind: d.kind,
      detail: d.detail,
      count,
    });
  };
}
