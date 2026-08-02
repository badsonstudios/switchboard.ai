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
    if (msg.type === 'control_request') return this.onControlRequest(msg);
    if (msg.type === 'control_response') return this.onControlResponse(msg);
    if (msg.type === 'user') return this.onUser(msg);
    // Anything else is ignored, like the real CLI ignores what it does not know.
  }

  private onUser(msg: Record<string, unknown>): void {
    const text = extractText(msg.message);
    const cwd = this.host.cwd();
    const message = { role: 'user', content: [{ type: 'text', text }] };
    this.transcribe('user', message, cwd);

    // ONCE PER TURN, not once per session. S-11 measured the real CLI doing
    // exactly this (4 turns -> 4 `system:init`). The fake reproduces the
    // SURPRISING behaviour rather than the intuitive one: a fake kinder than
    // the real thing hides the bug it exists to catch — a host that treats
    // `init` as a session event re-initialises every turn, and P2-E18-05/09
    // each pin that with a test they could not otherwise write.
    this.emitInit(cwd);

    // `--replay-user-messages`: the CLI echoes our own turn back, so a send is
    // ACKNOWLEDGED rather than assumed (the flag P2-E18-06 added to the
    // recipe). The fake did not, and once the Feed reads the stream instead of
    // the transcript (P2-E18-10) that omission means a stream session shows no
    // user prompt at all — a fake missing something the real thing does is a
    // fake that hides a bug.
    this.emit({ type: 'user', message, session_id: FAKE_SESSION_ID, parent_tool_use_id: null });

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
    // Start a turn and never finish it. The only way to hold a session in
    // `working` deliberately — which is the one state the stop button renders
    // in, and therefore the only way to test it (#154). `!perm` cannot serve:
    // it moves the session to `needs-permission`.
    if (text === '!hang') {
      this.emitAssistantText('working on it');
      return; // no result: the turn stays open until something interrupts it
    }

    // Tokens and NOTHING ELSE (P2-E18-10): deltas, then silence. No `assistant`
    // message, no `result`, and — the point — no transcript line either.
    //
    // It is the only way to prove token-by-token rendering from the outside.
    // Every other turn ends with an assembled `assistant` message that the
    // transcript also records, so text on screen proves nothing about WHICH
    // source put it there or WHEN. Here the text can only have come from
    // partial deltas, and it must be visible while the turn is still running.
    if (text === '!partial') {
      this.emit({
        type: 'stream_event',
        event: { type: 'message_start', message: { role: 'assistant', content: [] } },
        session_id: FAKE_SESSION_ID,
        parent_tool_use_id: null,
      });
      this.emit({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        session_id: FAKE_SESSION_ID,
        parent_tool_use_id: null,
      });
      for (const piece of ['HALF-', 'WRITTEN-', 'SENTENCE']) {
        this.emit({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
          session_id: FAKE_SESSION_ID,
          parent_tool_use_id: null,
        });
      }
      return;
    }

    // The CLI's command set changing mid-session — a plugin installed, a
    // command file added. Object-shaped, unlike `init`'s bare names: the shape
    // is read out of the shipped extension bundle, which stores `e.commands`
    // and renders `.name` / `.description` off each entry.
    if (text === '!commands') {
      this.emit({
        type: 'system',
        subtype: 'commands_changed',
        commands: [
          { name: 'clear', description: 'Clear conversation history' },
          { name: 'just-installed', description: 'Arrived mid-session' },
        ],
      });
      this.emitAssistantText('commands changed');
      this.emitResult();
      return;
    }

    // A LOCAL slash command (#156, `spike/findings/s-11-local-slash-commands.md`).
    //
    // The two transports genuinely disagree about this turn, and the fake
    // reproduces the disagreement rather than the tidy version of it:
    //
    //   on the stream   — an ordinary `assistant` message carrying the output
    //   in the JSONL    — `system`/`subtype:"local_command"`, output wrapped in
    //                     <local-command-stdout>, AND NO `assistant` ENTRY
    //
    // That gap is the whole of the bug: `/usage` rendered nothing in the Session
    // view because the transcript-driven Feed had no assistant line to find. A
    // fake that transcribed an assistant entry here would make the fix look
    // like it worked without proving anything.
    if (text.startsWith('/')) {
      const out = `LOCAL-OUTPUT for ${text}`;
      this.emitAssistantText(out, false);
      this.host.appendTranscript?.({
        type: 'system',
        subtype: 'local_command',
        level: 'info',
        isMeta: false,
        isSidechain: false,
        sessionId: FAKE_SESSION_ID,
        cwd,
        timestamp: new Date().toISOString(),
        content: `<local-command-stdout>${out}</local-command-stdout>`,
      });
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

  /**
   * A control request FROM the host (#154). Only `interrupt` today.
   *
   * The fake models an interrupt as "the turn ends now": it answers the request
   * and closes the turn with an error result, so a test can tell an interrupted
   * turn from a completed one. What the REAL CLI does is still unmeasured
   * (E18-12) — this is a plausible shape, not a measured one, and the fake
   * cannot make it true.
   */
  private onControlRequest(msg: Record<string, unknown>): void {
    const req = msg.request as { subtype?: unknown } | undefined;
    if (req?.subtype !== 'interrupt') return;
    this.emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: String(msg.request_id ?? ''),
        response: { still_queued: [] },
      },
    });
    // any permission we were waiting on is moot once the turn is abandoned
    this.pending.clear();
    this.emitAssistantText('INTERRUPTED');
    this.emitResult(true);
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

  /**
   * @param transcribe false for a LOCAL slash command, which writes no
   *   `assistant` entry to the JSONL at all — see the `/` branch in `onUser`.
   */
  private emitAssistantText(text: string, transcribe = true): void {
    // deltas first, then the assembled message — the order S-10 observed
    // (stream_event xN -> assistant -> result).
    //
    // The full envelope, not just the delta: `index` is how a host matches a
    // delta to the content block it belongs to, and how the `assistant` message
    // that follows supersedes the block the deltas built instead of appending a
    // second copy of the reply (P2-E18-10). A fake that omitted the index would
    // make an index-blind consumer look correct.
    this.emit({
      type: 'stream_event',
      event: { type: 'message_start', message: { role: 'assistant', content: [] } },
      session_id: FAKE_SESSION_ID,
      parent_tool_use_id: null,
    });
    this.emit({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      session_id: FAKE_SESSION_ID,
      parent_tool_use_id: null,
    });
    for (const piece of text.match(/[\s\S]{1,8}/g) ?? []) {
      this.emit({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
        session_id: FAKE_SESSION_ID,
        parent_tool_use_id: null,
      });
    }
    this.emit({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
      session_id: FAKE_SESSION_ID,
      parent_tool_use_id: null,
    });
    const message = { role: 'assistant', content: [{ type: 'text', text }] };
    this.emit({
      type: 'assistant',
      message,
      session_id: FAKE_SESSION_ID,
      parent_tool_use_id: null,
    });
    if (transcribe) this.transcribe('assistant', message);
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
