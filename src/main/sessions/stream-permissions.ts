// can_use_tool -> the approval bar (P2-E18-07).
//
// THE REASON THIS EPIC EXISTS.
//
// Measured 2026-08-01: editing a file in a project's own `.claude/` folder
// prompted the owner TWICE — our bar, then the CLI's own terminal prompt six
// seconds after he allowed it. The CLI honours a hook's
// `permissionDecision:"allow"` for the ordinary permission layer and then
// applies its `.claude/` safety check ON TOP, which a hook verdict does not
// satisfy. His answer was discarded.
//
// The identical write arrives here as a `can_use_tool` control request, and
// answering it allow WRITES THE FILE with no second prompt (S-10 probe B). The
// same verdict is worth more from this channel than from a hook.
//
// Deliberately shaped like `HookListener`'s permission half — same
// `PermissionRequest`, same `onPermissionRequest` / `onPermissionResolved` /
// `pendingRequests` / `decide` — so `sessions/ipc.ts` wires it identically and
// the renderer's approval bar cannot tell the two apart. A second request type
// would mean a second bar to keep in step with the first.
import { PermissionRequest } from '../hooks/hook-listener';
import { Logger } from '../log/logger';
import { controlResponse } from '../../shared/stream-protocol';
import { SessionEvent } from './state-machine';

/** How we answer: the manager knows which transport a session is on. */
export type SendToSession = (sessionId: string, msg: unknown) => boolean;

/**
 * How a decision reaches the STATUS machine — `SessionManager.apply` (#310).
 *
 * REQUIRED, and that is the point. The hook path has had this since E2-05
 * (`HookListener` takes the manager in its options); the stream path shipped
 * without it, and nothing complained, because there was nothing to complain
 * with. A card sat in `needs-permission` from the moment `can_use_tool`
 * arrived until the CLI's NEXT `assistant`/`stream_event` — one whole tool
 * round trip, ~5s in Dan's dogfooding — with nothing held and nothing to
 * answer. Optional, it would go missing again the first time a call site
 * forgot, exactly as silently; required, forgetting is a compile error, which
 * is how the five existing call sites were found rather than hunted for.
 *
 * A narrow function rather than the manager itself, matching `send` beside it:
 * this router answers the CLI and moves a badge, and handing it the object that
 * can also spawn, kill and remove sessions would be handing it the ability to
 * do something it has no business doing.
 */
export type ApplyStatus = (sessionId: string, ev: SessionEvent) => void;

interface Pending {
  sessionId: string;
  /** the CLI's own request id — what the control_response must echo back */
  nativeRequestId: string;
  request: PermissionRequest;
}

export class StreamPermissions {
  private readonly pending = new Map<string, Pending>();
  private readonly requestListeners = new Set<(r: PermissionRequest) => void>();
  private readonly resolvedListeners = new Set<(requestId: string) => void>();

  constructor(
    private readonly send: SendToSession,
    private readonly applyStatus: ApplyStatus,
    private readonly log: Logger
  ) {}

  /**
   * Offer one `control_request` to the user. Ignores anything that is not
   * `can_use_tool` — `hook_callback` and `mcp_message` ride the same channel
   * and are plumbing, not questions.
   */
  offer(sessionId: string, msg: Record<string, unknown>): void {
    if (msg.type !== 'control_request') return;
    const req = msg.request as Record<string, unknown> | undefined;
    if (req?.subtype !== 'can_use_tool') return;

    const nativeRequestId = String(msg.request_id ?? '');
    if (!nativeRequestId) {
      // Unanswerable: with no id there is nothing to echo back, so offering it
      // would park the card on a question whose answer goes nowhere.
      this.log.warn('can_use_tool with no request_id — ignored', { sessionId });
      return;
    }
    // Namespaced so a stream request can never collide with a hook request id
    // in the single `decidePermission` channel they share.
    const requestId = `stream:${sessionId}:${nativeRequestId}`;
    if (this.pending.has(requestId)) return; // duplicate delivery

    const request: PermissionRequest = {
      requestId,
      sessionId,
      tool: String(req.tool_name ?? 'unknown'),
      input: (req.input as Record<string, unknown>) ?? {},
      source: 'stream',
      reason: typeof req.decision_reason === 'string' ? req.decision_reason : undefined,
      reasonType: typeof req.decision_reason_type === 'string' ? req.decision_reason_type : undefined,
      displayName: typeof req.display_name === 'string' ? req.display_name : undefined,
      suggestions: Array.isArray(req.permission_suggestions)
        ? (req.permission_suggestions as Array<Record<string, unknown>>)
        : undefined,
    };
    this.pending.set(requestId, { sessionId, nativeRequestId, request });
    this.log.info('stream permission requested', {
      sessionId,
      requestId,
      tool: request.tool,
      reasonType: request.reasonType,
    });
    for (const l of this.requestListeners) {
      try {
        l({ ...request });
      } catch (err) {
        // a broken subscriber must never strand the CLI (P6)
        this.log.error('permission request listener threw', { requestId, error: String(err) });
      }
    }
  }

  /**
   * Answer one.
   *
   * `updatedInput` echoes the input back unchanged: the CLI expects the tool
   * input with an allow, and it is the CLI's own input — we neither invent nor
   * edit it, which would be reimplementing a decision (P7).
   *
   * It also APPLIES `permission-resolved`, exactly as `HookListener.decide`
   * does (#310). `offer` is what put the session into `needs-permission` —
   * `streamStatusEvent` maps `can_use_tool` to `permission-held` — so answering
   * is the moment that state ends, and it is the only moment we can KNOW it has
   * ended. Leaving it to the stream meant waiting for the CLI to speak again,
   * which it does not do until the tool it just asked about has RUN: Dan
   * watched a Direct session sit on `needs-permission` for ~5s per gated call
   * with nothing held, which is precisely the render condition the terminal
   * handoff bar exists for (#125/#153).
   */
  decide(requestId: string, decision: 'allow' | 'deny', reason?: string): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);

    const payload =
      decision === 'allow'
        ? { behavior: 'allow', updatedInput: p.request.input }
        : { behavior: 'deny', message: reason || 'Denied in switchboard' };

    const sent = this.send(p.sessionId, controlResponse(p.nativeRequestId, payload));
    // Before `notifyResolved`, and unguarded, so this half stays a mirror image
    // of `HookListener.decide` — a divergence between the two would be a trap
    // for whoever reads one to understand the other, which is the shape of the
    // whole class (see the header).
    this.applyStatus(p.sessionId, { kind: 'permission-resolved' });
    this.log.info('stream permission decided', {
      requestId,
      decision,
      sessionId: p.sessionId,
      delivered: sent,
    });
    this.notifyResolved(requestId);
    return sent;
  }

  /**
   * Deny everything outstanding for a session, e.g. its card was closed.
   *
   * DENY rather than drop: an unanswered control request leaves the CLI waiting
   * for ever, and a wedged session is worse than a refused tool call — the user
   * can always ask again. Same fail-safe posture as the hook path's release.
   *
   * Deliberately does NOT apply `permission-resolved`, and that is the same
   * deliberate choice `HookListener.release` makes — it is the reason #310's
   * fix lands in `decide` alone. Both callers of this are teardowns
   * (`ipc.ts` → `releaseHeldPermissions`, on a closed card and on a session's
   * own exit), and its comment there names the hazard: "a status transition
   * here would walk a `needs-permission` session to `working` a beat before its
   * exit lands." There is nobody to show `working` to and nothing left to do
   * it. Answering the CLI is the whole job here; moving the badge is not.
   */
  forgetSession(sessionId: string, why: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      this.send(p.sessionId, controlResponse(p.nativeRequestId, { behavior: 'deny', message: why }));
      this.log.info('stream permission auto-denied', { requestId: id, sessionId, why });
      this.notifyResolved(id);
    }
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => ({ ...p.request }));
  }

  onPermissionRequest(l: (r: PermissionRequest) => void): () => void {
    this.requestListeners.add(l);
    return () => this.requestListeners.delete(l);
  }

  onPermissionResolved(l: (requestId: string) => void): () => void {
    this.resolvedListeners.add(l);
    return () => this.resolvedListeners.delete(l);
  }

  private notifyResolved(requestId: string): void {
    for (const l of this.resolvedListeners) {
      try {
        l(requestId);
      } catch (err) {
        this.log.error('permission resolved listener threw', { requestId, error: String(err) });
      }
    }
  }
}
