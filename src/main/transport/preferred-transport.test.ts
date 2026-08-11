// P2-E18-17 — the SWITCHBOARD_TRANSPORT override, and the typo that must warn.
//
// The #404 audit's finding: this parser had zero coverage, and its interesting
// branch is the one where a mistyped value now lands on the OPPOSITE transport
// from the one the person setting the variable asked for. The extraction out of
// `main/index.ts` exists so that branch is reachable without launching Electron.
import { describe, it, expect, vi } from 'vitest';
import { parsePreferredTransport, TRANSPORT_ENV_VAR } from './preferred-transport';
import { DEFAULT_SESSION_TRANSPORT } from './transport';

/** a `Logger['warn']` that remembers what it was told */
function recordingWarn(): { warn: (m: string, f?: Record<string, unknown>) => void; calls: Array<[string, Record<string, unknown> | undefined]> } {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  return { warn: (m, f) => void calls.push([m, f]), calls };
}

describe('parsePreferredTransport (#381, extracted by P2-E18-17)', () => {
  it('reads both spellings — `pty` is not the no-op it was before #381', () => {
    const a = recordingWarn();
    expect(parsePreferredTransport('pty', a.warn)).toBe('pty');
    expect(parsePreferredTransport('stream', a.warn)).toBe('stream');
    expect(a.calls).toEqual([]);
  });

  it('unset is "no opinion", silently — every ordinary launch comes through here', () => {
    const a = recordingWarn();
    expect(parsePreferredTransport(undefined, a.warn)).toBeUndefined();
    expect(a.calls).toEqual([]);
  });

  // THE branch this extraction exists for. A typo used to be harmless (it fell
  // through to the PTY, which was also the default); since #381 it falls
  // through to Direct — the exact opposite of what someone typing
  // SWITCHBOARD_TRANSPORT=ptty is asking for. Deleting the warn line leaves
  // every other test in this file green.
  it('a typo WARNS rather than silently landing on the opposite transport', () => {
    const a = recordingWarn();

    expect(parsePreferredTransport('ptty', a.warn)).toBeUndefined();

    expect(a.calls).toHaveLength(1);
    expect(a.calls[0][0]).toContain(TRANSPORT_ENV_VAR);
    // the value is in the log line's fields, or the reader cannot see the typo
    expect(a.calls[0][1]).toEqual({ value: 'ptty' });
  });

  it('the warning names both accepted spellings, so the log line is the fix', () => {
    const a = recordingWarn();
    parsePreferredTransport('terminal', a.warn);
    expect(a.calls[0][0]).toContain('pty');
    expect(a.calls[0][0]).toContain('stream');
  });

  // Case and whitespace are NOT quietly accepted — a value we did not
  // understand is reported, never guessed at.
  it.each(['PTY', 'Stream', ' pty', 'pty ', ''])('%o is refused and reported', (v) => {
    const a = recordingWarn();
    expect(parsePreferredTransport(v, a.warn)).toBeUndefined();
    expect(a.calls).toHaveLength(1);
  });

  // What `undefined` means downstream, pinned here because the parser is where
  // someone would be tempted to "helpfully" return a transport instead: it is
  // NOT a third transport, it is the caller carrying on with its own
  // precedence (`sessions:create` — card, then this, then the default).
  it('never answers the default itself — that decision belongs to the caller', () => {
    const a = recordingWarn();
    expect(parsePreferredTransport('nonsense', a.warn)).not.toBe(DEFAULT_SESSION_TRANSPORT);
    expect(parsePreferredTransport('nonsense', a.warn)).toBeUndefined();
  });

  it('is the shape a Logger can be passed to directly', () => {
    const warn = vi.fn();
    parsePreferredTransport('nope', warn);
    expect(warn).toHaveBeenCalledOnce();
  });
});
