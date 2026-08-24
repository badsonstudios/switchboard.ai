// Claude Code provider adapter v1 (P1-E2-02) — registered via the
// contribution registry (§5.23); nothing outside bootstrap imports this
// directly. Implements the spike verdicts:
//   S-01: absolute CLI path (PATH-relative .cmd with cwd=user project is a
//         planted-binary footgun) + env landmine scrubs
//   S-02: settings injection via `--settings <abs path>` — generated
//         per-session file, VALIDATED before spawn (invalid settings files
//         are silently ignored by the CLI — our hooks would vanish quietly)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ProviderAdapter, SpawnOptions, SpawnRecipe } from '../extensibility/contributions';
import { SlashCommand } from '../../shared/slash-commands';
import type { AutonomyMode } from '../../shared/sessions';
// The transcript LOCATION is Claude's, so the check for "is this conversation
// really there" belongs to this adapter; the tolerant reader it shares with
// every other provider stays host-side (see ProviderCapabilities.transcripts).
import { conversationExists, listConversations, locateConversation } from '../transcripts/paths';
import { ensureFolderTrusted } from '../sessions/trust';

const CLI_NAMES = process.platform === 'win32' ? ['claude.cmd', 'claude.exe'] : ['claude'];

let cachedCliPath: string | null | undefined;

/**
 * Resolve the claude CLI to an absolute path by scanning PATH. Positive
 * results are cached; a miss is re-scanned each call so installing the CLI
 * mid-run doesn't require an app restart.
 */
export function resolveCliPath(envPath = process.env.PATH ?? ''): string | null {
  if (cachedCliPath != null) return cachedCliPath;
  cachedCliPath = scanPath(envPath);
  return cachedCliPath;
}

export function scanPath(envPath: string): string | null {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const name of CLI_NAMES) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

/** test seam */
export function resetCliPathCache(): void {
  cachedCliPath = undefined;
}

/**
 * Write + validate the per-session settings file. Throws rather than letting
 * the CLI silently ignore a malformed file (S-02 caveat).
 */
export function writeSessionSettings(
  stateDir: string,
  sessionId: string,
  settings: Record<string, unknown>
): string {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('session settings must be a plain object');
  }
  if ('hooks' in settings) {
    validateHooksShape(settings.hooks);
  }
  const dir = path.join(stateDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const json = JSON.stringify(settings, null, 2);
  JSON.parse(json); // round-trip: what we hand the CLI must parse
  fs.writeFileSync(file, json);
  return file;
}

function validateHooksShape(hooks: unknown): void {
  if (typeof hooks !== 'object' || hooks === null) {
    throw new Error('settings.hooks must be an object of event -> matcher groups');
  }
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
    for (const g of groups) {
      const inner = (g as { hooks?: unknown }).hooks;
      if (!Array.isArray(inner) || inner.length === 0) {
        throw new Error(`hooks.${event}[] needs a non-empty "hooks" array`);
      }
      for (const h of inner) {
        const cmd = (h as { command?: unknown }).command;
        if (typeof cmd !== 'string' || cmd.trim() === '') {
          throw new Error(`hooks.${event}[] entries need a "command" string`);
        }
      }
    }
  }
}

/**
 * The CLI's builtin slash commands (P2-E10-07). CURATED DATA, not behavior:
 * the descriptions are the CLI's own wording, and the set is version-volatile
 * by nature (like tool-name coverage — see the 2026-07-22 PowerShell probe
 * note). A stale entry is harmless — the CLI itself rejects or ignores it —
 * so keeping this list fresh is a maintenance chore, not a correctness risk.
 * Verified against claude 2.1.x.
 */
const CLAUDE_BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'add-dir', description: 'Add a new working directory' },
  { name: 'agents', description: 'Manage agent configurations' },
  { name: 'bug', description: 'Submit feedback about Claude Code' },
  { name: 'clear', description: 'Clear conversation history and free up context' },
  { name: 'compact', description: 'Summarize the conversation to free up context' },
  { name: 'config', description: 'Open the settings panel' },
  { name: 'context', description: 'Visualize current context usage' },
  { name: 'cost', description: 'Show token usage and cost for this session' },
  { name: 'doctor', description: 'Diagnose and verify your installation' },
  { name: 'exit', description: 'Exit the REPL' },
  { name: 'export', description: 'Export the conversation to a file or clipboard' },
  { name: 'help', description: 'Show help and available commands' },
  { name: 'hooks', description: 'Manage hook configurations' },
  { name: 'ide', description: 'Manage IDE integrations' },
  { name: 'init', description: 'Initialize a CLAUDE.md file for this project' },
  { name: 'login', description: 'Sign in with your Anthropic account' },
  { name: 'logout', description: 'Sign out of your Anthropic account' },
  { name: 'mcp', description: 'Manage MCP server connections' },
  { name: 'memory', description: 'Edit memory files' },
  { name: 'model', description: 'Set the model for this session' },
  { name: 'output-style', description: 'Set the output style' },
  { name: 'permissions', description: 'Manage tool permission rules' },
  { name: 'plugin', description: 'Manage plugins and marketplaces' },
  { name: 'pr-comments', description: 'Get comments from a GitHub pull request' },
  { name: 'release-notes', description: 'View release notes' },
  { name: 'resume', description: 'Resume a previous conversation' },
  { name: 'review', description: 'Review a pull request' },
  { name: 'rewind', description: 'Rewind the conversation and/or code changes' },
  { name: 'security-review', description: 'Review pending changes for security issues' },
  { name: 'status', description: 'Show version, model, account and connectivity' },
  { name: 'statusline', description: 'Configure the status line' },
  { name: 'terminal-setup', description: 'Configure terminal Shift+Enter binding' },
  { name: 'todos', description: 'List current todo items' },
  { name: 'usage', description: 'Show plan usage limits' },
  { name: 'vim', description: 'Toggle vim editing mode' },
].map((c) => ({ ...c, source: 'builtin' as const }));

/**
 * Where the CLI writes conversation transcripts. Read per call rather than
 * captured at module load: cheap, and it removes a startup-order dependency on
 * when `HOME` is resolved.
 */
export function claudeProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * The conversation title Claude Code writes into its own transcript (§5.11,
 * P2-E7-06) — the `titles` capability's whole implementation, and the ONE place
 * in the tree that knows this spelling:
 *
 * ```jsonl
 * {"type":"ai-title","sessionId":"bd2517c3-…","aiTitle":"Add markdown and file preview feature"}
 * ```
 *
 * Verified 2026-07-30 across 27 real transcripts in `~/.claude/projects/`, and
 * again while building this item: the two keys appear in either order on the
 * line, so nothing here may depend on their position.
 *
 * UNDOCUMENTED. No Claude Code contract promises the key exists or keeps its
 * name, which makes it a §5.26 version-drift item: the day a release renames or
 * drops it, every line simply stops carrying a title, this returns undefined
 * for all of them, and the app reads exactly as it did before the feature
 * existed. That is the reason it is a capability and not a branch — the failure
 * is contained to one function that one adapter owns.
 *
 * Blank and whitespace-only titles are rejected here rather than downstream: a
 * label that renders as empty is indistinguishable from no label, and letting
 * one through would blank a label the CLI had already filled.
 */
export function readAiTitle(line: Record<string, unknown>): string | undefined {
  if (line.type !== 'ai-title') return undefined;
  const title = typeof line.aiTitle === 'string' ? line.aiTitle.trim() : '';
  return title || undefined;
}

/**
 * How recently a transcript must have been written to be presumed IN USE, and
 * therefore never offered as a repair target (#484).
 *
 * The repair's `claimed` list only knows about switchboard's own cards. A
 * `claude` session the user is running in a terminal right now is invisible to
 * it, and is also — by definition — the newest file in the folder, which is
 * precisely what the repair would otherwise reach for. Five minutes is far
 * longer than the gap between a session's turns and far shorter than the age of
 * anything a card actually lost.
 */
export const RECENTLY_ACTIVE_MS = 5 * 60 * 1000;

/**
 * §5.9 autonomy profile -> the CLI's `--permission-mode` value.
 *
 * **Every profile names its mode. Nothing is left to the CLI's built-in
 * default** (#587) — because that default moved under us. From CLI **v2.1.228**
 * (macOS/Linux/WSL) and **v2.1.233** on native Windows, the built-in starting
 * mode on Pro/Max/Team plans is `auto` — a classifier reviews each action
 * instead of a person. `ask` used to pass no flag at all and inherit that, so
 * on a current CLI the profile named "ask" no longer asked: everything our
 * PreToolUse hook does not gate (fail-open when the listener is down, tool
 * names outside `PRETOOL_MATCHER`) went to the classifier rather than to Dan.
 * Naming the mode is the whole fix — we still let the CLI enforce it.
 *
 * `default` is Manual mode's config value: "stops and asks you before most
 * actions that edit files, run shell commands, or reach the network". The CLI
 * renamed the *label* to Manual in v2.1.200 and `--help` on 2.1.233 advertises
 * only the `manual` alias — but `default` is the canonical value the SDK,
 * hooks and `permissions.defaultMode` use, it is what `manual` is normalized
 * to, and it is the one that also works on pre-2.1.200 CLIs. So: `default`.
 *
 * Passing the flag is enough; we deliberately do NOT also write
 * `permissions.defaultMode` into the per-session settings file, because
 * `--permission-mode` outranks every settings file in the CLI's own precedence
 * order. One lever, not two.
 *
 * This does not take a mode away from the user: `auto` is in the Shift+Tab
 * cycle whenever the account is eligible, regardless of the start flag.
 *
 * CONTRACT NOTE — semantics last verified **2026-08-19 against `claude`
 * 2.1.233 on PATH** (values probed with `--permission-mode <v> --version`, no
 * token spend: `default`, `manual`, `auto`, `dontAsk`, `acceptEdits`, `plan`,
 * `bypassPermissions` all accepted; a bogus value is rejected, so acceptance
 * is a real signal) and against the SDK enum embedded in the VS Code extension
 * 2.1.226 (`["acceptEdits","auto","bypassPermissions","default","dontAsk",
 * "plan"]` plus a `manual -> default` alias) and the settings schema's
 * `permissions.defaultMode` description. Re-verify on a CLI major bump.
 */
export const AUTONOMY_PERMISSION_MODE: Record<AutonomyMode, string> = {
  plan: 'plan',
  ask: 'default',
  'auto-edit': 'acceptEdits',
  'full-auto': 'bypassPermissions',
};

export const claudeAdapter: ProviderAdapter = {
  manifest: {
    id: 'claude-code',
    displayName: 'Claude Code',
    version: '0.3.0',
    capabilities: ['sessions.spawn', 'sessions.resume', 'settings.inject', 'slash-commands.list'],
  },

  // §5.3: Claude Code implements everything. This is the adapter the contract
  // was derived FROM, so if any of it cannot be expressed here, the contract is
  // wrong (§5.23's own test).
  capabilities: {
    transcripts: { projectsRoot: claudeProjectsRoot },
    // §5.11: the CLI already computed a description of the conversation, so we
    // display it rather than deriving one of our own — which would spend the
    // user's subscription tokens on chrome (P7).
    titles: { titleFrom: readAiTitle },
    // pass the host's wiring straight through — the CLI's `settings.hooks`
    // schema IS the shape HookListener builds
    hooks: { settingsFor: (sessionId, host) => host.buildHookSettings(sessionId) },
    // Resume eligibility (§5.3's `resume`; the feature it serves is §5.25's
    // resume-on-relaunch): only the layout knows whether the conversation is
    // really on disk.
    // The ROOT is the host's — the one it resolved from `transcripts` above and
    // will hand the watcher and the resumed-history replay — so this answer and
    // the file that gets read back cannot be about two different directories
    // (#432; the coupling #395 found and only documented).
    resume: {
      canResume: ({ projectsRoot, folder, nativeSessionId }) =>
        conversationExists(projectsRoot, folder, nativeSessionId),
      // The repair half (#484). Claude's layout puts every conversation for a
      // folder in one directory, so "the one this card lost" is answerable: the
      // newest unclaimed transcript there, since the CLI appends to a
      // conversation right up to the moment it is left.
      //
      // It is still a GUESS, and everything below is about the cost of a wrong
      // one. That cost went up once we measured that plain `--resume` APPENDS to
      // the file rather than forking it (2026-08-15, claude 2.1.226): adopting
      // the wrong conversation does not just mislabel the card, it writes into
      // somebody's transcript. So four refusals, in order:
      findOrphaned: ({ projectsRoot, folder, claimed, ownIds }) => {
        // 1. ONLY IF THE CARD'S OWN IDS ARE REALLY GONE. `canResume` is a
        //    boolean and answers no to both "not there" and "could not look",
        //    so the host cannot establish this and we must. A lock that cleared
        //    between that call and this one would otherwise move a card with a
        //    perfectly good transcript into a different conversation — this
        //    issue's own defect, committed by its own repair.
        for (const id of ownIds) {
          if (locateConversation(projectsRoot, folder, id).status !== 'absent') return null;
        }
        const listing = listConversations(projectsRoot, folder);
        // 2. NEVER FROM A DIRECTORY WE COULD NOT READ, and never from one so
        //    large the answer would be meaningless — `listConversations` says
        //    `unknown` for both. A folder with thousands of conversations in it
        //    is exactly where "the newest one" is least likely to be this
        //    card's, and declining to guess is the honest answer.
        if (listing.status !== 'ok') return null;
        const taken = new Set([...claimed, ...ownIds]);
        const now = Date.now();
        return (
          listing.conversations.find(
            (c) =>
              // 3. NOT ONE ANOTHER CARD HOLDS, and not one of ours (which are
              //    all absent by the check above, but say it rather than rely
              //    on it).
              !taken.has(c.nativeId) &&
              // 4. NOT ONE SOMEBODY IS PROBABLY IN RIGHT NOW. A transcript
              //    written to seconds ago is far more likely to be a `claude`
              //    session running in a terminal — which `claimed` cannot see,
              //    because it only knows about switchboard's cards — than a
              //    conversation this card walked away from and lost.
              now - c.mtimeMs > RECENTLY_ACTIVE_MS
          )?.nativeId ?? null
        );
      },
    },
    // §5.9: the CLI refuses to work in a folder the user has not accepted, and
    // it asks with a modal we cannot answer from here. Writing the acceptance
    // is Claude-specific — a provider that has never heard of `~/.claude.json`
    // must not have it written on its behalf.
    trust: { ensureTrusted: (folder) => ensureFolderTrusted(folder) },
  },

  slashCommands(): SlashCommand[] {
    return CLAUDE_BUILTIN_COMMANDS;
  },

  buildSpawn(options: SpawnOptions): SpawnRecipe {
    const cli = resolveCliPath();
    if (!cli) {
      throw new Error(
        'claude CLI not found on PATH — first-run preflight (P1-E6-03) should have caught this'
      );
    }
    const args: string[] = [];
    if (options.settings && Object.keys(options.settings).length > 0) {
      const settingsPath = writeSessionSettings(
        options.stateDir,
        options.sessionId,
        options.settings
      );
      args.push('--settings', settingsPath);
    }
    // Duplex stream-json (P2-E18-08a). The flag list is S-10 §1, read out of the
    // SDK's own argument builder inside the VS Code extension bundle — NOT
    // reconstructed from `--help`, whose claim that these "only work with
    // --print" is stale (S-10 probe A ran without it).
    //
    // `--permission-prompt-tool stdio` is the one that matters: it is what makes
    // the CLI delegate `can_use_tool` instead of drawing its own prompt, and
    // S-09 proved it is silently IGNORED by an interactive TUI session — so it
    // belongs here, on the stream branch, and nowhere else.
    const stream = options.transport === 'stream';
    if (stream) {
      args.push(
        '--output-format', 'stream-json',
        '--verbose',
        '--input-format', 'stream-json',
        '--permission-prompt-tool', 'stdio',
        // echo our own user messages back, so a send is ACKNOWLEDGED rather
        // than assumed (P2-E18-06's criterion, which landed here with the
        // recipe because the flag had nowhere else to live)
        '--replay-user-messages',
        // Token-level `stream_event` deltas (P2-E18-10) — without it the CLI
        // sends only the finished `assistant` message and a reply appears all
        // at once, which is the file-poll experience with extra steps. Both
        // S-10 and S-11 spawned with it; the SDK's own argument builder in the
        // extension bundle emits exactly this flag for its
        // `includePartialMessages` option.
        '--include-partial-messages'
      );
    }
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
    // §5.9 autonomy profiles -> CLI permission modes. EVERY profile names its
    // mode explicitly, including `ask`; see the note on AUTONOMY_PERMISSION_MODE.
    args.push('--permission-mode', AUTONOMY_PERMISSION_MODE[options.autonomy ?? 'ask']);
    return {
      command: cli,
      args,
      env: {
        // S-01 landmines: never let these leak into a hosted session
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_NO_ATTACH_CONSOLE: undefined,
      },
      // We ANSWER with what we will actually do. The host asked; only the
      // adapter knows whether its CLI speaks the protocol.
      transport: stream ? 'stream' : undefined,
    };
  },
};
