// The `sessions:permissionRequest` / `sessions:pendingPermissions` wire shape
// (#312).
//
// It lived in THREE places — main's `hook-listener`, preload's bridge signature,
// and the renderer's `IncomingPermission` — and the three had already drifted:
// main learned `reasonType`, `displayName` and `suggestions` from the stream
// transport (P2-E18-07) and the other two never heard about it. Nothing broke,
// because `send` passes the object through whole and the renderer only reads
// `reason`. That is precisely the failure this file prevents: a boundary type
// whose entire job is to catch a dropped field was quietly saying the field did
// not exist, so the compiler would have blessed dropping it.
//
// One declaration, imported by all three ends, so they agree by TYPE rather than
// by three people happening to type the same fields.

/**
 * An in-flight permission request, as main knows it.
 *
 * ONE shape for both transports (P2-E18-07): a held `PreToolUse` hook, or a
 * `can_use_tool` control request over stream-json. The approval bar must not
 * care which — the user is answering the same question either way, and a second
 * request type would mean a second bar to keep in step with the first.
 *
 * The optional fields exist only on the stream path, because the hook payload
 * simply does not carry them. That asymmetry is the entire argument for the
 * migration, so it is worth seeing in the type: the CLI tells the
 * permission-prompt channel WHY it is asking and what would satisfy it, and
 * tells a hook nothing.
 */
export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  tool: string;
  input: Record<string, unknown>;
  /** Where it came from. Absent = hook (every pre-E18 request). */
  source?: 'hook' | 'stream';
  /** Human-readable prose from the CLI — renderable, and we did not write it. */
  reason?: string;
  /** e.g. 'safetyCheck' — the `.claude/` guard that started this epic. */
  reasonType?: string;
  /** The CLI's own label for the tool, when it differs from `tool`. */
  displayName?: string;
  /** Remedies the CLI suggests, e.g. switch this session to acceptEdits. */
  suggestions?: Array<Record<string, unknown>>;
}

/**
 * What actually crosses the bridge.
 *
 * `cardId` is the one field main adds on the way out (`sessions/ipc.ts` resolves
 * it from the live id, because only the IPC layer knows the card↔session map):
 * main routes, and the card filters. Everything else is the request verbatim.
 */
export interface PermissionRequestDto extends PermissionRequest {
  /** which card the request belongs to; absent = no card owns this session */
  cardId?: string;
}
