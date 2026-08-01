// The stream-json fake's PROTOCOL, separated from its plumbing (P2-E18-04).
//
// Split out for the same reason `ndjson.ts` is split out of `stream-service.ts`:
// the interesting behaviour should be testable without spawning anything. The
// CI unit job does not run a build, so a test that spawned the compiled CLI
// could only ever skip there — and a test that silently does not run is worse
// than no test (the #107 lesson). Everything meaningful lives here and is
// exercised synchronously; `fake-stream-cli.ts` is the ~30 lines of stdin/stdout
// wiring, proven end-to-end by `npm run check:fake-stream`.
//
// Every message shape is copied from what the REAL CLI emitted during S-10
// (`spike/s10/probe-*.cjs` + the findings note), not invented.

export type OutMessage = Record<string, unknown>;

/** The side effects the protocol needs, injected so tests can observe them. */
export interface FakeStreamHost {
  cwd(): string;
  writeFile(absPath: string, content: string): void;
  stderr(line: string): void;
  exit(code: number): void;
  /** Absolute-path join/resolve, injected so path semantics are testable. */
  resolve(cwd: string, target: string): string;
  /**
   * Append one line to this conversation's JSONL transcript (P2-E18-08b).
   *
   * The REAL CLI writes a transcript in stream mode too — S-10 confirmed it,
   * and that is exactly why the transcript stack survives the migration. The
   * fake did not, so a stream session's Session view read "Looking for this
   * session's transcript…" for ever and the Feed could never be tested against
   * it. A fake that is missing something the real thing does is a fake that
   * hides a bug.
   */
  appendTranscript?(line: Record<string, unknown>): void;
}

export const FAKE_SESSION_ID = '00000000-fake-4000-8000-000000000000';

export class FakeStreamProtocol {
  private readonly pending = new Map<string, { toolName: string; input: Record<string, unknown> }>();
  private requestSeq = 0;

  constructor(
    private readonly host: FakeStreamHost,
    private readonly emit: (m: OutMessage) => void
  ) {}

  /** Feed one decoded inbound message. */
  handle(msg: Record<string, unknown>): void {
    if (msg.type === 'control_response') return this.onControlResponse(msg);
    if (msg.type === 'user') return this.onUser(msg);
    // Anything else is ignored, like the real CLI ignores what it does not know.
  }

  private onUser(msg: Record<string, unknown>): void {
    const text = extractText(msg.message);
    const cwd = this.host.cwd();
    this.transcribe('user', { role: 'user', content: [{ type: 'text', text }] }, cwd);

    // ONCE PER TURN, not once per session. S-11 measured the real CLI doing
    // exactly this (4 turns -> 4 `system:init`). The fake reproduces the
    // SURPRISING behaviour rather than the intuitive one: a fake kinder than
    // the real thing hides the bug it exists to catch — a host that treats
    // `init` as a session event re-initialises every turn, and P2-E18-05/09
    // each pin that with a test they could not otherwise write.
    this.emitInit(cwd);

    if (text.startsWith('!exit ')) {
      this.host.exit(Number(text.slice(6).trim()) || 0);
      return;
    }
    if (text.startsWith('!stderr ')) {
      this.host.stderr(text.slice(8));
      this.emitAssistantText('wrote to stderr');
      this.emitResult();
      return;
    }
    if (text.startsWith('!perm ')) {
      const target = text.slice(6).trim();
      const filePath = this.host.resolve(cwd, target);
      this.askPermission('Write', { file_path: filePath, content: 'echo hi\n' });
      return; // the turn continues when the answer arrives
    }
    this.emitAssistantText(`FAKE-REPLY: ${text}`);
    this.emitResult();
  }

  private onControlResponse(msg: Record<string, unknown>): void {
    const r = msg.response as Record<string, unknown> | undefined;
    const id = String(r?.request_id ?? '');
    const req = this.pending.get(id);
    if (!req) return; // an answer to something we never asked: ignore, do not crash
    this.pending.delete(id);

    const inner = (r?.response ?? {}) as Record<string, unknown>;
    const filePath = String(req.input.file_path ?? '');
    if (inner.behavior === 'allow') {
      try {
        // Actually perform it, so a test can assert the FILE rather than our
        // narration — the same thing S-10 probe B checked.
        this.host.writeFile(filePath, String(req.input.content ?? ''));
        this.emitAssistantText(`wrote ${filePath}`);
      } catch (e) {
        this.emitAssistantText(`failed to write ${filePath}: ${String(e)}`);
      }
    } else {
      this.emitAssistantText(`denied write to ${filePath}`);
    }
    this.emitResult();
  }

  private askPermission(toolName: string, input: Record<string, unknown>): void {
    const request_id = `fake-req-${++this.requestSeq}`;
    this.pending.set(request_id, { toolName, input });
    // Shape copied verbatim from S-10 probe B's captured control_request,
    // including `decision_reason_type: 'safetyCheck'` and the suggestion —
    // those are exactly what P2-E18-07 has to render.
    this.emit({
      type: 'control_request',
      request_id,
      request: {
        subtype: 'can_use_tool',
        tool_name: toolName,
        display_name: toolName,
        input,
        description: String(input.file_path ?? ''),
        decision_reason: `Claude requested permissions to edit ${String(input.file_path ?? '')}, which is a sensitive file.`,
        decision_reason_type: 'safetyCheck',
        permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
        classifier_approvable: true,
        tool_use_id: `toolu_fake_${this.requestSeq}`,
      },
    });
  }

  private emitInit(cwd: string): void {
    this.emit({
      type: 'system',
      subtype: 'init',
      cwd,
      session_id: FAKE_SESSION_ID,
      tools: ['Read', 'Write', 'Edit', 'Bash'],
      mcp_servers: [],
      model: 'claude-fake-1',
      permissionMode: 'default',
      slash_commands: ['clear', 'compact', 'cost', 'fake-only'],
      apiKeySource: 'none',
      claude_code_version: '0.0.0-fake',
      output_style: 'default',
      agents: [],
      skills: [],
      plugins: [],
      uuid: FAKE_SESSION_ID,
    });
  }

  /** Mirror a turn into the JSONL transcript, the way the real CLI does. */
  private transcribe(type: 'user' | 'assistant', message: unknown, cwd?: string): void {
    this.host.appendTranscript?.({
      type,
      sessionId: FAKE_SESSION_ID,
      cwd: cwd ?? this.host.cwd(),
      timestamp: new Date().toISOString(),
      isSidechain: false,
      isMeta: false,
      message,
    });
  }

  private emitAssistantText(text: string): void {
    // deltas first, then the assembled message — the order S-10 observed
    // (stream_event xN -> assistant -> result)
    for (const piece of text.match(/[\s\S]{1,8}/g) ?? []) {
      this.emit({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } },
        session_id: FAKE_SESSION_ID,
        parent_tool_use_id: null,
      });
    }
    const message = { role: 'assistant', content: [{ type: 'text', text }] };
    this.emit({
      type: 'assistant',
      message,
      session_id: FAKE_SESSION_ID,
      parent_tool_use_id: null,
    });
    this.transcribe('assistant', message);
  }

  private emitResult(isError = false): void {
    this.emit({
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      is_error: isError,
      session_id: FAKE_SESSION_ID,
      usage: { input_tokens: 2, output_tokens: 6, cache_read_input_tokens: 0 },
    });
  }
}

/**
 * Pull the prompt text out of the SDK's user envelope.
 *
 * The shape S-10 wrote to the real CLI:
 * `{ type:'user', message:{ role:'user', content:[{type:'text',text}] } }`.
 * A bare string content is accepted too — the Anthropic message format permits
 * it and a hand-written test message is likely to use it.
 */
export function extractText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: string; text: string } => (c as { type?: string })?.type === 'text')
    .map((c) => c.text)
    .join('');
}
