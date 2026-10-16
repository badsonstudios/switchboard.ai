// TEST SUPPORT (#1287): a provider that declares a REDUCED set of controls.
//
// The grey-out ("Not available with <AI>") cannot be seen with only Claude
// installed — Claude declares every control — so this is the AI that lacks
// most of them. It has `approvals` and `interrupt` and nothing else: no model
// list, no effort, no context meter, no mode, no slash commands, no live MCP,
// and NO PROMPT, so it also proves a session that cannot be driven is still
// one that does not throw.
//
// It records what the host asked of it, in neutral words, so a test can say
// what was sent without reading any wire.
import type { ControlCapability, PermissionDecision, SessionControls } from '../engine-controls';

export const REDUCED_AI_NAME = 'Reduced (test)';

export interface ReducedControlsLog {
  answers: Array<{ sessionId: string; requestId: string; decision: PermissionDecision }>;
  interrupts: string[];
  frames: Array<{ sessionId: string; frame: Record<string, unknown> }>;
  forgotten: string[];
}

/** A `controls` capability with only approvals and interrupt, and a log of what it was asked. */
export function reducedControls(log: ReducedControlsLog = emptyLog()): ControlCapability & { log: ReducedControlsLog } {
  return {
    log,
    createControls(session): SessionControls {
      return {
        approvals: {
          answer(requestId, decision) {
            log.answers.push({ sessionId: session.id, requestId, decision });
            return true;
          },
        },
        interrupt: {
          interrupt() {
            log.interrupts.push(session.id);
            return true;
          },
        },
        receive(frame) {
          log.frames.push({ sessionId: session.id, frame });
        },
        forget() {
          log.forgotten.push(session.id);
        },
      };
    },
  };
}

export function emptyLog(): ReducedControlsLog {
  return { answers: [], interrupts: [], frames: [], forgotten: [] };
}
