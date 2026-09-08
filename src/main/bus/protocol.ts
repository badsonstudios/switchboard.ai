// The Session Bus's MCP wire protocol (P2-E11-02, §5.4) — pure, no I/O.
//
// WHY HAND-ROLLED, AND WHY NOT `@modelcontextprotocol/sdk`
// --------------------------------------------------------
// Measured, not argued: #760's probe server was 194 lines with comments, took
// zero dependencies, and satisfied the real `claude` CLI completely —
// `initialize` → `notifications/initialized` → `tools/list` → `tools/call`.
// Four methods is the entire surface the bus needs, and this repo runs lean.
//
// Two limits that come with that choice, named here rather than discovered
// later:
//  - we ECHO the client's proposed `protocolVersion` instead of negotiating.
//    Correct for one known client, wrong in general. `FALLBACK_PROTOCOL_VERSION`
//    is what we answer when a client proposes nothing.
//  - `ping` is implemented; #760 measured that no client ever called it, so it
//    is untested against a real peer. Cancellation, progress, resources and
//    prompts are not implemented at all.
//
// ── WHY `dispatch` IS SYNCHRONOUS AND RETURNS A UNION ───────────────────────
//
// This is the shape of #760's most expensive finding. A server that starts and
// never speaks MCP moves a session's first token from 3.0 s to 35.2 s — a ~32 s
// stall against what looks like a ~30 s connect timeout. The turn does finish,
// so fail-open survives in letter and not in spirit, and it is exactly the
// failure our own bug would produce: connect a pipe, take a lock, or read a
// workspace ahead of the handshake and every session pays half a minute.
//
// "Remember to answer `initialize` first" is not a mechanism. So `dispatch` is
// a PURE SYNCHRONOUS FUNCTION returning a union, and only `tools/call` can
// carry a `pending` arm. `initialize` is a `reply` built from a constant and an
// echo — there is no await it could acquire without changing this signature,
// and `protocol.test.ts` asserts the arm rather than timing the answer. A
// timing test would pass on a fast machine with the bug in it.
export const FALLBACK_PROTOCOL_VERSION = '2025-11-25';

/**
 * The most we will accept on one line before treating the peer as hostile.
 *
 * Framing is newline-delimited JSON, so a peer that never sends a newline is a
 * peer that grows our buffer without bound. 1 MB is far above any real MCP
 * message and far below anything that matters to a desktop app.
 *
 * BOTH BOUNDS MATTER and `protocol.test.ts` asserts both. Too high is the
 * obvious risk; too LOW is the quiet one, because `LineReader` is deliberately
 * unrecoverable — a limit a legitimate message could cross would poison the
 * reader and cost that session its bus for the rest of its life, silently.
 *
 * Measured in UTF-16 code units (`string.length`), not bytes, so the name is
 * optimistic by up to 3x for non-ASCII. Harmless at this magnitude: the bound
 * exists to stop unbounded growth, not to meter anything precisely.
 */
export const MAX_LINE_BYTES = 1_000_000;

export interface ToolDescriptor {
  name: string;
  /**
   * What the agent reads to decide whether to call this.
   *
   * Load-bearing, not decoration. #760 measured that MCP tool SCHEMAS are
   * deferred behind `ToolSearch` while tool NAMES are visible — so the
   * description is what does the discovery work, and an agent given a prompt
   * naming no tool and no server found and called the bus unaided. Write these
   * for a model that has never heard of switchboard.
   */
  description: string;
  inputSchema: Record<string, unknown>;
}

/** An MCP tool result. `isError` is a readable failure, not a protocol fault. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface JsonRpcReply {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * What to do with one inbound message.
 *
 * `none` is not "nothing went wrong" — it is "this was a notification and JSON-
 * RPC forbids answering it, even to refuse". Answering a notification is a
 * protocol violation that some clients treat as fatal.
 */
export type Dispatch =
  | { kind: 'reply'; message: JsonRpcReply }
  | { kind: 'none' }
  | { kind: 'pending'; id: string | number; run: () => Promise<ToolResult> };

export interface ProtocolOptions {
  serverName: string;
  serverVersion: string;
  tools: readonly ToolDescriptor[];
  /** Only ever invoked from the `pending` arm — never on the handshake path. */
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

const ok = (id: string | number, result: unknown): Dispatch => ({
  kind: 'reply',
  message: { jsonrpc: '2.0', id, result },
});

const fail = (id: string | number, code: number, message: string): Dispatch => ({
  kind: 'reply',
  message: { jsonrpc: '2.0', id, error: { code, message } },
});

/**
 * Decide what one parsed JSON-RPC message deserves. Never throws, never awaits.
 *
 * @param msg an already-parsed object — framing and JSON parsing belong to
 *   `LineReader`, so this stays testable with plain literals.
 */
export function dispatch(msg: unknown, opts: ProtocolOptions): Dispatch {
  if (!msg || typeof msg !== 'object') return { kind: 'none' };
  const m = msg as Record<string, unknown>;
  const method = typeof m.method === 'string' ? m.method : null;
  // A JSON-RPC id is a string or a number. `null` is explicitly NOT an id, and
  // an absent one means notification — both must go unanswered.
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;

  // A RESPONSE, not a request: it has an id and no method. We are the server
  // and issue no requests, so this can only be a confused peer. Silence is the
  // only correct answer — replying would put a second response on the wire for
  // an id we never asked about.
  if (!method) return { kind: 'none' };

  switch (method) {
    case 'initialize': {
      if (id === null) return { kind: 'none' };
      const params = (m.params ?? {}) as Record<string, unknown>;
      const proposed = params.protocolVersion;
      return ok(id, {
        // ECHO. See the header: correct for the one client we have, and #760
        // recorded that client proposing `2025-11-25`. Guessing a version we
        // had never seen a peer send would be exactly the contract-invention
        // the standing rule forbids.
        protocolVersion: typeof proposed === 'string' && proposed ? proposed : FALLBACK_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: opts.serverName, version: opts.serverVersion },
      });
    }

    // Both spellings: the current CLI sends the namespaced one, and the bare
    // one appears in older transcripts of the protocol. Neither is answered.
    case 'notifications/initialized':
    case 'initialized':
      return { kind: 'none' };

    case 'ping':
      return id === null ? { kind: 'none' } : ok(id, {});

    case 'tools/list':
      // `[...]` so a caller cannot mutate our descriptor array through the
      // reply object on its way to JSON.
      return id === null ? { kind: 'none' } : ok(id, { tools: [...opts.tools] });

    case 'tools/call': {
      if (id === null) return { kind: 'none' };
      const params = (m.params ?? {}) as Record<string, unknown>;
      const name = params.name;
      if (typeof name !== 'string') return fail(id, -32602, 'tools/call requires a string "name"');
      if (!opts.tools.some((t) => t.name === name)) return fail(id, -32602, `unknown tool: ${name}`);
      const rawArgs = params.arguments;
      const args =
        rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      // THE ONLY ARM THAT MAY BLOCK. Everything above answered from a constant.
      return { kind: 'pending', id, run: () => opts.callTool(name, args) };
    }

    default:
      // A notification for an unknown method is still a notification. Refusing
      // it would be the same protocol violation as answering a known one.
      return id === null ? { kind: 'none' } : fail(id, -32601, `method not found: ${method}`);
  }
}

/**
 * Newline-delimited JSON framing, with a bound.
 *
 * Kept apart from `dispatch` because framing bugs and dispatch bugs are
 * different bugs: a chunk boundary landing mid-message is a stream property
 * that has nothing to say about JSON-RPC, and #760's own harness lost a message
 * to a framing assumption before it lost one to anything else.
 */
export class LineReader {
  private buf = '';
  private overflowed = false;

  constructor(private readonly maxBytes: number = MAX_LINE_BYTES) {}

  /**
   * Feed a chunk; get back the complete lines it finished.
   *
   * Once a single line exceeds `maxBytes` this reader is POISONED and returns
   * nothing for ever after. Deliberately not "skip the bad line and resync": we
   * are already past the point where we can tell where a line ends, so resyncing
   * on the next newline would resume mid-message and feed `dispatch` a fragment.
   * `hasOverflowed` lets the caller drop the peer, which is the honest response.
   */
  feed(chunk: string): string[] {
    if (this.overflowed) return [];
    this.buf += chunk;
    const lines: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) lines.push(line);
    }
    if (this.buf.length > this.maxBytes) {
      this.overflowed = true;
      this.buf = '';
      // Lines completed BEFORE the overflow are returned: they were whole and
      // correctly framed, and the caller decides whether to act on them before
      // dropping the peer.
      return lines;
    }
    return lines;
  }

  hasOverflowed(): boolean {
    return this.overflowed;
  }
}

/** Parse a framed line, treating anything unparseable as absent (never throws). */
export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}
