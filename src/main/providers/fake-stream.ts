// The stream-json fake ADAPTER (P2-E18-04) — pairs with `fake-stream-cli.ts`,
// which is the program it spawns.
//
// Registered under the same 'claude-code' id the UI uses, replacing the real
// adapter in test mode only, exactly as `fake.ts` does for the PTY. The two
// fakes are siblings and neither knows about the other: `SWITCHBOARD_FAKE_PROVIDER=1`
// still selects the PTY fake and its 98 e2e tests are untouched by this file.
import fs from 'fs';
import path from 'path';
import { ProviderAdapter, SpawnOptions, SpawnRecipe } from '../extensibility/contributions';
import { SlashCommand } from '../../shared/slash-commands';
import { conversationExists } from '../transcripts/paths';
import { ensureFolderTrusted } from '../sessions/trust';
import { claudeProjectsRoot, writeSessionSettings } from './claude';

/**
 * The compiled fake CLI.
 *
 * It is a rollup ENTRY, so it always lands in `out/main/`. This module,
 * however, is not: it is imported by `bootstrap.ts` and rollup is free to place
 * it in `out/main/chunks/`, which is exactly where it went the first time —
 * making `join(__dirname, 'fake-stream-cli.js')` point one directory too deep.
 * That failed as a 15 s spawn timeout rather than an error, because a child
 * that cannot resolve its script dies on stderr while we wait for stdout.
 *
 * So: try the candidates, and throw a NAMED error if none exists. A wrong path
 * must fail as a wrong path.
 */
export function fakeStreamCliPath(): string {
  const candidates = [
    path.join(__dirname, 'fake-stream-cli.js'), // unbundled / same dir
    path.join(__dirname, '..', 'fake-stream-cli.js'), // bundled into chunks/
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `fake-stream-cli.js not found (looked in: ${candidates.join(', ')}). ` +
        `Run \`npm run build\` — the fake stream provider needs the compiled CLI.`
    );
  }
  return found;
}

export const fakeStreamAdapter: ProviderAdapter = {
  manifest: {
    id: 'claude-code',
    displayName: 'Fake stream (test)',
    version: '0.0.0',
    capabilities: ['sessions.spawn', 'sessions.resume', 'settings.inject', 'slash-commands.list'],
  },

  // Same capabilities as the PTY fake, and for the same reason (P2-E15-01): a
  // capability-less fake would quietly delete half the harness and prove
  // nothing about the seam.
  capabilities: {
    transcripts: { projectsRoot: claudeProjectsRoot },
    hooks: { settingsFor: (sessionId, host) => host.buildHookSettings(sessionId) },
    resume: {
      canResume: (folder, nativeSessionId) =>
        conversationExists(claudeProjectsRoot(), folder, nativeSessionId),
    },
    trust: { ensureTrusted: (folder) => ensureFolderTrusted(folder) },
  },

  // The FALLBACK list — what the composer offers before the CLI has spoken.
  // In stream mode the live list arrives on `system:init.slash_commands`
  // (P2-E18-09) and replaces this entirely, which is only observable because
  // `curated-only` is deliberately NOT in the fake's `init`.
  //
  // That entry is the whole reason this test can exist. Without it the fallback
  // was a strict SUBSET of the advertised list, so "replaced" and "merged"
  // produced identical popups and no test could tell them apart — the same
  // hole as #153, where the fake ignored the requested transport and made
  // switching untestable in principle. A fake that cannot say "no" cannot test
  // the request.
  //
  // `usage` is in the fallback ON PURPOSE (#163). Dan's report was that typing
  // `/usage` as the FIRST thing in a Direct session did nothing — and the first
  // thing in a session is exactly when the CLI has not spoken yet and the
  // fallback is all there is. Without it in this list the popup never opens for
  // `/usage`, Enter submits by the ordinary path, and the e2e passes without
  // ever reaching the code that was broken.
  slashCommands(): SlashCommand[] {
    return [
      { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
      { name: 'compact', description: 'Summarize the conversation', source: 'builtin' },
      { name: 'curated-only', description: 'Only in the curated list', source: 'builtin' },
      { name: 'usage', description: 'Show subscription usage', source: 'builtin' },
    ];
  },

  /**
   * Honour the REQUESTED transport, exactly as the real adapter does.
   *
   * The first version always returned a stream recipe, which meant no test
   * could ever exercise SWITCHING — the fake ignored the very setting #149
   * added, so the human path (set it, restart, use it) was untestable and the
   * feature shipped unusable (#153). A fake that cannot say "no" to a request
   * cannot test the request.
   */
  buildSpawn(options: SpawnOptions): SpawnRecipe {
    if (options.transport !== 'stream') {
      // the PTY fake's recipe: a real shell in a real PTY
      return {
        command: process.platform === 'win32' ? 'cmd.exe' : 'sh',
        args: [],
        env: {
          ELECTRON_RUN_AS_NODE: undefined,
          ELECTRON_NO_ATTACH_CONSOLE: undefined,
        },
      };
    }
    // `--settings`, exactly as the real adapter builds it (#313).
    //
    // The fake declared the `hooks` capability from the day it was written, so
    // a token was minted and a settings file's worth of hook config was built
    // for every Direct session — and then thrown away, because this recipe
    // never passed it on. The child therefore had no way to reach the hook
    // listener, and "can a Direct session fire a hook Notification?" was
    // unanswerable in principle rather than merely untested (the same hole as
    // the ignored transport in #153). The real adapter has always passed it;
    // a fake that drops it is a fake that hides a bug.
    const args = [fakeStreamCliPath()];
    if (options.settings && Object.keys(options.settings).length > 0) {
      args.push('--settings', writeSessionSettings(options.stateDir, options.sessionId, options.settings));
    }
    // `--resume`, exactly as the real adapter passes it (#404). Dropped until
    // #404, which made the whole resume path — persisted id, `canResume`,
    // `start-plan` — invisible to every e2e on this fake: the same "a fake
    // that cannot say no cannot test the request" hole as the ignored
    // transport above, on the flag next to it.
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
    return {
      // process.execPath in the main process IS the Electron binary; with
      // ELECTRON_RUN_AS_NODE it runs plain Node, which is how the four
      // done-when checks already run (`scripts/run-electron-node.js`).
      command: process.execPath,
      args,
      env: {
        // Set DELIBERATELY, and it survives the S-01 scrub because `buildEnv`
        // applies explicit deltas AFTER deleting the inherited landmines. That
        // ordering is what makes "never leak it, but let a caller mean it"
        // expressible at all — see `transport/env.ts`.
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ATTACH_CONSOLE: undefined,
      },
      transport: 'stream',
    };
  },
};
