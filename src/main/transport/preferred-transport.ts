// The app-wide transport override, read out of the environment (#381).
//
// Lifted out of `main/index.ts`'s `preferredTransport` callback by P2-E18-17
// so it can be tested at all: inline, the only way to reach the warn branch was
// to launch Electron with a typo in its environment, and the #404 audit found
// exactly zero coverage of a branch whose whole job is to stop a typo landing
// on the OPPOSITE transport in silence.
import type { Logger } from '../log/logger';
import type { TransportKind } from './transport';

/** The variable an app-wide override is spelled with. */
export const TRANSPORT_ENV_VAR = 'SWITCHBOARD_TRANSPORT';

/**
 * Which transport this app instance asks for, or `undefined` for "no opinion".
 *
 * `undefined` is not a third transport — it means the caller's own precedence
 * carries on below this (`sessions:create`: the card's stored choice wins over
 * this, and `DEFAULT_SESSION_TRANSPORT` loses to it).
 *
 * BOTH values are honoured, and that is the #381 change: `stream` was the only
 * spelling worth naming while the PTY was the default, and the moment Direct
 * became the default that spelling turned into a no-op while `pty` — the one
 * anybody would now reach for — was silently ignored. An env var that quietly
 * does nothing is worse than not having one.
 *
 * A typo WARNS rather than falling through quietly. It used to be harmless: it
 * fell through to the PTY, which was also the default. Now it falls through to
 * Direct, i.e. to the exact opposite of what someone setting this variable is
 * usually asking for, so the line in the log is the only thing between a
 * mistyped value and a very confusing session.
 */
export function parsePreferredTransport(
  value: string | undefined,
  warn: Logger['warn']
): TransportKind | undefined {
  if (value === 'stream' || value === 'pty') return value;
  // Unset is not a mistake and must stay silent — every launch that has never
  // heard of this variable comes through here. Only a value we could not use
  // is worth a line, empty string included: an env var set to nothing is a
  // launcher bug, not an opinion.
  if (value !== undefined) warn(`${TRANSPORT_ENV_VAR} ignored: expected "pty" or "stream"`, { value });
  return undefined;
}
