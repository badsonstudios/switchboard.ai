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
// THE CORPUS IS A LOWER BOUND, NOT THE FORMAT. It is one machine's history, so
// it can only contain features that machine actually used — a block type
// nobody here has triggered (redacted thinking, web-search results, citations)
// is absent from the measurement without being absent from the format. Keys
// added below on that reasoning are marked; they are the difference between a
// detector that reports real drift and one whose first week is spent
// re-discovering Anthropic's public API shape.
//
// MAINTENANCE: this is a hand-kept list and it will go stale — that is
// inherent, not a defect. Two things make staleness loud instead of silent:
// the runtime warning below, and `watcher.test.ts`'s guard that a
// corpus-shaped transcript produces zero drift (so the parser cannot grow a
// field the schema does not know about without a red test).

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
 * Line `type` values seen in the corpus. A value outside this list is drift in
 * its own right — §5.26 mandates warning once per unknown TYPE as well as per
 * unknown field. We derive Feed blocks from `user` and `assistant` only; the
 * other ten are CLI bookkeeping we tolerate and skip.
 */
export const KNOWN_LINE_TYPES: readonly string[] = [
  'ai-title', // the CLI's own session title (P2-E7-06 builds on this)
  'assistant',
  'attachment',
  'file-history-delta',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'pr-link',
  'queue-operation',
  'summary', // NOT in the corpus: resumed/compacted transcripts open with one,
  // and `claim()`'s head-parsing archaeology is built around that fact. The
  // first resume of a compacted conversation would otherwise report drift.
  'system',
  'user',
];

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
    // 68 keys, measured. Grouped only for readability — order is not meaning.
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
      // tool bookkeeping
      'toolUseResult',
      'toolDenialKind',
      'attributionSkill',
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
      // modes & permissions
      'mode',
      'permissionMode',
      'promptSource',
      'operation',
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
      // attachments
      'attachment',
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
    ],
    // deliberately no descend: both sub-objects are counters we do not read,
    // and their interiors are not a contract we depend on
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
