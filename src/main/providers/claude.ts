// Claude Code provider adapter v1 (P1-E2-02) — registered via the
// contribution registry (§5.23); nothing outside bootstrap imports this
// directly. Implements the spike verdicts:
//   S-01: absolute CLI path (PATH-relative .cmd with cwd=user project is a
//         planted-binary footgun) + env landmine scrubs
//   S-02: settings injection via `--settings <abs path>` — generated
//         per-session file, VALIDATED before spawn (invalid settings files
//         are silently ignored by the CLI — our hooks would vanish quietly)
import fs from 'fs';
import path from 'path';
import { ProviderAdapter, SpawnOptions, SpawnRecipe } from '../extensibility/contributions';
import { SlashCommand } from '../../shared/slash-commands';

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

export const claudeAdapter: ProviderAdapter = {
  manifest: {
    id: 'claude-code',
    displayName: 'Claude Code',
    version: '0.2.0',
    capabilities: ['sessions.spawn', 'sessions.resume', 'settings.inject', 'slash-commands.list'],
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
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
    // §5.9 autonomy profiles -> CLI permission modes ('ask' = CLI default)
    const mode = {
      plan: 'plan',
      ask: null,
      'auto-edit': 'acceptEdits',
      'full-auto': 'bypassPermissions',
    }[options.autonomy ?? 'ask'];
    if (mode) args.push('--permission-mode', mode);
    return {
      command: cli,
      args,
      env: {
        // S-01 landmines: never let these leak into a hosted session
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_NO_ATTACH_CONSOLE: undefined,
      },
    };
  },
};
