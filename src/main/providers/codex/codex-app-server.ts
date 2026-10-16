// One short-lived `codex app-server` exchange (E40 item 07, #1290): spawn,
// `initialize` + `initialized`, ONE request, close. Used for the two things the
// ACP adapter does not hand an ACP client in structured form — plan limits
// (`account/rateLimits/read`) and the login state (`account/read`) — and for
// nothing else. It is a reader, not an engine: no thread, no turn, no tokens.
//
// THE CONTRACT IS MEASURED, not assumed (`spike/findings/e40-codex-acp.md`,
// "The `codex app-server` comparison", and its #1290 addendum):
//   - stdio, newline-delimited JSON; 0 non-JSON stdout lines in every run;
//   - its frames OMIT `"jsonrpc":"2.0"` (`{"id":1,"result":{...}}`), so replies
//     are matched by `id` alone;
//   - it pushes notifications we did not ask for (`remoteControl/status/changed`,
//     `account/updated`); they are ignored;
//   - it exits on stdin EOF in ~250 ms logged in, ~900 ms logged out.
//
// FAIL-OPEN, every path: a missing CLI, a spawn that dies, an error reply, a
// frame we do not understand, or the hard deadline all settle as `ok: false`;
// nothing here throws or rejects. The child is always closed — stdin EOF first,
// then `StreamSession`'s tree kill after its grace — so a hung app-server is
// never left behind.
import { errorText } from '../../../shared/error-text';
import os from 'os';
import { StreamSession } from '../../transport/stream-service';

/** The handle the exchange needs on the child; a `StreamSession` in the app. */
export interface AppServerChild {
  send(msg: unknown): void;
  onMessage(l: (m: Record<string, unknown>) => void): () => void;
  onExit(l: (code: number) => void): () => void;
  kill(): void;
}

export type AppServerSpawn = (cliPath: string) => AppServerChild;

/** The real spawn: `cmd.exe /c codex.cmd app-server` on Windows (`launchSpec`). */
export const spawnAppServer: AppServerSpawn = (cliPath) =>
  new StreamSession({
    id: 'codex-app-server',
    command: cliPath,
    args: ['app-server'],
    // Not a project: no thread is started, so nothing is written here. The
    // temp dir keeps the child from inheriting the app's own directory.
    cwd: os.tmpdir(),
    killGraceMs: 2_000,
  });

export type AppServerAnswer = { ok: true; result: Record<string, unknown> } | { ok: false; reason: string };

/** The whole exchange, spawn to answer, at most this long. */
export const APP_SERVER_DEADLINE_MS = 10_000;

const CLIENT_INFO = { name: 'switchboard', title: 'switchboard.ai', version: '0.0.0' };

/**
 * Ask `codex app-server` one question. Resolves once, with the request's
 * `result` or why there is none. Never rejects.
 */
export function askAppServer(
  cliPath: string,
  method: string,
  params: Record<string, unknown> | undefined,
  opts: { spawn?: AppServerSpawn; deadlineMs?: number; clientVersion?: string; signal?: AbortSignal } = {}
): Promise<AppServerAnswer> {
  return new Promise((resolve) => {
    let child: AppServerChild | undefined;
    let settled = false;
    const offs: Array<() => void> = [];
    const finish = (answer: AppServerAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      for (const off of offs) {
        try {
          off();
        } catch {
          /* a listener that cannot be removed is the child's problem */
        }
      }
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      resolve(answer);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timed out' }),
      opts.deadlineMs ?? APP_SERVER_DEADLINE_MS
    );
    timer.unref?.();
    // the caller's deadline ends it the same way, child killed
    const onAbort = (): void => finish({ ok: false, reason: 'cancelled' });
    if (opts.signal?.aborted) {
      finish({ ok: false, reason: 'cancelled' });
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      child = (opts.spawn ?? spawnAppServer)(cliPath);
    } catch (err) {
      finish({ ok: false, reason: `could not start: ${errorText(err)}` });
      return;
    }
    const c = child;
    offs.push(c.onExit((code) => finish({ ok: false, reason: `exited (${code}) before answering` })));
    offs.push(
      c.onMessage((m) => {
        // A request FROM the server carries a method, and its ids are its own:
        // never mistake one for our reply. It is refused rather than left
        // hanging (none was seen without a thread, but nothing here can do one).
        if (m.method !== undefined) {
          if (m.id !== undefined && m.id !== null) {
            c.send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported by this client' } });
          }
          return;
        }
        // A reply is matched on `id`: these frames carry no `jsonrpc`.
        if (m.id === 1) {
          if (m.error !== undefined || !isObject(m.result)) {
            finish({ ok: false, reason: `initialize refused: ${errorOf(m.error)}` });
            return;
          }
          c.send({ jsonrpc: '2.0', method: 'initialized' });
          c.send({ jsonrpc: '2.0', id: 2, method, ...(params ? { params } : {}) });
          return;
        }
        if (m.id === 2) {
          if (m.error !== undefined) finish({ ok: false, reason: errorOf(m.error) });
          else if (isObject(m.result)) finish({ ok: true, result: m.result });
          else finish({ ok: false, reason: 'an answer that is not an object' });
        }
        // any other reply id is not ours, and is ignored
      })
    );
    c.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { ...CLIENT_INFO, version: opts.clientVersion ?? CLIENT_INFO.version },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function errorOf(e: unknown): string {
  if (isObject(e) && typeof e.message === 'string') {
    return typeof e.code === 'number' ? `${e.message} (${e.code})` : e.message;
  }
  return 'no reason given';
}
