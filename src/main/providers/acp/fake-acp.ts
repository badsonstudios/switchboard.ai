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
import { FAKE_ACP_MODE_MAP } from './fake-acp-agent';

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

export const fakeAcpAdapter = createAcpProvider({
  id: FAKE_ACP_PROVIDER_ID,
  displayName: 'Fake ACP',
  // `process.execPath` in main IS the Electron binary; run as plain Node.
  command: () => process.execPath,
  args: () => [fakeAcpCliPath()],
  env: { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: undefined },
  modeMap: FAKE_ACP_MODE_MAP,
  authMethodId: 'fake-login',
});
