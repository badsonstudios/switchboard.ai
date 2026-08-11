// The `fs:read` channel (P2-E16-01, §5.30 + §5.23 + §5.29).
//
// The whole channel is: check the scope, read the cap, log anything refused.
// It is its own family rather than another `sessions:*` method because the
// capability is its own — `fs.read`, not `fs.probe`, and not `sessions.read`.
// §5.30: "The existing `fs.probe` reveals only a path's existence and type;
// reading arbitrary file CONTENTS is strictly more power and must not ride in
// on it."
//
// EVERY REFUSAL IS LOGGED, in the wording `main/sessions/ipc.ts` established
// (`<channel> refused: <reason>`), so one log filter finds every refused call
// in the app. That matters more here than for a mutation: a refused read is
// either a link pointing somewhere it should not, or a scope that is wrong —
// and both are things you only find out about if they are written down.
import { IpcBroker } from '../ipc/broker';
import type { Logger } from '../log/logger';
import { MAX_FILE_READ_BYTES, FileReadResult } from '../../shared/ipc/fs';
import { readCappedText } from './read-file';
import { ReadScope } from './read-scope';

export interface FsIpcDeps {
  broker: IpcBroker;
  log: Logger;
  scope: ReadScope;
  /** the cap, overridable for tests; production uses `MAX_FILE_READ_BYTES` */
  cap?: number;
}

export function registerFsIpc(deps: FsIpcDeps): void {
  const cap = deps.cap ?? MAX_FILE_READ_BYTES;

  deps.broker.handle('fs:read', async (_e, target: unknown): Promise<FileReadResult> => {
    const decision = deps.scope.resolve(target);
    if (!decision.ok) {
      deps.log.warn(`fs:read refused: ${decision.reason}`, {
        // The path the CALLER asked for, not the resolved one — when the answer
        // is "out of scope" the interesting string is the one that was
        // requested. Stringified because an untyped caller can send anything,
        // and a log line is not the place to find that out.
        path: typeof target === 'string' ? target : String(target),
      });
      return decision;
    }
    const result = await readCappedText(decision.path, cap);
    if (!result.ok) {
      deps.log.warn(`fs:read refused: ${result.reason}`, { path: decision.path });
      return result;
    }
    if (result.truncated) {
      // Not a refusal — the caller got bytes. Worth a line anyway: "the file
      // looked wrong in the viewer" and "the file is 900 MB" are the same
      // report from the user's side.
      deps.log.info('fs:read truncated at the cap', {
        path: decision.path,
        size: result.size,
        cap,
      });
    }
    return result;
  });
}
