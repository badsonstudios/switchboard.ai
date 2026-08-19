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

import { ASK_USER_QUESTION_TOOL } from '../../shared/ask-user-question';
import { FAKE_SESSION_ID } from './fake-stream-ids';

export type OutMessage = Record<string, unknown>;

/**
 * The two questions `!ask` raises, copied from a REAL capture (#563) —
 * `spike/findings/artifacts/s11/ask-user-question-answer.json`.
 *
 * One of each arity on purpose. A fake that only ever produced `multiSelect:
 * false` would leave the panel's checkbox half — and the comma-joined answer
 * string that only multi-select can produce — with no end-to-end proof at all.
 */
export const FAKE_QUESTION_ONE = {
  question: 'Which colour do you prefer?',
  header: 'Colour',
  options: [
    { label: 'Red', description: 'Prefer red' },
    { label: 'Green', description: 'Prefer green' },
    { label: 'Blue', description: 'Prefer blue' },
  ],
  multiSelect: false,
};

export const FAKE_QUESTION_MANY = {
  question: 'Which of these languages do you use?',
  header: 'Languages',
  options: [
    { label: 'TypeScript', description: 'You use TypeScript' },
    { label: 'Rust', description: 'You use Rust' },
    { label: 'Go', description: 'You use Go' },
    { label: 'Python', description: 'You use Python' },
  ],
  multiSelect: true,
};

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
  /**
   * Fire one hook event, the way the real CLI does (#313).
   *
   * Hooks are INDEPENDENT OF THE TRANSPORT: a session started in stream mode is
   * still spawned with our `--settings` file, so the real CLI can POST a
   * `Notification` at the hook listener while its permissions ride
   * `can_use_tool`. This fake could not, which is precisely why #261 part B had
   * to be settled by reading code — the one behaviour at issue was the one the
   * fake had no way to produce, and part A's e2e had to POST the hook by hand
   * from the test process instead of from the session.
   *
   * Optional, like `appendTranscript`: a host that cannot reach the listener
   * (every unit test) simply records the call.
   */
  fireHook?(payload: Record<string, unknown>): void;
}

export class FakeStreamProtocol {
  private readonly pending = new Map<
    string,
    { toolName: string; input: Record<string, unknown>; hang?: boolean }
  >();
  private requestSeq = 0;

  constructor(
    private readonly host: FakeStreamHost,
    private readonly emit: (m: OutMessage) => void,
    /**
     * `--resume <id>` support (#404). The real adapter passes the flag and the
     * real CLI silently continues that conversation; nothing on the wire says
     * "resumed". The fake makes it OBSERVABLE instead — the first reply leads
     * with a `RESUMED-FROM:<id>` line — because "the relaunch actually passed
     * --resume" is exactly the claim the #404 e2e has to read off the screen,
     * and a fake that swallowed the flag would let the resume path rot the way
     * the ignored transport did in #153.
     */
    private readonly opts: { resumedFrom?: string; sessionId?: string } = {}
  ) {
    this.sessionId = opts.sessionId ?? opts.resumedFrom ?? FAKE_SESSION_ID;
  }

  /**
   * THIS session's conversation id — one per instance, not one per world (#603).
   *
   * It was a module constant, which meant every fake Direct card in an e2e run
   * announced the same `session_id` and wrote the same `<id>.jsonl`. Nothing in
   * the fake cared; everything in the MAIN process that keys on the native id
   * did — the #484 repair sweep, #539's duplicate untangle, adoption — because
   * to all of them the run's cards were one conversation. `fake-stream-cli.ts`
   * hands each spawn its own (`claimFakeSessionId`); the default keeps the id
   * every unit test and single-card spec already names.
   *
   * A RESUMED session keeps the id it was resumed with, and that rule lives
   * here rather than in the plumbing because the alternative is an instance
   * that can be constructed into a state the real CLI cannot reach: announcing
   * `RESUMED-FROM:<id>` while stamping a different id on init, on every message
   * and on the transcript. The flag names a conversation that already exists on
   * disk; the next turn belongs in that file.
   */
  private readonly sessionId: string;

  /** the resume marker goes out once, on the first turn, not per turn */
  private resumeNoted = false;

  /** how many API messages this session has produced — see `newMessageId` */
  private messages = 0;

  /**
   * A fresh `message.id`, shared by every content block of ONE API message.
   *
   * The real API puts an id on every `assistant` message, and the CLI passes
   * that message through to both places we read it: the JSONL line and the
   * stream (the VS Code extension's own transcript→stream converter copies
   * `message` verbatim). Session find joins the file to the view on exactly
   * that field for prose blocks (`blocks.ts` → `srcId`, #458), so a fake that
   * omitted it left half that join with no end-to-end proof — the same
   * "a fake missing something the real thing does is a fake that hides a bug"
   * this file already argues for tool_use ids.
   *
   * ONE ID PER MESSAGE, not per block, because that is the shape: a message
   * that produces several content blocks is written as several lines and
   * streamed as several `assistant` messages, all carrying the one id.
   */
  private newMessageId(): string {
    this.messages += 1;
    return `msg_fake_${this.messages}`;
  }

  /** Feed one decoded inbound message. */
  handle(msg: Record<string, unknown>): void {
    if (msg.type === 'control_request') return this.onControlRequest(msg);
    if (msg.type === 'control_response') return this.onControlResponse(msg);
    if (msg.type === 'user') return this.onUser(msg);
    // Anything else is ignored, like the real CLI ignores what it does not know.
  }

  private onUser(msg: Record<string, unknown>): void {
    const text = extractText(msg.message);
    const images = extractImages(msg.message);
    const documents = extractDocuments(msg.message);
    const cwd = this.host.cwd();
    // The attachments go back out on the echo exactly as they came in
    // (P2-E10-09/10). A fake that quietly dropped them would be a fake that
    // cannot tell a working attachment path from a broken one — which is the
    // whole reason the echo exists at all (see `--replay-user-messages` below).
    const message = {
      role: 'user',
      content: [
        ...images.map((i) => ({
          type: 'image',
          source: { type: 'base64', media_type: i.mediaType, data: i.data },
        })),
        ...documents.map((d) => ({
          type: 'document',
          source:
            d.kind === 'text'
              ? { type: 'text', media_type: 'text/plain', data: d.data }
              : { type: 'base64', media_type: 'application/pdf', data: d.data },
          title: d.title,
        })),
        // omitted for an attachment-only turn, because `userMessage` omits it
        // too — a fake that always appends one is not echoing what arrived
        ...(text ? [{ type: 'text', text }] : []),
      ],
    };
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
    this.emit({ type: 'user', message, session_id: this.sessionId, parent_tool_use_id: null });

    // WHAT THE MODEL SAW (P2-E10-09). The real CLI answers an image by talking
    // about it, which is not a thing a fake can do — so it answers by SAYING
    // what arrived, in a line an e2e can assert on. Without this, every test of
    // the image path could only prove that the composer cleared itself, which
    // is exactly the "it looked like it worked" failure #154 was.
    //
    // Only when there ARE images, so a text-only turn is byte-for-byte what it
    // has always been.
    if (images.length > 0) {
      this.emitAssistantText(
        `IMAGE-SEEN:${images.map((i) => `${i.mediaType}:${i.data.length}`).join(',')}`
      );
    }

    // The same trick for documents (P2-E10-10), and the CONTENTS are echoed for
    // a text one rather than just its length: the failure this has to be able
    // to catch is a text file arriving base64'd, which has a perfectly
    // plausible length and completely wrong bytes.
    if (documents.length > 0) {
      this.emitAssistantText(
        `DOC-SEEN:${documents
          // the first line only for text: echoing a 5 MB attachment whole
          // would put a 5 MB assistant turn in the feed, and the first line is
          // what distinguishes real contents from base64 anyway
          .map((d) => `${d.kind}:${d.title}:${d.kind === 'text' ? d.data.split('\n')[0] : d.data.length}`)
          .join('|')}`
      );
    }

    // the #404 marker — see the constructor docblock
    if (this.opts.resumedFrom && !this.resumeNoted) {
      this.resumeNoted = true;
      this.emitAssistantText(`RESUMED-FROM:${this.opts.resumedFrom}`);
    }

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

    // Fire a hook `Notification`, the way the real CLI does mid-turn (#313).
    //
    // `!notify <notification_type> <message…>`. THE POINT is that this arrives
    // on the hook channel and not on the stream: a Direct session is spawned
    // with our `--settings` file exactly like a Terminal one, so the CLI has
    // both channels open, and the whole of #313 is what should happen when the
    // debounced nudge on one of them contradicts the exact signal on the other.
    // Without this the fake had no hook path at all, which is why #261 part B
    // could only be settled by reading code and why its e2e had to POST the
    // hook from the test process instead of from the session.
    //
    // NOTHING ELSE IS EMITTED, and the turn is deliberately left open in the
    // shape of `!hang`: whatever the notification did to the status has to be
    // observable, and an `assistant` message straight after would walk the card
    // back to `working` and hide it. `fireHook` is synchronous for the same
    // reason — a test that saw the next stream message could otherwise still be
    // racing the POST.
    if (text.startsWith('!notify ')) {
      const rest = text.slice(8).trim();
      const sp = rest.indexOf(' ');
      const [type, message] = sp < 0 ? [rest, ''] : [rest.slice(0, sp), rest.slice(sp + 1)];
      this.host.fireHook?.({
        hook_event_name: 'Notification',
        session_id: this.sessionId,
        cwd,
        notification_type: type,
        message,
      });
      return;
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
        session_id: this.sessionId,
        parent_tool_use_id: null,
      });
      this.emit({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        session_id: this.sessionId,
        parent_tool_use_id: null,
      });
      for (const piece of ['HALF-', 'WRITTEN-', 'SENTENCE']) {
        this.emit({
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
          session_id: this.sessionId,
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
    //
    // NO STREAM EVENTS AT ALL, and that is measured too, not a shortcut. The
    // real CLI answers a local command with a bare `system:init -> assistant ->
    // result` — no `message_start`, no deltas — for `/usage`, `/cost`,
    // `/context`, `/model` and `/agents` alike (probe run 2026-08-02, every one
    // of them returning renderable text). It is the one turn shape where the
    // assembler has nothing streamed to reconcile against.
    if (text.startsWith('/')) {
      const out = `LOCAL-OUTPUT for ${text}`;
      this.emit({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: out }] },
        session_id: this.sessionId,
        parent_tool_use_id: null,
      });
      this.host.appendTranscript?.({
        type: 'system',
        subtype: 'local_command',
        level: 'info',
        isMeta: false,
        isSidechain: false,
        sessionId: this.sessionId,
        cwd,
        timestamp: new Date().toISOString(),
        content: `<local-command-stdout>${out}</local-command-stdout>`,
      });
      this.emitResult();
      return;
    }

    // Ask, then DO the tool and say nothing — the state a real gated call spends
    // most of its life in (#310).
    //
    // `!perm` answers and replies in the same tick, which makes the fake kinder
    // than the real thing in the one dimension #310 is about: a real tool takes
    // SECONDS to run, and for all of them the CLI is silent. That silence is the
    // bug's whole habitat — `needs-permission` used to be left standing until
    // the next `assistant` message, so a fake that speaks instantly hides it
    // (the same "a fake missing something the real thing does" argument the
    // transcript and `--replay-user-messages` notes make above).
    //
    // Deliberately never finishes the turn, in the shape of `!hang`: the point
    // is the window between the answer and the CLI speaking again, so ending it
    // at all would just reintroduce a race about how long the window is.
    if (text.startsWith('!permhang ')) {
      const filePath = this.host.resolve(cwd, text.slice(10).trim());
      this.askPermission('Write', { file_path: filePath, content: 'echo hi\n' }, true);
      return;
    }

    // ONE REQUEST PER TARGET, all of them raised before any answer can arrive
    // (P2-E18-14). A single target is the original behaviour, unchanged.
    //
    // Two at once is the only way to reach the card's QUEUE from the outside on
    // this transport. The protocol has always supported concurrent requests —
    // `onControlResponse` routes by id — but the only route in was two prompts,
    // and the second cannot be typed while the composer's session sits in
    // `needs-permission` with the first one's bar over it. So the fake raises
    // both from one turn, exactly as a real assistant message carrying two
    // gated `tool_use` blocks would.
    //
    // Targets are split on WHITESPACE, so a path containing a space becomes two
    // requests rather than one. Nothing asks for one — every call site is a
    // short relative name or an absolute test path — and a fake is not the
    // place to grow a quoting grammar.
    if (text.startsWith('!perm ')) {
      for (const target of text.slice(6).trim().split(/\s+/)) {
        if (!target) continue;
        const filePath = this.host.resolve(cwd, target);
        this.askPermission('Write', { file_path: filePath, content: 'echo hi\n' });
      }
      return; // the turn continues when the answers arrive
    }

    // The CLI's own CHOOSER (#563) — an `AskUserQuestion` request, in the shape
    // the real CLI sends it.
    //
    // The payload is copied from a REAL capture
    // (`spike/findings/artifacts/s11/ask-user-question-answer.json`), two
    // questions in one call: one pick-one and one multi-select, because a fake
    // that only ever produced one arity would let the panel's radio/checkbox
    // split rot untested. `!ask1` raises the pick-one alone, for the tests that
    // want the simplest possible submit.
    //
    // What comes BACK is the point of the verb. The answer arrives as
    // `updatedInput.answers`, so the fake echoes that map into its reply — that
    // is how an e2e asserts what actually reached "the CLI" rather than what
    // the panel believes it sent, which is the one claim a renderer test cannot
    // make about itself.
    if (text === '!ask' || text === '!ask1') {
      this.askPermission(ASK_USER_QUESTION_TOOL, {
        questions:
          text === '!ask1'
            ? [FAKE_QUESTION_ONE]
            : [FAKE_QUESTION_ONE, FAKE_QUESTION_MANY],
      });
      return; // the turn continues when the answer arrives
    }

    // A turn made of TOOL CALLS (P2-E18-14).
    //
    // Every rich Feed block — the Bash box with its IN/OUT sections, the Edit
    // diff panes, a plain tool row, the TodoWrite checklist — existed only on
    // the transcript path at e2e level, because nothing on this transport ever
    // emitted a `tool_use`. `!perm` raises a control_request, which is a
    // question, not a rendered block. So the whole of `blocks.ts`' rich half
    // was reachable from a JSONL file and from no stream anywhere.
    if (text === '!tools') {
      this.emitToolTurn();
      return;
    }

    // N assistant MESSAGES in one turn (P2-E18-14) — enough conversation to
    // SCROLL. The tail-pin, the reading-position restore and the keyboard walk
    // all need a feed taller than the pane, and a fake that answers in one
    // paragraph can never produce one.
    //
    // Messages, not content blocks: each one is a full
    // `message_start`…`message_stop`, which is a longer conversation rather
    // than one enormous reply. That is a fixture's convenience and not a
    // measured shape — nothing here is asserting anything about turn framing,
    // only about a feed with more in it than fits.
    if (text.startsWith('!bulk ')) {
      const [rawCount, ...rest] = text.slice(6).trim().split(/\s+/);
      // Bounded: this is a test fixture, and an unbounded count is a way to
      // hang the harness by typo rather than a feature.
      const count = Math.min(Math.max(Math.trunc(Number(rawCount)) || 0, 0), 200);
      const prefix = rest.join(' ') || 'BULK_BLOCK_';
      // No thinking block: this verb is about VOLUME, and 200 signature deltas
      // buy nothing the plain-turn tests do not already pin.
      for (let i = 1; i <= count; i++) this.emitAssistantText(`${prefix}${i}`, true, false);
      this.emitResult();
      return;
    }
    this.emitAssistantText(`FAKE-REPLY: ${text}`);
    this.emitResult();
  }

  /**
   * A turn whose content is TOOL CALLS, in the shape the real CLI emits them.
   *
   * The same two measured rules `emitAssistantText`'s docblock records, because
   * they are properties of the CLI and not of text: ONE `assistant` message per
   * content block, each carrying a single-element `content` array (so every one
   * of them reports content index 0 while the stream events that built it were
   * addressed 0, 1, 2…), and each arriving MID-STREAM, before its own
   * `content_block_stop`.
   *
   * The tool INPUT is streamed as `input_json_delta` — fragments of half-written
   * JSON — and never as anything renderable. That is deliberate and it is what
   * `StreamFeed` is built against: the row opens on `content_block_start`, which
   * carries the tool's NAME whole, and stays a shell until the message fills in
   * its input. A fake that streamed the input as text would let a host render
   * half a path and call it a tool row.
   *
   * The turn ends with a `user` message carrying a `tool_result`, which is how
   * the Bash box's OUT section gets anything to show.
   *
   * ONE THING HERE IS SYNTHETIC, and is called out rather than left to look
   * measured: the PROSE COMES AFTER the tool calls. A real turn that reaches for
   * tools normally ends at them. It is arranged this way so that block ORDER is
   * observable from the outside — a builder that ignored `content_block_start`
   * and took its ordering from the `assistant` messages alone would render these
   * identically if the prose came first, so a prose-first turn could not tell
   * the two apart. Everything else about the shape is the measured one.
   */
  private emitToolTurn(): void {
    /** the one call whose result comes back — the Bash box's OUT section */
    const bashId = 'toolu_fake_bash';
    // EVERY call carries an `id`, including the three whose results never come
    // back. The real API never emits a `tool_use` without one, and a fake that
    // omitted them could not stitch a result onto more than one block even if a
    // test wanted it to — `blocks.ts` keys `toolUseId` off exactly this field.
    // A fake missing something the real thing does is a fake that hides a bug.
    const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [
      {
        id: bashId,
        name: 'Bash',
        // two lines on purpose: a COLLAPSED section still shows its first line,
        // so only a second one can tell open from shut (feed.spec.ts's lesson)
        input: { command: 'echo STREAM_CMD\nSTREAM_CMD_LINE2', description: 'Stream check' },
      },
      {
        id: 'toolu_fake_edit',
        name: 'Edit',
        input: { file_path: 'C:/tmp/stream.ts', old_string: 'STREAM_OLD', new_string: 'STREAM_NEW' },
      },
      { id: 'toolu_fake_read', name: 'Read', input: { file_path: 'C:/tmp/stream.md' } },
      {
        id: 'toolu_fake_todo',
        name: 'TodoWrite',
        input: { todos: [{ content: 'first stream step', status: 'completed' }] },
      },
    ];

    // ONE api message for the whole turn — its tool calls AND the prose below
    // share this id, which is what a message split across several lines looks
    // like (see `newMessageId`).
    const id = this.newMessageId();
    this.ev({ type: 'message_start', message: { role: 'assistant', id, content: [] } });
    let index = 0;
    for (const call of calls) {
      // the NAME arrives whole; the input does not
      this.ev({
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
      });
      // a real prefix of this call's real input, so the fragment is one a host
      // could in principle accumulate — not a constant that parses to nothing
      this.ev({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input).slice(0, 8) },
      });
      const content = [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }];
      const message = { role: 'assistant', id, content };
      this.emit({ type: 'assistant', message, session_id: this.sessionId, parent_tool_use_id: null });
      this.transcribe('assistant', message);
      this.ev({ type: 'content_block_stop', index });
      index += 1;
    }

    // prose LAST, so "the tools rendered above the answer" is a claim the test
    // can make rather than an accident of the fake sending text first
    const prose = 'STREAM_PROSE answer';
    this.ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const piece of prose.match(/[\s\S]{1,8}/g) ?? []) {
      this.ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    }
    const proseMessage = { role: 'assistant', id, content: [{ type: 'text', text: prose }] };
    this.emit({ type: 'assistant', message: proseMessage, session_id: this.sessionId, parent_tool_use_id: null });
    this.transcribe('assistant', proseMessage);
    this.ev({ type: 'content_block_stop', index });
    this.ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    this.ev({ type: 'message_stop' });

    // the tool's OUTPUT, replayed as the CLI replays it
    const resultMessage = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: bashId,
          content: 'STREAM_OUTPUT\nSTREAM_OUT_LINE2',
        },
      ],
    };
    this.emit({ type: 'user', message: resultMessage, session_id: this.sessionId, parent_tool_use_id: null });
    this.transcribe('user', resultMessage);
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
    // A QUESTION reports what it was ANSWERED, not what it wrote (#563). The
    // real CLI's tool_result does the same thing in prose ("Your questions have
    // been answered: …"), and the wording of the three cases below tracks the
    // three the probe measured: answered, answered with nothing, refused.
    if (req.toolName === ASK_USER_QUESTION_TOOL) {
      if (inner.behavior !== 'allow') {
        this.emitAssistantText('QUESTION DENIED');
        this.emitResult();
        return;
      }
      const updated = (inner.updatedInput ?? {}) as Record<string, unknown>;
      const answers = (updated.answers ?? {}) as Record<string, unknown>;
      const pairs = Object.entries(answers).map(([q, a]) => `${q}=${String(a)}`);
      this.emitAssistantText(pairs.length ? `ANSWERS: ${pairs.join(' | ')}` : 'ANSWERS: none');
      this.emitResult();
      return;
    }

    const filePath = String(req.input.file_path ?? '');
    let said = '';
    if (inner.behavior === 'allow') {
      try {
        // Actually perform it, so a test can assert the FILE rather than our
        // narration — the same thing S-10 probe B checked.
        this.host.writeFile(filePath, String(req.input.content ?? ''));
        said = `wrote ${filePath}`;
      } catch (e) {
        said = `failed to write ${filePath}: ${String(e)}`;
      }
    } else {
      said = `denied write to ${filePath}`;
    }
    // A `!permhang` request stops here, whatever happened: the tool has run and
    // the CLI has gone quiet, which is the state a host must survive without
    // claiming a question is still outstanding (#310). The file is the
    // observable; the silence is the test. The guard sits OUTSIDE the branches
    // so a failed write cannot break the silence it was asked for.
    if (req.hang) return;
    this.emitAssistantText(said);
    this.emitResult();
  }

  private askPermission(toolName: string, input: Record<string, unknown>, hang = false): void {
    const request_id = `fake-req-${++this.requestSeq}`;
    this.pending.set(request_id, { toolName, input, hang });
    // A QUESTION carries none of the permission furniture (#563), and the real
    // capture is why: the CLI's `AskUserQuestion` request has no
    // `decision_reason`, no `decision_reason_type` and no
    // `permission_suggestions` — there is nothing to justify and nothing to
    // suggest, because it is not asking for permission. A fake that attached
    // "which is a sensitive file" to a question would have the panel rendering
    // a safety warning nobody sent.
    const question = toolName === ASK_USER_QUESTION_TOOL;
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
        ...(question
          ? {}
          : {
              description: String(input.file_path ?? ''),
              decision_reason: `Claude requested permissions to edit ${String(input.file_path ?? '')}, which is a sensitive file.`,
              decision_reason_type: 'safetyCheck',
              permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
              classifier_approvable: true,
            }),
        tool_use_id: `toolu_fake_${this.requestSeq}`,
      },
    });
  }

  private emitInit(cwd: string): void {
    this.emit({
      type: 'system',
      subtype: 'init',
      cwd,
      session_id: this.sessionId,
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
      uuid: this.sessionId,
    });
  }

  /** Mirror a turn into the JSONL transcript, the way the real CLI does. */
  private transcribe(type: 'user' | 'assistant', message: unknown, cwd?: string): void {
    this.host.appendTranscript?.({
      type,
      sessionId: this.sessionId,
      cwd: cwd ?? this.host.cwd(),
      timestamp: new Date().toISOString(),
      isSidechain: false,
      isMeta: false,
      message,
    });
  }

  private ev(event: Record<string, unknown>): void {
    this.emit({
      type: 'stream_event',
      event,
      session_id: this.sessionId,
      parent_tool_use_id: null,
    });
  }

  /**
   * A turn's assistant output, in the shape the REAL CLI emits it.
   *
   * MEASURED 2026-08-02 against the PATH CLI with our exact argument list
   * (`spike/s11/probe-140-slash-flags.cjs`, three turns, identical every time):
   *
   *   message_start
   *   content_block_start(0, thinking) -> delta.. -> ASSISTANT -> content_block_stop(0)
   *   content_block_start(1, text)     -> delta.. -> ASSISTANT -> content_block_stop(1)
   *   message_delta -> message_stop -> result
   *
   * Two things here are NOT what this fake used to do, and both were hiding a
   * bug of exactly the kind this project keeps finding (#153/#154/#139):
   *
   *  1. **One `assistant` message PER CONTENT BLOCK**, not one per turn — and
   *     each carries a single-element `content` array, so every one of them
   *     reports content index 0 while the deltas that built it were addressed
   *     0, 1, 2… A host that matches purely on index lines up the first block
   *     and appends a duplicate of every block after it.
   *  2. **The message arrives MID-STREAM**, before its own `content_block_stop`
   *     — not after `message_stop`, which is where the tidy version puts it.
   *
   * A thinking block is emitted first whenever `thinking` is set, because the
   * real CLI does and because a single-block turn cannot exercise (1) at all.
   * Its text is empty, as the real one's was — the CLI streams a signature, not
   * prose.
   *
   * @param transcribe false for a LOCAL slash command, which writes no
   *   `assistant` entry to the JSONL at all — see the `/` branch in `onUser`.
   */
  private emitAssistantText(text: string, transcribe = true, thinking = true): void {
    const id = this.newMessageId();
    this.ev({ type: 'message_start', message: { role: 'assistant', id, content: [] } });
    let index = 0;
    if (thinking) {
      this.ev({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
      this.ev({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: 'FAKE-SIGNATURE' },
      });
      // the per-block assistant message, mid-stream — same message, same id
      this.emit({
        type: 'assistant',
        message: {
          role: 'assistant',
          id,
          content: [{ type: 'thinking', thinking: '', signature: 'FAKE-SIGNATURE' }],
        },
        session_id: this.sessionId,
        parent_tool_use_id: null,
      });
      this.ev({ type: 'content_block_stop', index });
      index += 1;
    }
    this.ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const piece of text.match(/[\s\S]{1,8}/g) ?? []) {
      this.ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    }
    const message = { role: 'assistant', id, content: [{ type: 'text', text }] };
    this.emit({
      type: 'assistant',
      message,
      session_id: this.sessionId,
      parent_tool_use_id: null,
    });
    this.ev({ type: 'content_block_stop', index });
    this.ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    this.ev({ type: 'message_stop' });
    if (transcribe) this.transcribe('assistant', message);
  }

  private emitResult(isError = false): void {
    this.emit({
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      is_error: isError,
      session_id: this.sessionId,
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
/**
 * Pull the image blocks out of the SDK's user envelope (P2-E10-09).
 *
 * The shape the VS Code extension writes and `shared/stream-protocol.ts`
 * reproduces: `{type:"image",source:{type:"base64",media_type,data}}`. Anything
 * that is not exactly that is ignored rather than guessed at — the fake's job
 * is to be a strict reader of the contract, so a block we got wrong shows up as
 * an image that vanished rather than as one the fake was kind enough to accept.
 */
export function extractImages(message: unknown): Array<{ mediaType: string; data: string }> {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ mediaType: string; data: string }> = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type !== 'image') continue;
    const source = block.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
    if (source?.type !== 'base64') continue;
    if (typeof source.media_type !== 'string' || typeof source.data !== 'string') continue;
    out.push({ mediaType: source.media_type, data: source.data });
  }
  return out;
}

/** A document block the fake read off the wire (P2-E10-10). */
export interface FakeDocument {
  /** which arm of the reference's switch produced it */
  kind: 'text' | 'pdf';
  title: string;
  /** the contents for a text document, the base64 for a PDF */
  data: string;
}

/**
 * Pull the document blocks out of the user envelope (P2-E10-10).
 *
 * STRICT ABOUT THE SOURCE TYPE, which is the whole value of this function: a
 * text document must arrive as `source.type === 'text'` carrying the contents,
 * a PDF as `source.type === 'base64'`. A regression that base64'd a text file
 * would still be valid JSON and would still round-trip — it would just reach
 * the model as gibberish. Here it shows up as a document that vanished.
 */
export function extractDocuments(message: unknown): FakeDocument[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: FakeDocument[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type !== 'document') continue;
    const title = block.title;
    const source = block.source as
      | { type?: unknown; media_type?: unknown; data?: unknown }
      | undefined;
    if (typeof title !== 'string' || typeof source?.data !== 'string') continue;
    if (source.type === 'text' && source.media_type === 'text/plain') {
      out.push({ kind: 'text', title, data: source.data });
    } else if (source.type === 'base64' && source.media_type === 'application/pdf') {
      out.push({ kind: 'pdf', title, data: source.data });
    }
  }
  return out;
}

export function extractText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: string; text: string } => (c as { type?: string })?.type === 'text')
    .map((c) => c.text)
    .join('');
}
