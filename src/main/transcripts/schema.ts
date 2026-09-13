// The transcript contract, declared (P2-E15-10, §5.26, AR-P1-8).
//
// Claude Code's JSONL transcript schema is UNVERSIONED and moves per release
// (anthropics/claude-code#53516 is an open feature request to version it), so
// this file is the only written-down record of what we believe the shape to be.
// `drift.ts` diffs every parsed line against it and warns once per newly-seen
// key — the cheapest early warning that a CLI release changed something under
// us, per §5.26's mandated round-trip drift detector.
//
// WHY A DECLARED LIST RATHER THAN "warn on anything we don't read":
// measured 2026-07-31 against the real corpus in `~/.claude/projects` —
// **250 transcripts, 10,138 lines, 75 distinct top-level keys, 12 line
// types**. We consume 7 of those 75. A detector that warned on the other 68
// would fire ~50 times on the first real session and be muted within a day,
// which is a drift detector that detects nothing. Splitting the corpus into
// "we read it" + "we saw it and skipped it" makes the signal precisely
// "the CLI wrote something this file has not been told about".
//
// ── RE-MEASURED 2026-09-12 (#779), AND THE CAVEAT BELOW STOPPED BEING ONE ────
//
// The 2026-07-31 numbers are kept above because they are why the file has this
// shape. They are no longer what it is declared against. Two reads, both free,
// replaced them:
//
// **The corpus, again: 3,259 transcripts, 244,916 lines, 0 malformed** — 24x the
// original, and it reported **30 unknown keys, not the 5** that
// `npm run check:transcripts` had been printing. Those five were not wrong, they
// were one `-p` turn's worth: that harness drives a single hello-world turn with
// no tool calls, no subagents, no compaction, no forks and no errors. `message`
// and `message.content.*` drifted ZERO keys across all 244,916 lines, so those
// two contracts are complete; every finding was top-level or one usage key.
//
// **The CLI publishes its own list of line types.** The PATH binary (2.1.261,
// read per `docs/reference-implementations.md` §2.1) carries TWO independent
// routing tables — a GC-policy map and a dedup/routing map — which between them
// enumerate **the same 38 line types**. `KNOWN_LINE_TYPES` declared 13. The same
// binary's reducer chain then names the payload field it reads for each type
// (`tag`→`tag`, `agent-name`→`agentName`, `isolation-latch`→`side`,
// `continued-in`→`continuedInSessionId`, …), so the payload keys below are READ
// from the CLI rather than inferred from what this machine happened to trigger.
//
// That is what makes the next paragraph a historical note instead of a standing
// excuse. A corpus can only ever be a lower bound; the CLI's own tables are the
// declaration, and they were sitting on disk the whole time.
//
// THE CORPUS IS A LOWER BOUND, NOT THE FORMAT. It is one machine's history, so
// it can only contain features that machine actually used — a block type
// nobody here has triggered (redacted thinking, web-search results, citations)
// is absent from the measurement without being absent from the format. Keys
// added below on that reasoning are marked; they are the difference between a
// detector that reports real drift and one whose first week is spent
// re-discovering Anthropic's public API shape.
//
// WHY SOME ROOT KEYS ARE SCOPED TO A LINE TYPE (#779, added in review).
// The contract is keyed by PATH, not by line type, so the root list is shared by
// all 38 types. The first cut of this change put every new key in that flat list
// — including `path` and `title`, which a `frame-link` line carries. Review
// caught what that costs, and it is the detector's whole purpose:
//
//   `cwd` is CONSUMED as the primary binding evidence. `aiTitle` is read by
//   `readAiTitle`. A release renaming `cwd` → `path` or `aiTitle` → `title`
//   is EXACTLY the silent break this file exists to make loud — and declaring
//   those two names flat would have made both of them permanently silent.
//
// Measured: `path` and `title` occur **zero** times in 246,237 corpus lines,
// while `cwd` occurs 207,502 times and `aiTitle` 3,229. So the flat declaration
// bought nothing real and sold the two renames most worth hearing about.
//
// The rule that came out of it: **a key we have never actually seen is declared
// only for the line type the CLI says writes it** (`TYPE_SCOPED_ROOT_KEYS`
// below). If it turns up on another type, that is genuinely news and we want the
// warning. The 25 keys the corpus DID measure stay in the flat list — their
// presence is not news anywhere, which is the whole reason they are ignored.
//
// The legacy 69 keys from 2026-07-31 are also still flat. Re-partitioning those
// means re-measuring which type each belongs to, which is a bigger job than
// #779; unlike the note this paragraph replaced, nothing load-bearing is waiting
// on it.
//
// MAINTENANCE: this is a hand-kept list and it will go stale — that is
// inherent, not a defect. Two things make staleness loud instead of silent:
// the runtime warning below, and `watcher.test.ts`'s guard that a
// corpus-shaped transcript produces zero drift (so the parser cannot grow a
// field the schema does not know about without a red test). The probes that
// produced the 2026-09-12 numbers are committed at `spike/probes/779/` and are
// re-runnable against any later CLI — re-run them rather than re-deriving them.

/** A declared object path inside a transcript line. `.*` = each array element. */
export type SchemaPath =
  | ''
  | 'message'
  | 'message.usage'
  | 'message.content.*';

export interface PathContract {
  /** Keys named by our parsing types — the fields we actually build on. */
  readonly consumed: readonly string[];
  /** Keys measured in the corpus that we deliberately do not read. Listed so
   *  their PRESENCE is not news; their disappearance is not tracked (a field
   *  we never read going away cannot break us). */
  readonly ignored: readonly string[];
  /** Child keys whose own contents are declared, and where. A key absent here
   *  is not walked — its interior is not part of our contract. */
  readonly descend?: Readonly<Record<string, SchemaPath>>;
}

/**
 * Every line `type` the CLI declares. A value outside this list is drift in its
 * own right — §5.26 mandates warning once per unknown TYPE as well as per
 * unknown field. We derive Feed blocks from `user` and `assistant` only; the
 * other 36 are CLI bookkeeping we tolerate and skip.
 *
 * SOURCED FROM THE CLI, NOT FROM THE CORPUS (#779, 2026-09-12, PATH binary
 * 2.1.261). This list was 13 entries measured off one machine's transcripts,
 * which meant four types the CLI writes on ordinary sessions — `atis-latch`,
 * `relocated`, `worktree-state`, `cost-state` — reported as drift, and another
 * 21 were waiting to do the same the first time a feature was used. The binary
 * carries two independent routing tables that enumerate the same 38, so the list
 * is now the CLI's own.
 *
 * ⚠️ IT IS THE CLI'S DECLARED SET, NOT A PROOF OF EXHAUSTIVENESS. Both tables
 * fall back to a default for an unlisted type (`?? "accumulate"` in one), so a
 * 39th type the CLI writes but does not route specially would be absent from
 * both maps and absent from here. That is exactly the case the detector still
 * exists to catch, and it is why expanding this list does not retire it.
 */
export const KNOWN_LINE_TYPES: readonly string[] = [
  // ── conversation and its immediate bookkeeping ──
  'assistant',
  'attachment',
  'progress',
  'system',
  'user',
  // `summary` was NOT in the 2026-07-31 corpus: resumed/compacted transcripts
  // open with one, and `claim()`'s head-parsing archaeology is built around that
  // fact. The first resume of a compacted conversation would otherwise report
  // drift. The CLI's tables confirm it.
  'summary',
  // ── titles the CLI derives or the user sets ──
  'ai-title', // the CLI's own session title (P2-E7-06 builds on this)
  'custom-title',
  'last-prompt',
  'tag',
  // ── per-session latches, each "last one wins" ──
  'agent-color',
  'agent-name',
  'agent-setting',
  'atis-latch',
  'isolation-latch',
  'mode',
  'permission-mode',
  // ── lifecycle and continuation ──
  'continued-in',
  'ended-by-model',
  'history-suppression',
  'queue-operation',
  'relocated',
  'worktree-state',
  // ── accounting the CLI keeps for itself ──
  'attribution-snapshot',
  'cost-state',
  // ── file-history checkpointing (the rewind feature) ──
  'file-history-delta',
  'file-history-snapshot',
  'marble-origami-commit',
  'marble-origami-reset',
  'marble-origami-snapshot',
  // ── forks, bridges, observers and artifacts ──
  'artifact-autoreact-ledger',
  'artifact-comment-monitor',
  'bridge-session',
  'content-replacement',
  'fork-context-ref',
  'frame-link',
  'observer-ref',
  'pr-link',
];

/**
 * Root keys declared for ONE line type only — accepted on that type, drift
 * anywhere else.
 *
 * Every key here shares two properties: the corpus has **never** contained it,
 * and the CLI's own reducer names it as the field it reads for that line type
 * (PATH binary 2.1.261 — see `docs/reference-implementations.md` §2.1). Being
 * unmeasured is exactly why they are scoped: an unmeasured key in the flat root
 * list is a name we have bought on speculation and given away on every one of
 * the 38 types.
 *
 * `path` and `title` are why this map exists. They belong to a `frame-link`
 * line, and declared flat they would have permanently silenced a `cwd` → `path`
 * or `aiTitle` → `title` rename — the consumed-field rename that is the single
 * loudest thing this detector is for. Scoped, that rename is still drift and
 * still gets its one log line.
 *
 * A key appearing on an unexpected type therefore costs one warn-once slot and
 * says something true ("the CLI moved this"). That is the right side of the
 * trade; permanent silence is not.
 */
export const TYPE_SCOPED_ROOT_KEYS: Readonly<Record<string, readonly string[]>> = {
  'custom-title': ['customTitle'],
  tag: ['tag'],
  'isolation-latch': ['side'],
  'agent-name': ['agentName'],
  'agent-color': ['agentColor'],
  'agent-setting': ['agentSetting'],
  'continued-in': ['continuedInSessionId'],
  'bridge-session': [
    'bridgeSessionId',
    'lastSequenceNum',
    'sessionGroupingId',
    'noHistoryBackfill',
    'ownerAccountUuid',
    'ownerOrganizationUuid',
    'declaredDialogKinds',
  ],
  'frame-link': ['artifactCount', 'frameUrl', 'path', 'title'],
  'content-replacement': ['replacements'],
};

export const TRANSCRIPT_SCHEMA: Readonly<Record<SchemaPath, PathContract>> = {
  '': {
    consumed: [
      'type', // user / assistant drive block derivation
      'sessionId', // binding evidence + the native id we persist
      'cwd', // binding evidence (readHead)
      'timestamp', // block ts, thinking durations
      'isSidechain', // subagent blocks indent
      'isMeta', // CLI-internal lines are not conversation
      'message',
    ],
    // 94 keys. Grouped only for readability — order is not meaning. 69 were
    // measured 2026-07-31; the other 25 were added 2026-09-12 (#779) and were
    // each MEASURED over 244,916 lines. Keys named by the CLI's reducer but never
    // seen are in `TYPE_SCOPED_ROOT_KEYS`, not here.
    //
    // THIS COUNT IS CHECKED AGAINST THIS LIST BY A TEST, because it had already
    // rotted: the comment here read "68 keys, measured" while the list held 69.
    // The test reads this number out of the source and compares — so there is
    // nothing to bump in two places and it can only fail when the comment and the
    // list genuinely disagree.
    ignored: [
      // identity / threading
      'uuid',
      'parentUuid',
      'logicalParentUuid',
      'leafUuid',
      'messageId',
      'requestId',
      'promptId',
      'session_id', // snake_case twin of sessionId on some line types
      'toolUseID',
      'sourceToolUseID',
      'sourceToolAssistantUUID',
      'supersedesUuids',
      'retractedMessageUuids',
      'refusedUserMessageUuid',
      'snapshotMessageId',
      // The id of the subagent that produced a line — 80,128 occurrences over
      // 385 files, spanning 2.1.226 → 2.1.261, so it predates our corpus rather
      // than being new. We read `isSidechain`, which INDENTS a subagent block but
      // cannot group one: two agents running concurrently interleave into one
      // indented run. Consuming this is a follow-up, not drift.
      'agentId',
      // environment stamps
      'version',
      'gitBranch',
      'entrypoint',
      'userType',
      'origin',
      'effort', // reasoning effort the turn ran at
      'slug',
      'source',
      'trigger',
      'direction',
      // the CLI's own derived text (P2-E7-06 will CONSUME aiTitle; until that
      // item ships it is knowingly on the floor)
      'aiTitle',
      'lastPrompt',
      'content',
      'subtype',
      'level',
      // NOT in the 2026-07-31 corpus — kept because older/compacted transcripts
      // open with a summary record (the `claim()` archaeology depends on it),
      // and warning about a key we already know about helps nobody
      'summary',
      // who produced a turn. `attributionSkill` was measured in 2026-07-31;
      // the other three arrived with the agent/MCP attribution work and name the
      // subagent, MCP server and MCP tool behind an assistant line. Same
      // follow-up as `agentId`: naming the agent in the Feed is a feature, and
      // #757 is the neighbouring ticket.
      'attributionSkill',
      'attributionAgent',
      'attributionMcpServer',
      'attributionMcpTool',
      // tool bookkeeping
      'toolUseResult',
      'toolDenialKind',
      'hasOutput',
      'durationMs',
      'messageCount',
      'hookCount',
      'hookErrors',
      'hookInfos',
      'hookAdditionalContext',
      'pendingBackgroundAgentCount',
      'preventedContinuation',
      'stopReason',
      // which API content block an assistant line came from. 2.1.261-only, and
      // the version dating is earned: 18,101 of that release's 18,111 assistant
      // lines carry it and nothing before it does. A genuinely recent addition
      // rather than a gap in the old measurement.
      'apiBlockIndex',
      // an abort flag on a stream cut off mid-way. Seen ONCE in 246,237 lines, so
      // it is deliberately NOT dated: at n=1 the version-range method cannot tell
      // "new in 2.1.261" from "a rare event that happened to occur on 2.1.261",
      // and pretending otherwise would misuse the one technique the rest of this
      // measurement rests on.
      'isAbortedMidStream',
      // modes & permissions
      'mode',
      'permissionMode',
      'promptSource',
      'operation',
      'atis', // `atis-latch` lines; the CLI constrains it to printable ASCII
      // prompt queueing. `reason` is the queue-operation verdict
      // ("absorbed_mid_turn"); the others mark how a queued turn was handled.
      'reason',
      'turnCompanion',
      'queueSkipAttachments',
      'interruptedByShutdown',
      // file-history lines
      'snapshot',
      'isSnapshotUpdate',
      'trackingPath',
      'backup',
      // PR lines
      'prNumber',
      'prUrl',
      'prRepository',
      // errors / retries / refusals
      'error',
      'isApiErrorMessage',
      'apiErrorStatus',
      'apiRefusalCategory',
      'apiRefusalExplanation',
      'retryInMs',
      'retryAttempt',
      'maxRetries',
      'originalModel',
      'fallbackModel',
      // compaction
      'compactMetadata',
      'isCompactSummary',
      'isVisibleInTranscriptOnly',
      // attachments. MEASURED, because the first draft of this comment had it
      // backwards and would have pointed a future Feed at the smaller half of the
      // data: `attachment` is the STRUCTURED payload and it is on 75,487 of
      // 75,487 attachment lines, versions 2.1.217 → 2.1.261. `rendered` /
      // `renderedInHumanTurn` are a PRE-RENDERED text form (the expanded
      // system-reminder blocks) that 2.1.261 adds for only SOME attachment kinds
      // — 9,883 of 36,095 of its attachment lines, 27%. A Feed that renders
      // attachments needs both, not either.
      'attachment',
      'rendered',
      'renderedInHumanTurn',
      // cwd relocation and worktree entry — `relocated` / `worktree-state` lines
      'relocatedCwd',
      'worktreeSession',
      // `cost-state` lines: the CLI's OWN accounting for the session, written
      // into the transcript. §5.13 currently ESTIMATES cost from token counts,
      // and `totalCostUSD` plus the per-model breakdown in `modelUsage` is the
      // CLI's own number for the same thing — a follow-up, and the most valuable
      // thing #779 turned up.
      'totalCostUSD',
      'modelUsage',
      'hasUnknownModelCost',
      'totalAPIDuration',
      'totalAPIDurationWithoutRetries',
      'totalToolDuration',
      'totalDuration',
      'totalLinesAdded',
      'totalLinesRemoved',
      'startTime',
      // NOTE: the payload keys for line types the corpus has never contained are
      // NOT here — they are in `TYPE_SCOPED_ROOT_KEYS`, declared against the one
      // type the CLI says writes them. See the header.
    ],
    descend: { message: 'message' },
  },

  message: {
    consumed: [
      'content',
      'role',
      'usage',
      'model', // last-seen model id, for cost estimation
    ],
    ignored: [
      'id',
      'type',
      'stop_reason',
      'stop_sequence',
      'stop_details',
      'diagnostics',
      'context_management',
      'container',
    ],
    descend: { content: 'message.content.*', usage: 'message.usage' },
  },

  'message.usage': {
    consumed: [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ],
    ignored: [
      'service_tier',
      // a per-TTL breakdown (5m / 1h) of the same tokens cache_creation_input_tokens
      // already totals — not walked, and never added on top
      'cache_creation',
      'inference_geo',
      'server_tool_use',
      // NEVER sum this on top of the totals: it is an iteration count, not
      // tokens (the ClaudeMon read, DESIGN §5.13)
      'iterations',
      'speed',
      // NEVER SUM THIS ON TOP EITHER — and unlike the two above, this one was
      // MEASURED rather than reasoned (#779, `spike/probes/779/usage-details.mjs`).
      // Its only sub-key is `thinking_tokens`, and it is a BREAKDOWN OF
      // `output_tokens`: over 42,071 lines that carry it, 25,908 of them with
      // `thinking_tokens > 0`, it exceeded `output_tokens` **zero** times, with a
      // maximum ratio of 0.9928 — approaching 1.0 without ever crossing it,
      // which is what a subset does on a thinking-heavy turn and not what an
      // independent quantity does. The CLI agrees by construction: its own
      // aggregator adds `output_tokens` to a running total and tracks
      // `thinking_tokens` in a SEPARATE field, never summing the two. Surfacing
      // the breakdown in §5.13's usage pane is a follow-up; adding it to the
      // output total would silently inflate every number we show.
      'output_tokens_details',
    ],
    // deliberately no descend: every sub-object here is a counter we do not
    // read, and their interiors are not a contract we depend on
  },

  'message.content.*': {
    consumed: [
      'type',
      'text',
      'thinking',
      'name',
      'input', // tool arguments — see below, NOT descended
      'id',
      'tool_use_id',
      'content',
    ],
    ignored: [
      'signature',
      'is_error',
      'caller',
      'source',
      'from',
      'to',
      // Not in the corpus — nobody on this machine has triggered them — but
      // they are part of the block vocabulary, and each would otherwise fire a
      // false "drift" the first time Dan used the feature:
      'data', // redacted_thinking blocks carry their payload here
      'citations', // text blocks, once web search / documents are in play
      'cache_control', // prompt-caching markers on a content block
      'title', // document / search-result blocks
      'url',
      'context',
    ],
    // `input` is deliberately not declared: tool arguments are defined by each
    // TOOL, not by the transcript format. Walking them would report every
    // parameter of every skill and MCP server anyone ever runs as "drift".
  },
};
