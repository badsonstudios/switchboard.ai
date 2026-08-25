// The MCP Manager's IPC seam (§5.17, #632).
//
// Two channels, both read-only, both answering the same question about one
// folder from two different sources:
//
//   mcp:list    the servers, off the config files. Cheap — two file reads.
//   mcp:health  whether the CLI is connected to them. Expensive — it connects
//               to every server, so it is a SEPARATE call the pane makes after
//               it has already drawn, never a field on the listing.
//
// HOW THIS SEAM SAYS NO: by resolving, never by throwing — the house shape
// `group-ipc.ts`'s header argues for at length. `mcp:list` answers an
// inventory with `unreadable` scopes named in it; `mcp:health` answers an empty
// map. Neither has a failure mode that reaches the renderer as a rejection,
// which matters more here than in most families because both are driven from a
// modal the user opened deliberately: an exception behind a dialog is a dialog
// that does nothing.
import { IpcBroker } from '../ipc/broker';
import { Logger } from '../log/logger';
import { readInventory } from './config';
import { checkHealth } from './health';
import type { McpHealthWire, McpInventoryWire } from '../../shared/mcp';

export interface McpIpcDeps {
  broker: IpcBroker;
  log: Logger;
  /**
   * Is this a folder we are allowed to answer about?
   *
   * §5.29: the folder arrives from the renderer, and it decides which
   * `.mcp.json` gets read and which directory a child process is spawned in.
   * Neither may be an arbitrary caller-supplied path. The gate is the same one
   * the rest of the app uses — the folders of the sessions that actually exist
   * — so this cannot become a way to probe the disk or to run the CLI
   * somewhere it was never invited.
   */
  isSessionFolder: (folder: string) => boolean;
}

/**
 * The empty answer, shaped.
 *
 * A refusal still has to be an inventory, because the pane renders whatever it
 * is handed — and "no servers, nothing unreadable" is the honest thing to draw
 * for a folder we decline to look at. The REASON goes to the log, at the same
 * level `groups:*` and `sessions:*` use, so one filter finds every refused call
 * in the app.
 */
const empty = (folder: string): McpInventoryWire => ({ folder, servers: [], unreadable: [] });

export function registerMcpIpc(deps: McpIpcDeps): void {
  const { broker, log } = deps;

  /** One gate, both channels — so they cannot drift into disagreeing about
   *  which folders are answerable. */
  const allowed = (channel: string, folder: unknown): folder is string => {
    if (typeof folder !== 'string' || !folder) {
      log.warn(`${channel} refused: folder must be a non-empty string`);
      return false;
    }
    if (!deps.isSessionFolder(folder)) {
      log.warn(`${channel} refused: not a session folder`, { folder });
      return false;
    }
    return true;
  };

  // The listing. Synchronous work behind an async channel: two `readFileSync`
  // calls on small local JSON files, which is the same trade `sessions:cards`
  // already makes. If either ever becomes slow enough to matter, the fix is a
  // watch-and-cache, not a thread.
  broker.handle('mcp:list', (_e, folder: unknown): McpInventoryWire => {
    if (!allowed('mcp:list', folder)) return empty(typeof folder === 'string' ? folder : '');
    return readInventory(folder, log);
  });

  // The health check. It SPAWNS THE CLI, which is why it is its own channel and
  // why the pane calls it after painting: a remote server behind a VPN that is
  // off does not fail fast. `checkHealth` owns the timeout and answers `{}` for
  // every failure, so there is nothing here to catch — but the folder gate
  // still runs first, because this is the one path in the family that starts a
  // process in a caller-named directory.
  broker.handle('mcp:health', async (_e, folder: unknown): Promise<McpHealthWire> => {
    if (!allowed('mcp:health', folder)) {
      return { folder: typeof folder === 'string' ? folder : '', states: {} };
    }
    return { folder, states: await checkHealth(folder) };
  });
}
