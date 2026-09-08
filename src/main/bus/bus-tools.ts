// The bus child's BEHAVIOUR (P2-E11-02) — everything except the stdin wiring.
//
// Split from `bus-server.ts` for the reason `fake-stream-protocol.ts` is split
// from `fake-stream-cli.ts`: an entry point runs its wiring at import, so a
// test that imports it inherits a stdin listener and a `process.exit` on end.
// All the logic worth pinning lives here, unit-tested without spawning
// anything; `bus-server.ts` is argv and pipes, proven end to end by
// `npm run check:bus`.
//
// RUNS UNDER `ELECTRON_RUN_AS_NODE` in a child process, so this file and
// everything it imports may use Node builtins only — no Electron, no
// `SessionQueries`, no IPC. `bus-tools.test.ts` asserts that against the source
// text of the whole child bundle, because the value is not that it is true
// today but that it stays true after everyone stops looking.
import { askHost } from './pipe-client';
import { Dispatch, ToolDescriptor, ToolResult, textResult } from './protocol';

/**
 * The outer bound on any single tool call, enforced by `apply`.
 *
 * Comfortably above `DEFAULT_HOST_TIMEOUT_MS` so the pipe client's own deadline
 * is the one that normally fires and produces the better message. This exists
 * for the handler that never returns at all.
 */
export const TOOL_DEADLINE_MS = 20_000;

export const TOOLS: readonly ToolDescriptor[] = [
  {
    name: 'list_sessions',
    // Written for a model that has never heard of switchboard. #760 measured
    // that MCP tool SCHEMAS are deferred behind ToolSearch while tool NAMES are
    // visible, so this text is what decides whether the bus gets discovered at
    // all — and an agent given a prompt naming no tool and no server found and
    // called it unaided. That makes this string load-bearing, not decoration.
    description:
      'List the other AI coding sessions currently open alongside this one in switchboard, ' +
      "with each one's name, project folder and status. Use this when the user refers to " +
      'another session, asks what else is running, or when you need to know which sibling to ' +
      'ask about work happening outside this project folder.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/**
 * The session list as text, because the consumer is a language model.
 *
 * The ID IS INCLUDED beside the name on purpose. Names are not unique — two
 * checkouts of one repo is the ordinary way to collide — and
 * `SessionQueries.resolve` REFUSES an ambiguous name rather than guessing. An
 * agent that had only ever seen names would have no way to act on that refusal.
 *
 * Tolerant of shapes it did not expect: this renders data that crossed a pipe,
 * and a host that answered something odd should degrade to a readable line
 * rather than throw inside a tool call.
 */
export function renderSessions(sessions: unknown, callerId: unknown): string {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return 'No sessions are open in switchboard.';
  }
  const lines = sessions.map((raw) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const mine = s.id !== undefined && s.id === callerId ? ' (this session)' : '';
    const bits = [s.status, s.folder, s.providerId].filter((b) => typeof b === 'string' && b !== '');
    const tail = bits.length > 0 ? ` — ${bits.join(' — ')}` : '';
    return `- ${asText(s.name, '(unnamed)')} [id ${asText(s.id, '?')}]${mine}${tail}`;
  });
  const n = sessions.length;
  return `${n} session${n === 1 ? '' : 's'} open in switchboard:\n${lines.join('\n')}`;
}

function asText(v: unknown, fallback: string): string {
  return typeof v === 'string' && v !== '' ? v : fallback;
}

export interface ChildConfig {
  pipePath: string | null;
  tokenPath: string | null;
  /** Seam for tests; defaults to the real pipe client. */
  ask?: typeof askHost;
  timeoutMs?: number;
  /** Where a failure's platform detail goes. stderr in the child; absent in
   *  tests. Deliberately NOT the tool content — see `hostError`. */
  log?: (message: string) => void;
}

/**
 * Build the `tools/call` handler.
 *
 * EVERY failure comes back as `isError` CONTENT rather than a JSON-RPC error.
 * A protocol error is a transport fault the model cannot read and cannot act
 * on; this is text it can — and "switchboard is not reachable, carry on without
 * it" is something an agent handles gracefully. That is P6 (fail-open) at the
 * one boundary in this codebase that faces a language model directly.
 */
export function makeCallTool(
  config: ChildConfig
): (name: string, args: Record<string, unknown>) => Promise<ToolResult> {
  const ask = config.ask ?? askHost;
  // `args` is threaded through even though `list_sessions` takes none. Without
  // it, `dispatch` normalises the model's arguments carefully and this drops
  // them on the floor one line later — and #764's `get_session_output(ref,
  // lastN)` is the first tool that would notice, by silently ignoring `lastN`.
  return async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const { pipePath, tokenPath } = config;
    if (!pipePath || !tokenPath) {
      // A misconfiguration, reported rather than exited on — see
      // `bus-server.ts`'s header for why this process never dies at startup.
      return textResult(
        'The switchboard bus is not configured for this session, so information about other ' +
          'sessions is unavailable. Continue without it.',
        true
      );
    }
    try {
      const reply = await ask({
        pipePath,
        tokenPath,
        request: { op: name, args },
        timeoutMs: config.timeoutMs,
      });
      if (reply.ok !== true) {
        const reason = asText(reply.reason, 'the host refused the request');
        return textResult(`switchboard could not answer: ${reason}`, true);
      }
      return textResult(renderSessions(reply.sessions, reply.callerId));
    } catch (err) {
      // The platform code goes to stderr, not to the model. See `hostError`.
      const detail = (err as { detail?: unknown } | undefined)?.detail;
      if (typeof detail === 'string' && detail !== '') config.log?.(`${messageOf(err)} (${detail})`);
      // CAUSE-NEUTRAL on purpose. `askHost` distinguishes a host that cannot be
      // reached from a token that cannot be read, and an outer sentence that
      // said "not reachable" would flatten the second back into the first and
      // state it as fact — sending whoever reads the log to the wrong end of
      // the channel. The parenthetical carries the real cause; the advice is
      // the same either way.
      return textResult(
        'switchboard could not answer this request, so information about other sessions is ' +
          `unavailable right now (${messageOf(err)}). Continue without it.`,
        true
      );
    }
  };
}

function messageOf(err: unknown): string {
  const m = (err as Error | undefined)?.message;
  return typeof m === 'string' && m !== '' ? m : String(err);
}

/**
 * Act on one dispatch decision.
 *
 * The `pending` arm is the ONLY place `run()` is invoked, and it runs after
 * `dispatch` has already returned — so by construction every handshake method
 * has been answered from a constant before anything can block. That ordering is
 * #760's ~32-second finding turned into a shape rather than a rule to remember.
 */
export function apply(
  d: Dispatch,
  write: (msg: unknown) => void,
  onBug: (err: unknown) => void = () => {},
  deadlineMs: number = TOOL_DEADLINE_MS
): void {
  if (d.kind === 'none') return;
  if (d.kind === 'reply') {
    write(d.message);
    return;
  }
  // A DEADLINE OF OUR OWN, belt and braces over `askHost`'s. Today "never
  // hangs" holds only because the one tool happens to go through a client that
  // owns a timer — which is a property of the current implementation, not of
  // this layer. Since the whole file is arranged to make that guarantee
  // structural rather than remembered, the guarantee should not depend on
  // whoever writes #764's tools remembering it either.
  let answered = false;
  const answer = (result: ToolResult): void => {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    write({ jsonrpc: '2.0', id: d.id, result });
  };
  const timer = setTimeout(() => {
    onBug(new Error(`tool handler exceeded ${deadlineMs}ms without answering`));
    answer(textResult('switchboard took too long to answer this call.', true));
  }, deadlineMs);
  timer.unref?.();

  void d.run().then(
    (result) => answer(result),
    (err) => {
      // `makeCallTool` catches its own failures, so reaching here means a bug
      // in it rather than a host outage. Answered anyway: an id left unanswered
      // is precisely the hang this whole channel is arranged to prevent, and a
      // bug of ours must not cost the agent its turn.
      onBug(err);
      answer(textResult('switchboard failed to answer this call.', true));
    }
  );
}
