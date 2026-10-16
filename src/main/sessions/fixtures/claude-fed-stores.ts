// TEST SUPPORT (#1287): the control-path stores, taking raw Claude frames the
// way their tests have always been written — the `ClaudeFedFeed` pattern
// (#1286) for the four stores E40 item 04 moved onto neutral events.
//
// The stores themselves take only `EngineEvent`s now, and the permission
// router answers with a neutral `PermissionDecision`. Their tests keep the real
// Claude frames they were written against and push them through the REAL
// translator, and the router's answers are encoded by the REAL Claude
// `approvals` encoder before a test sees them. So each test checks the
// translator, the store and (for the router) Claude's answer frame together,
// and a reading or an answer that drifted from the one the store used to make
// itself fails here first.
import { translateClaudeFrame } from '../../providers/claude-events';
import { claudePermissionAnswer } from '../../providers/claude-controls';
import type { Logger } from '../../log/logger';
import type { EngineEvent, PermissionRequestEvent } from '../engine-events';
import {
  StreamPermissions,
  type ApplyStatus,
  type StreamPermissionsOptions,
} from '../stream-permissions';
import { StreamCommands } from '../stream-commands';
import { StreamModel } from '../stream-model';
import { StreamMode } from '../stream-mode';

/** What a raw frame means, through the real translator (`[]` for one it does not know). */
export function claudeEvents(frame: Record<string, unknown>): EngineEvent[] {
  return translateClaudeFrame(frame) ?? [];
}

/** The `permission-request` a raw `can_use_tool` frame becomes, or null. */
export function claudePermissionEvent(frame: Record<string, unknown>): PermissionRequestEvent | null {
  for (const ev of claudeEvents(frame)) if (ev.type === 'permission-request') return ev;
  return null;
}

/**
 * A raw-frame writer — what the router's first argument was before #1287 —
 * adapted to its neutral answer port through Claude's own encoder.
 */
export type FrameSink = (sessionId: string, msg: unknown) => boolean;

export function viaClaudeAnswers(send: FrameSink) {
  return (sessionId: string, requestId: string, decision: Parameters<typeof claudePermissionAnswer>[1]) =>
    send(sessionId, claudePermissionAnswer(requestId, decision));
}

export class ClaudeFedPermissions extends StreamPermissions {
  constructor(send: FrameSink, applyStatus: ApplyStatus, log: Logger, opts?: StreamPermissionsOptions) {
    super(viaClaudeAnswers(send), applyStatus, log, opts);
  }

  /** One raw Claude frame, translated and ingested. */
  offer(sessionId: string, frame: Record<string, unknown>): void {
    for (const ev of claudeEvents(frame)) this.ingest(sessionId, ev);
  }

  /** `willAutoAllow` for a raw frame: false for one that is not a request,
   *  which is what the predicate answered for any other frame. */
  willAutoAllowFrame(sessionId: string, frame: Record<string, unknown>): boolean {
    const ev = claudePermissionEvent(frame);
    return ev ? this.willAutoAllow(sessionId, ev) : false;
  }
}

export class ClaudeFedCommands extends StreamCommands {
  offer(sessionId: string, frame: Record<string, unknown>): void {
    for (const ev of claudeEvents(frame)) this.ingest(sessionId, ev);
  }
}

export class ClaudeFedModel extends StreamModel {
  offer(sessionId: string, frame: Record<string, unknown>): void {
    for (const ev of claudeEvents(frame)) this.ingest(sessionId, ev);
  }
}

export class ClaudeFedMode extends StreamMode {
  offer(sessionId: string, frame: Record<string, unknown>): void {
    for (const ev of claudeEvents(frame)) this.ingest(sessionId, ev);
  }
}
