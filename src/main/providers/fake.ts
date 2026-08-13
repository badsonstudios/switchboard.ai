// Fake provider for e2e tests (SWITCHBOARD_FAKE_PROVIDER=1). Spawns the OS
// shell in a real PTY instead of the claude CLI — a genuine interactive
// terminal we can type into and assert on, with no CLI login and no network,
// so UI tests are hermetic and CI-safe. Registered under the 'claude-code' id
// the UI uses, replacing the real adapter in test mode only.
import { ProviderAdapter, SpawnRecipe } from '../extensibility/contributions';
import { SlashCommand } from '../../shared/slash-commands';
import { conversationExists } from '../transcripts/paths';
import { ensureFolderTrusted } from '../sessions/trust';
// the real adapter's root, imported rather than re-derived: a hand-copied
// second copy is how "indistinguishable from the real thing" quietly stops
// being true
import { claudeProjectsRoot, readAiTitle } from './claude';

export const fakeAdapter: ProviderAdapter = {
  manifest: {
    id: 'claude-code',
    displayName: 'Fake (test)',
    version: '0.0.0',
    capabilities: ['sessions.spawn', 'sessions.resume', 'settings.inject', 'slash-commands.list'],
  },

  // The same capabilities as the real adapter, deliberately (P2-E15-01).
  // This is a stand-in for Claude, NOT the generic PTY-only adapter: the e2e
  // harness posts to the hook server using the per-session `hook-token` files
  // that the hook capability causes to be written, and several specs write real
  // transcript JSONL into the temp home and assert the Session view renders it.
  // A capability-less fake would quietly delete both halves of the harness and
  // prove nothing about the seam. The zero-capability path is exercised by a
  // test adapter in `sessions/start-plan.test.ts` and `sessions/ipc.test.ts`.
  capabilities: {
    transcripts: { projectsRoot: claudeProjectsRoot },
    titles: { titleFrom: readAiTitle },
    hooks: { settingsFor: (sessionId, host) => host.buildHookSettings(sessionId) },
    resume: {
      canResume: (folder, nativeSessionId) =>
        conversationExists(claudeProjectsRoot(), folder, nativeSessionId),
    },
    trust: { ensureTrusted: (folder) => ensureFolderTrusted(folder) },
  },
  // a tiny builtin catalog so the composer popup + ⋯ session controls are
  // e2e-drivable; the hosted shell just echoes an unknown "/clear" (harmless)
  slashCommands(): SlashCommand[] {
    return [
      { name: 'clear', description: 'Clear conversation history', source: 'builtin' },
      { name: 'compact', description: 'Summarize the conversation', source: 'builtin' },
    ];
  },
  // Takes no `options` and therefore IGNORES the requested transport — this
  // fake only knows how to be a terminal, and a recipe without a `transport`
  // field says so (`session-manager.ts` reads that silence as `pty`).
  //
  // Load-bearing since #381 made Direct the default: the host now asks every
  // session for the stream and this adapter refuses, so every spec on
  // `SWITCHBOARD_FAKE_PROVIDER=1` — which is nearly the whole suite — still runs
  // on the PTY. Worth knowing before assuming the suite covers the app's
  // default configuration: only the specs on the dual-capable fake
  // (`=stream`, `providers/fake-stream.ts`) do.
  buildSpawn(): SpawnRecipe {
    return {
      command: process.platform === 'win32' ? 'cmd.exe' : 'sh',
      args: [],
      env: {
        // S-01 landmines: never leak these into the hosted shell
        ELECTRON_RUN_AS_NODE: undefined,
        ELECTRON_NO_ATTACH_CONSOLE: undefined,
      },
    };
  },
};
