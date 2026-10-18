// The fake ACP PROVIDER (E40 item 06, #1289): the general ACP engine
// (`createAcpProvider`) pointed at the fake agent (`fake-acp-cli.ts`).
//
// Registered only when a test asks for it — `SWITCHBOARD_FAKE_PROVIDER=acp`
// (`bootstrap.ts`) — and under its OWN id, `fake-acp`, not `claude-code`: the
// whole point is a second AI beside the first, so the Session view can be
// shown to work for an AI that is not Claude.
import fs from 'fs';
import path from 'path';
import { createAcpProvider } from './acp-provider';
import type { DetectCapability } from '../../extensibility/contributions';
import { defaultAcpDetect } from './acp-provider';
import { FAKE_ACP_MODE_MAP, FAKE_ACP_VERSION } from './fake-acp-agent';

export const FAKE_ACP_PROVIDER_ID = 'fake-acp';

/**
 * The compiled fake agent. A rollup entry, so it lands in `out/main/`; this
 * module may be bundled into `out/main/chunks/`, so both are tried and a
 * missing file is a NAMED error (`fakeStreamCliPath`'s reasoning).
 */
export function fakeAcpCliPath(baseDir: string = __dirname): string {
  const candidates = [path.join(baseDir, 'fake-acp-cli.js'), path.join(baseDir, '..', 'fake-acp-cli.js')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `fake-acp-cli.js not found (looked in: ${candidates.join(', ')}). ` +
        'Run `npm run build` — the fake ACP provider needs the compiled agent.'
    );
  }
  return found;
}

const fakeLaunch = {
  command: (): string => process.execPath,
  args: (): string[] => [fakeAcpCliPath()],
  env: { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: undefined },
};

/** The engine's default sign-in, pointed at the fake. */
const fakeAcpLogin: NonNullable<DetectCapability['login']> = (signal, methodId) =>
  defaultAcpDetect({ ...fakeLaunch, authMethodId: 'fake-login' }).login!(signal, methodId);

/**
 * The fake agent under another provider id. ONE use: the manual's picture of
 * the AIs' colours (#1326, `SWITCHBOARD_FAKE_PROVIDER=ai-colours`), which needs
 * a session on Codex and one on Gemini at once — and a session's AI is its
 * provider id, which is only ever a REGISTERED one (a restored card on an id
 * nobody hosts is moved to the default, `start-plan.ts`). Registered as
 * `codex` and `gemini`, the badge finds the catalog's Codex and Gemini entries
 * by those ids, exactly as it would for the real ones.
 */
export function fakeAcpAdapterAs(id: string, displayName: string): ReturnType<typeof createAcpProvider> {
  return createAcpProvider({
    id,
    displayName,
    // `process.execPath` in main IS the Electron binary; run as plain Node.
    ...fakeLaunch,
    modeMap: FAKE_ACP_MODE_MAP,
    authMethodId: 'fake-login',
    // it stands in for Codex in the e2e, so it declares Codex's convention (#1295)
    instructionFiles: ['AGENTS.md'],
    // E40 item 08 (#1291): the fake is always installed (it ships in `out/`),
    // its version is the one its `initialize` reports, and it is "logged out"
    // exactly when `FAKE_ACP_REQUIRE_AUTH=1` makes it demand `authenticate`.
    // "Log in" stays the engine's default: the fake's own `authenticate`, run
    // standalone.
    detect: {
      detect: () =>
        Promise.resolve({
          installed: true,
          version: FAKE_ACP_VERSION,
          login: process.env.FAKE_ACP_REQUIRE_AUTH === '1' ? 'logged-out' : 'logged-in',
        }),
      login: fakeAcpLogin,
    },
  });
}

export const fakeAcpAdapter = fakeAcpAdapterAs(FAKE_ACP_PROVIDER_ID, 'Fake ACP');
