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
 * How much objection text a denial may carry (P2-E22-02, #973).
 *
 * Here rather than beside either end of the wire, because BOTH ends need the
 * same number and they need it for different jobs: the renderer's field sets
 * `maxLength` to it, so the user is stopped at the edge and can see it; main
 * clamps to it, because a `maxLength` is a suggestion an untrusted renderer
 * makes to itself. Two constants that agreed on the day they were written is
 * exactly how the one in `sessions/ipc.ts` (a bare `slice(0, 500)`) ended up
 * being the only cap in the app and living nowhere near the router that needed
 * it.
 *
 * 500 characters is that same number, kept: it is several sentences of prose,
 * which is what an objection is, and the message it lands in is read by a model
 * with a context window to spend.
 */
export const MAX_DENIAL_REASON_CHARS = 500;

/**
 * Answering a held request, as every renderer surface spells it (#973).
 *
 * ⚠️ ONE DECLARATION BECAUSE THIS SIGNATURE HAS NOW LOST AN ARGUMENT TWICE.
 * `PanelContext.onDecide` declared `(decision, allowAll?)` while the real
 * function had grown `updatedInput` (#563) and then `reason` (#973) — and it
 * TYPECHECKED throughout, because a function taking fewer parameters is
 * assignable to one taking more. It worked at runtime only because the value
 * being assigned happened to be the real four-parameter `SessionGrid.decide`;
 * a panel contribution written against the declared type would have compiled,
 * run, and silently been unable to answer a question or deny with a reason.
 *
 * That is the same failure `PermissionRequest` was extracted for — a boundary
 * type whose whole job is to catch a dropped field quietly saying the field did
 * not exist. So it lives beside it, and the three ends import it rather than
 * three people happening to type the same parameters.
 */
export type DecideHeld = (
  decision: 'allow' | 'deny',
  /** also grant every future gated call in this LIVE session */
  allowAll?: boolean,
  /** the answered `AskUserQuestion` input (#563) — ignored for any other tool */
  updatedInput?: unknown,
  /** the user's objection text on a deny (#973) — carried, never substituted */
  reason?: string
) => void;

/**
 * What a LIVE session is standing on — §5.16's ladder, as state (#974).
 *
 * Both rungs in one shape because the surface shows them together and a user
 * does not think of them as two features: "what has this session been told it
 * may do without asking me." They are two SETS in main, deliberately (see
 * `StreamPermissions.filesAllowed`), because revoking one must not touch the
 * other — but that is a storage fact, not a presentation one.
 *
 * `files` are the FOLDED keys main is matching on, not the spellings the user
 * clicked. A list that showed the original would be showing something other than
 * the grant in force.
 */
export interface StandingGrants {
  /** "Always allow for this session" — the wider rung */
  allowAll: boolean;
  /** resolved, host-folded absolute paths, sorted */
  files: string[];
}

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
  /**
   * When main stops holding this and declines it, telling the session nobody
   * answered (epoch ms, #1202). Absent = no deadline: a question waits for a person.
   */
  deadline?: number;
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
