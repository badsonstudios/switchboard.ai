// Claude's per-AI surfaces (E40 item 05, #1288): the six capabilities that let
// the app's chrome around a session stop assuming Claude.
//
// ONE OBJECT, DECLARED BY BOTH CLAUDE ADAPTERS. The real `claudeAdapter` and
// the e2e fake (`fake-stream.ts`, which runs under Claude's id and replays
// Claude's frames) spread the same object, so the suites keep exercising the
// real surface code: the fake changes how a SESSION is hosted, not what its
// price list, status page, preflight, labeler, MCP list or command files are.
import type { ProviderCapabilities } from '../extensibility/contributions';
import { buildAddArgs, buildRemoveArgs, RESET_APPROVALS_ARGS } from '../../shared/mcp-args';
import { claudeEstimateCostUsd } from './claude-pricing';
import { claudePreflight } from './claude-preflight';
import { runContainedPrompt } from './claude-oneshot';
import { readInventory } from './claude-mcp-config';
import { checkHealth } from './claude-mcp-health';
import { runMcp } from './claude-mcp-cli';
import { claudeCommandFiles } from './claude-command-files';

/**
 * The page DESIGN §5.14 names. As of 2026-08-11 it answers 302 →
 * status.claude.com for both API paths, which `probeStatuspage` follows; the
 * base stays the documented address so a rename is absorbed by the redirect.
 */
export const CLAUDE_STATUSPAGE_BASE = 'https://status.anthropic.com';

export const claudeSurfaces: Pick<
  ProviderCapabilities,
  'usage' | 'statusPage' | 'preflight' | 'labels' | 'mcpManager' | 'commandFiles'
> = {
  usage: { estimateCostUsd: claudeEstimateCostUsd },
  // the page is Anthropic's, covering more than Claude Code, so it is named so
  statusPage: { base: CLAUDE_STATUSPAGE_BASE, name: 'Anthropic' },
  preflight: { check: claudePreflight },
  labels: { run: runContainedPrompt },
  mcpManager: {
    inventory: (folder, log) => readInventory(folder, log),
    health: (folder) => checkHealth(folder),
    // THE SECRETS GO IN WITH THE CALL, not out of the answer afterwards:
    // `runMcp` redacts them out of the CLI's words before it applies the
    // length bound (`claude-mcp-cli.ts`'s `detailFrom`).
    add: (folder, request, secrets) => runMcp(folder, buildAddArgs(request), { secrets }),
    remove: (folder, name, scope) => runMcp(folder, buildRemoveArgs(name, scope)),
    resetApprovals: (folder) => runMcp(folder, RESET_APPROVALS_ARGS),
  },
  commandFiles: claudeCommandFiles,
};
