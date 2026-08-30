// The stream-json wire envelopes we WRITE (P2-E18-06).
//
// Shapes taken from the SDK envelope the VS Code extension sends and that S-10
// wrote to the real CLI (`spike/s10/probe-*.cjs`), not invented. Kept in
// `shared/` because the renderer composes a prompt and main sends it, and one
// definition is how those stay the same thing.
//
// This is the whole of what `renderer/lib/composer.ts` does for the PTY —
// bracketed-paste wrapper, a 75ms delayed CR, the S-03 "text+CR in one chunk
// registers as a paste and never submits" workaround — replaced by a struct.
// That entire class of timing bug does not exist on this transport.

import type { PromptAttachment } from './prompt-attachments';

/** A block of prose in a user turn. */
export interface StreamTextBlock {
  type: 'text';
  text: string;
}

/**
 * An image the model is shown, inline (P2-E10-09).
 *
 * NOT INVENTED — read out of the VS Code extension's webview bundle (2.1.226),
 * which is the known-correct consumer of this contract:
 *
 *   case"image": a.push({type:"image",source:{type:"base64",media_type:p,data:u}});break;
 *
 * where `p` is the lower-cased MIME and `u` is `dataUrl.split(",")[1]` — the
 * base64 payload with the `data:image/png;base64,` prefix STRIPPED. It is the
 * Anthropic Messages API's own block shape; `input_image` and `image_url`
 * (the OpenAI spellings) count ZERO in both bundles, which is how we know this
 * is the only shape on offer.
 *
 * There is no temp file and no `@path` mention anywhere in that path, and no
 * CLI flag: the bytes ride the stdin NDJSON line we already write. `tmpdir` in
 * the extension host is used for session-resume transcripts and nothing else.
 *
 * VERIFIED AGAINST THE CLI ON PATH, 2026-08-13 (claude 2.1.226) — one budgeted
 * turn, because the extension ships its own binary and their behaviour is not
 * our guarantee. A 64x64 solid-blue PNG in exactly this block, sent as one
 * NDJSON line, came back on the `--replay-user-messages` echo intact
 * (`source.type=base64 media_type=image/png data.len=224`) and the model
 * answered "Blue". Both halves asserted, in that order, because a silent
 * result is indistinguishable from a broken harness (S-09).
 */
export interface StreamImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/**
 * A FILE the model is shown, inline (P2-E10-10).
 *
 * Also not invented — the other two arms of the same `switch` in the same
 * webview builder (2.1.226), quoted whole so the asymmetry is visible:
 *
 *   case"text": {let g=atob(u);
 *     a.push({type:"document",source:{type:"text",media_type:"text/plain",data:g},title:c.file.name});break}
 *   case"pdf":
 *     a.push({type:"document",source:{type:"base64",media_type:"application/pdf",data:u},title:c.file.name});break;
 *
 * THE TWO SOURCES ARE DIFFERENT AND THAT IS THE POINT. A PDF travels as base64
 * (`source.type:"base64"`). A text file travels as **the decoded text itself**
 * (`source.type:"text"`) — the reference reads every file as a data URL and
 * then `atob`s the text ones straight back, so what lands in `data` is the
 * file's contents in the clear, not base64 of them. Sending base64 in a
 * `type:"text"` source would be accepted by JSON and read by the model as a
 * wall of gibberish, which is exactly the kind of failure that looks like the
 * model being unhelpful rather than like a bug.
 *
 * `title` is the bare `File.name` on both, and is NOT set on image blocks —
 * `title` counts zero in the image arm above.
 *
 * VERIFIED AGAINST THE CLI ON PATH, 2026-08-13 (claude 2.1.226) — the one
 * budgeted turn for this item, for the same reason #475 spent one on the image
 * block: the extension ships its own binary and their behaviour is not our
 * guarantee, and this is a block type we had never sent. See the item's
 * findings note for the transcript.
 */
export interface StreamDocumentBlock {
  type: 'document';
  source:
    | { type: 'base64'; media_type: 'application/pdf'; data: string }
    | { type: 'text'; media_type: 'text/plain'; data: string };
  title: string;
}

export type StreamContentBlock = StreamTextBlock | StreamImageBlock | StreamDocumentBlock;

/**
 * WHO sent this turn (#490).
 *
 * The CLI's own zod schema for the inbound user message carries
 * `origin: oxc().optional()`, and `oxc` is a discriminated union on `kind`
 * whose first arm is the only one a desktop host has any business asserting
 * (read out of `claude` 2.1.233 on PATH — the compiled binary embeds its
 * schemas):
 *
 *   oxc=ve(()=>WA("kind",[be({kind:kt("human")}),be({kind:kt("channel"),server:F()}),
 *     be({kind:kt("peer"),from:F(),…}),be({kind:kt("task-notification"),…}),
 *     be({kind:kt("coordinator")}),be({kind:kt("unclassified")})…]))
 *
 * Every other arm describes a message the ANTHROPIC side classified — a Slack
 * ping, a cross-session peer, a fired schedule. They are server-asserted
 * provenance, not something a client may claim; `peer.verifiedPeerPid`'s own
 * description says identity is keyed on the kernel, "never on `from`". So the
 * type here is deliberately narrowed to the one arm we can honestly assert.
 *
 * WE ONLY EVER SEND `human` because there is only one way into this builder:
 * `sessions:submitPrompt` ← the renderer's composer ← the user pressing Enter.
 * The day something else sends a turn — DESIGN §5.15 Dispatch briefings, the
 * §5.4 Tier-3 bus — this becomes a parameter and the union above is the menu.
 * Widening it before then would be inventing a claim we cannot back.
 */
export interface StreamUserOrigin {
  kind: 'human';
}

/** One user turn, as the CLI expects it on stdin. */
export interface StreamUserMessage {
  type: 'user';
  /** See `userMessage` — the CLI's at-most-once key. */
  uuid: string;
  message: { role: 'user'; content: StreamContentBlock[] };
  parent_tool_use_id: null;
  session_id: string;
  origin: StreamUserOrigin;
}

/**
 * What may ride a turn. Defined in `shared/prompt-attachments.ts` with the
 * rules that decide what is allowed to become one, and re-exported here so a
 * caller building a frame has one import rather than two.
 */
export type { PromptAttachment };

/**
 * Build a user turn.
 *
 * `session_id` is deliberately EMPTY, matching what S-10 sent, what the CLI
 * accepted, and what the extension itself sends (`session_id:""` in its own
 * envelope): the id belongs to the conversation the CLI is already running, and
 * echoing back a stale one is how a message gets attributed to a conversation
 * that has since been replaced (a `/clear` mints a new one — see #107).
 *
 * The text is passed through UNTOUCHED. Newlines, backticks and a leading `/`
 * are all just characters here: `JSON.stringify` escapes the newline so it can
 * never be mistaken for a frame boundary, which is exactly the property the PTY
 * path had to fake with bracketed paste.
 *
 * ATTACHMENTS COME FIRST, THE TEXT LAST — the extension's assembly order, not
 * a preference of ours. Its builder pushes IDE context, then attachments, then
 * `@terminal` and `@browser` blocks, and only then `a.push({type:"text",text:e})`
 * with the user's typed prompt. The prompt refers to the files above it, so
 * the order is part of the contract rather than a detail.
 *
 * MIXED KINDS KEEP THE USER'S ORDER. The reference walks one list and switches
 * per file, so a drop of `diagram.png` then `server.log` arrives in that order;
 * grouping by kind here would silently re-order a prompt that says "compare the
 * first with the second".
 *
 * An EMPTY prompt contributes no text block at all, rather than an empty one:
 * a file dropped and sent with nothing typed is a legitimate turn, and a
 * zero-length text block is not a thing the message format accepts.
 *
 * ---------------------------------------------------------------------------
 * `uuid` IS THE CLI'S AT-MOST-ONCE KEY (#490, added 2026-08-21)
 * ---------------------------------------------------------------------------
 *
 * We shipped without it from P2-E18-06 to here, and nothing visibly broke —
 * because the CLI's whole de-duplication pass is guarded on the field being
 * present. Verbatim from `claude` 2.1.233 on PATH (the version Dan runs; the
 * VS Code extension is 2.1.226 and ships its own binary, so PATH is the one
 * that counts):
 *
 *   if(Vr=!0,yt.uuid){let Pt=Vt(),Pr=await ZCi(Pt,yt.uuid,p.storageV5),fo=ran.has(yt.uuid),…
 *     else if(Pr||fo){…Rr("info","cli_user_message_dedup_skipped",{exists_in_session:Pr,runtime_dup:fo}),
 *       w(`Skipping duplicate user message: ${yt.uuid}`),…continue}
 *     cns(yt.uuid)}
 *   Ta("new_user_message");                                  // ← normal processing
 *
 * Read it as English: with a uuid, a turn already in this session's transcript
 * (`ZCi`) or already seen by this process (`ran`) is DROPPED before it can run
 * a second time. Without one, control falls straight past the whole block to
 * `new_user_message` — every frame executes, always. That is not "the CLI does
 * not care"; that is us opting out of the only replay protection on offer, on
 * a transport where a resend is one crash-and-retry away from running a
 * destructive prompt twice.
 *
 * A FRESH `randomUUID()` PER CALL, never derived from the text. The dedup key
 * is meant to identify a delivery, not a prompt: sending "run the tests" twice
 * on purpose is normal, and a content-hashed id would make the CLI silently
 * swallow the second one. `globalThis.crypto` rather than `node:crypto`
 * because this module is `shared/`.
 *
 * The field is `.optional()` in the CLI's inbound schema — `ixc=ve(()=>jkg()
 * .extend({uuid:Bu().optional(),session_id:F().optional(),…}))`, one arm of the
 * stdin union — and `Bu=ve(()=>F())` is a plain string with no format check.
 * So both the old shape and this one are valid; we are choosing the protection,
 * not fixing a rejection. We still mint a real RFC-4122 v4 id, because the
 * reference does and because the CLI echoes it back on
 * `--replay-user-messages` (`RCg`: `…uuid:e.uuid,timestamp:e.timestamp,
 * isReplay:!0,…`), where a recognisable id is worth more than an arbitrary one.
 *
 * ---------------------------------------------------------------------------
 * `origin` SAYS A PERSON TYPED IT
 * ---------------------------------------------------------------------------
 *
 * Absence is not neutral, but it is very nearly so: three separate predicates
 * in the same binary spell out that a missing origin MEANS human —
 *
 *   function VZ(e){return e===void 0||e.kind==="human"}
 *   function pce(e){return e===void 0||e.kind==="human"||e.kind==="auto-continuation"}
 *   function $kc(e){return e.origin===void 0||e.origin.kind==="human"||e.origin.kind==="auto-continuation"}
 *
 * — and the CLI even counts how often it had to make that assumption
 * (`L("tengu_human_origin_presumed",{consumer:…,count_bucket:…})`). One
 * predicate does NOT extend the courtesy:
 *
 *   function KMo(e){return e?.kind==="human"}
 *   …let U=N&&KMo(v);…{isRegularUserPrompt:N,isHumanTypedPrompt:U,…}
 *
 * `isHumanTypedPrompt` gates two attachment producers — `peer_mentions` and
 * `workflow_keyword_request` — that therefore never fired for us. Niche today.
 * The reason to send it anyway is not those two: it is that the field exists so
 * a host can state provenance, we know ours, and a guess the CLI has to log is
 * worse than a fact. Saying it costs one key.
 *
 * Sending it cannot cost us anything either. The only places where explicit
 * `human` differs from absent the other way are `RNs` (absent counts as
 * `unclassified`) and the `Sai`/`y5p`/`bHa` fallback that infers human from
 * `client_platform`; the first is gated on `isMeta`, which a typed prompt never
 * is, and the second only ever RE-DERIVES the same `{kind:"human"}` we are now
 * stating outright — and from a field described as "@internal … Injected
 * server[-side]", which a local stdin frame does not carry anyway.
 */
export function userMessage(
  text: string,
  attachments: readonly PromptAttachment[] = []
): StreamUserMessage {
  const content: StreamContentBlock[] = attachments.map((a) => {
    if (a.kind === 'image')
      return {
        type: 'image',
        source: { type: 'base64', media_type: a.mediaType, data: a.data },
      };
    if (a.kind === 'pdf')
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: a.data },
        title: a.title,
      };
    // text: the CONTENTS in the clear, never base64 — see StreamDocumentBlock
    return {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: a.text },
      title: a.title,
    };
  });
  // no attachments -> exactly the one-text-block array this function has always
  // returned, so every existing caller and every pinned shape is unchanged
  if (text.length > 0 || content.length === 0) content.push({ type: 'text', text });
  return {
    type: 'user',
    uuid: globalThis.crypto.randomUUID(),
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
    origin: { kind: 'human' },
  };
}

/**
 * Ask the CLI to interrupt the running turn (#154).
 *
 * Shape read out of the SDK inside the VS Code extension bundle, not guessed:
 * `interrupt()` there is `this.request({subtype:'interrupt'})`, and `request()`
 * wraps it as `{type:'control_request', request_id, request}`. The reply
 * carries `still_queued` — messages the CLI had queued and did NOT discard.
 *
 * NOTE the honest limit: what the CLI actually DOES on interrupt is still
 * unmeasured (S-11 probes 2-6 never ran; E18-12 owns that). This ships because
 * the alternative was a dead button — the stop control wrote Esc to a PTY that
 * a stream session does not have, so it did nothing at all.
 */
export interface StreamInterruptRequest {
  type: 'control_request';
  request_id: string;
  request: { subtype: 'interrupt' };
}

export function interruptRequest(requestId: string): StreamInterruptRequest {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

// ── THE OUTBOUND CONTROL CHANNEL (#721) ──────────────────────────────────────
//
// `interrupt` above is the one control request this app has ever sent, and it is
// fire-and-forget: nothing reads the reply. Everything below is the half that
// was missing — a request whose ANSWER we wait for and act on.
//
// EVERY SHAPE HERE WAS MEASURED against the CLI on PATH (2.1.245) on
// 2026-08-28, not read out of the extension bundle. The probes are in
// `spike/probes/721/` (they were drafted in a git-ignored scratch directory and
// committed there afterwards — a citation into `work_files` dies with the
// worktree, which is what this line used to be) and the write-up is
// `docs/reference-implementations.md` §1.2.2. Where the #721/#633 issue bodies
// disagree with this file, this file wins — they were drawn from grepping a
// binary for symbol names, which proves a verb EXISTS and nothing about what it
// answers.

/** Any control request we send. `subtype` names the verb; the rest is its payload. */
export interface StreamControlRequest {
  type: 'control_request';
  request_id: string;
  request: { subtype: string } & Record<string, unknown>;
}

export function controlRequest(
  requestId: string,
  request: { subtype: string } & Record<string, unknown>
): StreamControlRequest {
  return { type: 'control_request', request_id: requestId, request };
}

/**
 * One model the CLI will accept, as `list_models` describes it.
 *
 * Every field but `value` is optional on purpose: `value` is the only one we
 * SEND back, and a CLI that renames a display field must degrade the picker's
 * labels rather than empty it. Measured payload — 5 entries, 3 shown:
 *
 *     {value:"default",  resolvedModel:"claude-opus-5[1m]", displayName:"Default (recommended)",
 *      description:"Opus 5 with 1M context · Best for everyday, complex tasks", …}
 *     {value:"sonnet",   resolvedModel:"claude-sonnet-5",   displayName:"Sonnet", …}
 *     {value:"haiku",    resolvedModel:"claude-haiku-4-5-20251001", displayName:"Haiku"}
 *     // …plus "opus[1m]" and "claude-fable-5[1m]", same shape
 *
 * `supportsEffort` / `supportedEffortLevels` / `supportsFastMode` also ride
 * along and are deliberately NOT modelled — nothing consumes them yet, and a
 * type that claims them invites a surface that half-supports them.
 *
 * NOTHING IN THE PAYLOAD MARKS THE CURRENT MODEL. Neither does `initialize`
 * (its keys were dumped; there is no current-model field). The only place the
 * running model appears is `system:init.model`, which arrives ONCE PER TURN —
 * so before a session's first turn its model is genuinely unknown, and a
 * picker must say so rather than guess at `default`.
 */
export interface CliModel {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
}

/** `list_models` — the lean call. `initialize` carries the same array inside ~28 KB. */
export function listModelsRequest(requestId: string): StreamControlRequest {
  return controlRequest(requestId, { subtype: 'list_models' });
}

/**
 * `set_model` — and the one measurement that dictates how it is called.
 *
 * **`set_model` WITH NO `model` FIELD ANSWERS `success` AND CHANGES NOTHING.**
 * A non-string is properly refused (`set_model: model must be a string`) and an
 * unknown id is properly refused with a sentence — but the ABSENT case is a
 * silent no-op dressed as a working feature. So a dropped or empty field has to
 * be caught HERE; the CLI will not do it for us.
 *
 * Returns `null` for anything we refuse to send, which the caller turns into an
 * `invalid` verdict without touching the wire.
 */
export function setModelRequest(requestId: string, model: unknown): StreamControlRequest | null {
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  return controlRequest(requestId, { subtype: 'set_model', model: trimmed });
}

/**
 * `mcp_status` — the session's REAL MCP inventory (#729).
 *
 * THE ONLY SOURCE FOR IT. The config files reach three of the CLI's eight
 * runtime scopes, and the two blocs that dominate a real machine — claude.ai
 * account connectors and plugin-supplied servers — live in no file at all.
 * `claude mcp list` is not a way out either; its own description is "List
 * **configured** MCP servers".
 *
 * No arguments, and nothing to validate: unlike `set_model` there is no field
 * to drop, so this cannot have the silent-no-op shape and never returns `null`.
 *
 * ⚠️ **THE ANSWER SETTLES — it is not a one-shot** (measured 2026-08-29,
 * `spike/probes/721/probe-mcp-settle.mjs`). On a freshly spawned session:
 *
 *     [896ms]  {name:"DeepWiki", status:"pending",   scope:"local"}   // no serverInfo, no tools
 *     [5012ms] {name:"DeepWiki", status:"connected", scope:"local",
 *               serverInfo:{name:"DeepWiki",version:"2.14.3"}, tools:[…3]}
 *
 * So a surface that asks once, immediately, gets a strictly poorer answer than
 * one that waits — and `pending` is a state it has to be able to DRAW rather
 * than a transient to code around. §1.2.2's captured example is the warm answer;
 * this is the cold one, and both are real.
 */
export function mcpStatusRequest(requestId: string): StreamControlRequest {
  return controlRequest(requestId, { subtype: 'mcp_status' });
}

/**
 * `mcp_toggle` — turn one server on or off (#729 PR 2).
 *
 * ⚠️ **THE ABSENT `enabled` FIELD IS A LOADED GUN, and it is worse than the
 * `set_model` trap this file already documents.** Measured 2026-08-29
 * (`spike/probes/721/probe-mcp-toggle.mjs`), against a real server:
 *
 *     -> {subtype:"mcp_toggle", serverName:"sbprobe"}      // no `enabled`
 *     <- {subtype:"success"}                               // …and null payload
 *     -> {subtype:"mcp_status"}
 *     <- sbprobe: "disabled"                               // IT TURNED IT OFF
 *
 * `set_model` with a missing field did NOTHING and said success — bad, but
 * inert. This one **performs a destructive action** and says success: an absent
 * field reads as falsy, and the user's MCP server goes off. A dropped or
 * mistyped `enabled` anywhere upstream would disable a server and report that
 * it worked.
 *
 * So `enabled` is checked for a STRICT boolean, not for truthiness. `0`, `''`,
 * `null` and `undefined` are all refused rather than helpfully coerced —
 * coercion is exactly the CLI behaviour that makes this dangerous, and
 * repeating it here would launder the bug rather than catch it.
 *
 * ALSO NOTE IT PERSISTS. The toggle writes `projects[<folder>].disabledMcpServers`
 * in `~/.claude.json` (a different key from `disabledMcpjsonServers`, which is
 * the approval mechanism). Toggle off adds the name; toggle on removes it. It
 * is NOT session-scoped, so a surface must not tell the user otherwise.
 */
export function mcpToggleRequest(
  requestId: string,
  serverName: unknown,
  enabled: unknown
): StreamControlRequest | null {
  if (typeof serverName !== 'string') return null;
  const name = serverName.trim();
  if (!name) return null;
  // STRICT. See the docblock — this is the check that stops a dropped field
  // from silently disabling somebody's server.
  if (typeof enabled !== 'boolean') return null;
  return controlRequest(requestId, { subtype: 'mcp_toggle', serverName: name, enabled });
}

/**
 * `mcp_reconnect` — re-resolve one server, with no terminal and no restart
 * (#729 PR 2).
 *
 * **IT ALSO PICKS UP A SERVER THE SESSION NEVER LOADED**, which is the finding
 * that makes it worth more than a retry button. `mcp_status` is frozen at spawn
 * (measured in PR 1), so a server added with `claude mcp add` mid-session is
 * invisible to the running session. Measured 2026-08-29:
 *
 *     mcp_status                       -> DeepWiki, sbprobe        // sbprobe2 added, absent
 *     mcp_reconnect {name:"sbprobe2"}  -> success
 *     mcp_status                       -> DeepWiki, sbprobe, sbprobe2(connected)
 *
 * So this is the verb behind "you added a server, pull it in" as well as
 * "reconnect the one that dropped" — and it retires #714's `restart-required`
 * for every case that has a live stream session.
 */
export function mcpReconnectRequest(
  requestId: string,
  serverName: unknown
): StreamControlRequest | null {
  if (typeof serverName !== 'string') return null;
  const name = serverName.trim();
  if (!name) return null;
  return controlRequest(requestId, { subtype: 'mcp_reconnect', serverName: name });
}

/**
 * A `control_response` off the wire, or `null` if it is not one.
 *
 * ⚠️ **`request_id` IS NESTED AT `msg.response.request_id`, AND IS NOT PRESENT
 * AT THE TOP LEVEL.** Measured: every reply came back with
 * `topLevelRequestId=undefined`. The INBOUND `can_use_tool` requests we already
 * parse carry theirs at the TOP level (`stream-permissions.ts` reads
 * `msg.request_id`), so the two directions genuinely differ — a correlator
 * written by copying the inbound reader matches nothing, for ever, and looks
 * exactly like a CLI that never answers.
 *
 * Two subtypes, both measured:
 *
 *     {"type":"control_response","response":{"subtype":"success","request_id":"sb-1","response":{…}}}
 *     {"type":"control_response","response":{"subtype":"error","request_id":"sb-4",
 *      "error":"Model \"x\" is not a recognized model id. Run /model to see available models."}}
 *
 * `response` IS ABSENT ON A PAYLOAD-FREE SUCCESS — `set_model` answers
 * `{subtype:"success", request_id}` with no `response` key at all, so a reader
 * that assumes an object there gets `undefined`, not `{}`. Normalised to `{}`
 * here so callers never have to know.
 *
 * The error text is written for a human and is passed through verbatim rather
 * than re-worded: it is the CLI's own explanation, and ours would be a guess at
 * what it meant. `mcp/cli.ts` made the same call for the same reason.
 */
export interface ParsedControlResponse {
  requestId: string;
  ok: boolean;
  /** `{}` when the CLI answered success with no payload. */
  response: Record<string, unknown>;
  /** the CLI's own sentence, on an error. */
  error: string;
}

export function readControlResponse(msg: unknown): ParsedControlResponse | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'control_response') return null;
  const r = m.response;
  if (!r || typeof r !== 'object') return null;
  const body = r as Record<string, unknown>;
  // NESTED. See the docblock — reading `m.request_id` here is the bug.
  const requestId = body.request_id;
  if (typeof requestId !== 'string' || !requestId) return null;
  // Anything that is not literally `error` is treated as success, so a CLI that
  // grows a third subtype degrades to "it answered" rather than to a refusal we
  // invented. An `error` we cannot read the sentence off still fails closed.
  const ok = body.subtype !== 'error';
  const payload = body.response;
  return {
    requestId,
    ok,
    response: payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {},
    error: typeof body.error === 'string' ? body.error : '',
  };
}

/**
 * The models out of a `list_models` (or `initialize`) payload.
 *
 * Lenient by construction: a malformed entry is dropped rather than failing the
 * whole list, and an entry with no usable `value` is worthless to us because
 * `value` is the only thing `set_model` accepts.
 */
export function readModels(response: Record<string, unknown>): CliModel[] {
  const raw = response.models;
  if (!Array.isArray(raw)) return [];
  const out: CliModel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.value !== 'string' || !e.value) continue;
    out.push({
      value: e.value,
      ...(typeof e.resolvedModel === 'string' ? { resolvedModel: e.resolvedModel } : {}),
      ...(typeof e.displayName === 'string' ? { displayName: e.displayName } : {}),
      ...(typeof e.description === 'string' ? { description: e.description } : {}),
    });
  }
  return out;
}

/** A reply to a `can_use_tool` control request (P2-E18-07 sends these). */
export interface StreamControlResponse {
  type: 'control_response';
  response: {
    subtype: 'success';
    request_id: string;
    response: Record<string, unknown>;
  };
}

export function controlResponse(
  requestId: string,
  response: Record<string, unknown>
): StreamControlResponse {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  };
}
