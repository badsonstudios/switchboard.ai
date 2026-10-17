// Codex, as a provider (E40 item 07, #1290): the general ACP engine
// (`createAcpProvider`, #1289) pointed at OpenAI's ACP adapter for Codex.
// Design record §4 "As built, item 07"; the measured contract is
// `spike/findings/e40-codex-acp.md` (#1285, verdict: ACP).
//
// WHAT RUNS. `npx -y @agentclientprotocol/codex-acp@2.2.2` — PINNED, so an
// adapter release cannot change the contract under us between two app starts.
// The adapter runs its own bundled Codex (0.160.1 when measured), not the
// `codex` CLI on PATH; `CODEX_PATH` is deliberately not set (the owner's call,
// #1290). Both share `~/.codex`, so the user's own login is the one used.
//
// LOGIN IS CODEX'S OWN. Codex lists `api-key` FIRST in `authMethods`; the
// owner's account is a ChatGPT login, so the engine is told to run `chat-gpt`
// (Codex's browser sign-in) — and only when `session/new` says
// "Authentication required". No key path, no stored credential (§6).
import type { AutonomyMode } from '../../../shared/sessions';
import { createAcpProvider } from '../acp/acp-provider';
import type { DetectCapability, UsageCapability } from '../../extensibility/contributions';
import { detectCodex, npxPath } from './codex-detect';
import { createLimitsReader } from './codex-limits';

export const CODEX_PROVIDER_ID = 'codex';
export const CODEX_ACP_PACKAGE = '@agentclientprotocol/codex-acp@2.2.2';

/**
 * The card's autonomy modes in Codex's `mode` ids (read off `b-session.jsonl`):
 *
 *   read-only          "Requires approval to edit files and access the internet."
 *   workspace-write    "Edit workspace files; ask before writing outside the
 *                       workspace or accessing the network."
 *   agent              "Auto review" — Codex's DEFAULT: "Only ask for actions
 *                       detected as potentially unsafe"
 *   agent-full-access  "Unrestricted access to the internet and any file on
 *                       your computer"
 *
 * `agent` IS IN NO SLOT, ON PURPOSE (the owner's call, #1290). Measured in
 * #1285: in `agent` a hidden "Guardian review" model approved an MCP call
 * without asking anyone and spent 7,262 tokens no usage number shows. The
 * approval bar is the product, so every mode here routes Codex's approvals to
 * the user — and full-auto, the one place the user has asked for no
 * approvals, uses `agent-full-access`, which has no hidden approver either.
 *
 * Ask and auto-edit share `workspace-write`: Codex has three modes that are not
 * `agent` for our four. The engine's readback keeps the card's own choice when
 * two map to one (`AcpSession.modeEvent`).
 */
export const CODEX_MODE_MAP: Record<AutonomyMode, string> = {
  ask: 'workspace-write',
  plan: 'read-only',
  'auto-edit': 'workspace-write',
  'full-auto': 'agent-full-access',
};

/**
 * `npx`'s absolute path at spawn time. Registration already checked it is
 * there (`bootstrap.ts`); if it has gone since, the spawn fails with a named
 * error, as Claude's does. Never the bare name: a PATH-relative `.cmd` with the
 * cwd set to the user's project is S-01's planted-binary footgun, and a bare
 * `npx.cmd` was measured to break the shim's `%~dp0` besides (#1285 Q1).
 */
export function codexCommand(): string {
  const npx = npxPath();
  if (!npx) throw new Error('npx not found on PATH — Codex runs its ACP adapter through npx (Node.js)');
  return npx;
}

/**
 * Register Codex at startup? (`bootstrap.ts`.) Only on a real launch — never in
 * a fake-provider e2e run, which must stay hermetic — and only when `npx` is on
 * PATH, since that is what runs the adapter (it installs itself on first use).
 *
 * A PATH SCAN AND NOTHING ELSE: no child process, no network, nothing that can
 * slow or block startup. Whether Codex is installed and logged in is the
 * detection runner's question (#1291), asked after first paint. Codex is
 * registered AFTER Claude, so Claude stays the default AI and nothing about a
 * Claude session changes.
 */
export function shouldRegisterCodex(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SWITCHBOARD_FAKE_PROVIDER) return false;
  try {
    return npxPath(env.PATH ?? '') !== null;
  } catch {
    return false;
  }
}

const engine = createAcpProvider({
  id: CODEX_PROVIDER_ID,
  displayName: 'Codex',
  command: codexCommand,
  args: ['-y', CODEX_ACP_PACKAGE],
  modeMap: CODEX_MODE_MAP,
  authMethodId: 'chat-gpt',
  version: '2.2.2',
  // the 5-hour and weekly windows, from `codex app-server` (one zero-token
  // call, cached 60 s, fail-open): what ACP carries only as `/status` text
  limits: createLimitsReader(),
  // MEASURED (#1285 Q7): Codex reads `AGENTS.md`, and never `CLAUDE.md`
  instructionFiles: ['AGENTS.md'],
});

/**
 * NO PRICE (#1288's rule: "show whatever the AI reports"). The owner's Codex is
 * a ChatGPT plan, not per-token billing, and Codex reports no cost; a figure
 * here would be one nobody reported. Tokens and the plan windows still show.
 */
const codexUsage: UsageCapability = { estimateCostUsd: () => undefined };

/**
 * DETECTION IS CODEX'S OWN, NOT THE ENGINE'S PATH SCAN (#1291's rebase step).
 * The engine's default scans for the command it runs, which for Codex is
 * `npx` — so it would report Codex "installed" on every machine with Node.
 * `detectCodex` asks for the `codex` CLI itself, its `--version`, and its
 * sign-in (`account/read`, zero tokens), and honours the runner's 5 s signal:
 * a slow probe is killed and answers `unknown`. "Log in" stays the engine's:
 * a standalone `authenticate` with `chat-gpt`, Codex's own browser sign-in.
 */
const codexDetect: DetectCapability = {
  ...engine.capabilities?.detect,
  detect: (signal) => detectCodex(signal),
};

export const codexAdapter: typeof engine = {
  ...engine,
  capabilities: { ...engine.capabilities, usage: codexUsage, detect: codexDetect },
};
