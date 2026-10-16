// `createAcpProvider` — ANY agent that speaks the Agent Client Protocol, as a
// `ProviderAdapter` (E40 item 06, #1289; design record §4).
//
// One engine, many registrations: the fake ACP agent registers here today;
// Codex (#1290) and a user's "Something else" entry (#1291) register their
// own instances without touching `acp-session.ts`.
//
// THE PAIRING. ACP's events depend on what its controls asked — which
// JSON-RPC id is the prompt, which is `session/new` — so one session's
// translator and controls must share one `AcpSession`. The host hands all
// three entry points switchboard's session id: `buildSpawn` (as
// `options.sessionId`), `controls.createControls` (`session.id`) and
// `events.createTranslator` (`session.id`). `buildSpawn` creates the
// session, the other two find it, and `forget` (the session's end, from the
// teardown and the exit path) lets it go.
import type { AutonomyMode } from '../../../shared/sessions';
import { BUS_SERVER_NAME } from '../../bus/bus-paths';
import { errorText } from '../../../shared/error-text';
import type { AiLoginResult } from '../../../shared/ais';
import type { DetectCapability, ProviderAdapter, SpawnOptions, SpawnRecipe } from '../../extensibility/contributions';
import { findOnPath } from '../../transport/find-on-path';
import type { EngineTranslator, TranslatorHooks } from '../../sessions/engine-events';
import type { ControlSession, SessionControls } from '../../sessions/engine-controls';
import { readMcpServers, stdioMcpServer } from './acp-protocol';
import { probeAcpAgent } from './acp-probe';
import { AcpSession, type Remembered } from './acp-session';

export interface AcpProviderOptions {
  /** the provider id cards persist (`identity.providerId`) */
  id: string;
  /** what the UI calls it — "Not available with <displayName>." */
  displayName: string;
  /** the program to run; a Windows `.cmd` is launched through `cmd.exe /c` */
  command: string | (() => string);
  args?: string[] | (() => string[]);
  /** env deltas over the scrubbed process env (`transport/env.ts`) */
  env?: Record<string, string | undefined>;
  /**
   * The host's autonomy modes in this agent's mode ids. ABSENT: the session
   * declares `modes` with no live `set`, and no mode is ever sent — a guess at
   * what an unknown agent's modes mean is not ours to make.
   */
  modeMap?: Partial<Record<AutonomyMode, string>>;
  /**
   * Which of the agent's `authMethods` to run when `session/new` answers
   * "Authentication required" (-32000). ABSENT: none is run and the error is
   * shown. Codex lists `api-key` FIRST and the owner's account is a ChatGPT
   * login, which is why "the first one" is not a safe default.
   */
  authMethodId?: string;
  /** `manifest.version` */
  version?: string;
  /** reported to the agent as `clientInfo.version` */
  clientVersion?: string;
  /**
   * The `detect` capability (E40 item 08, #1291). ABSENT: a PATH scan for the
   * command (installed or not; version and login unknown, since asking would
   * mean starting the agent, and for an npx agent that is a download), and
   * "Log in" runs the agent's own `authenticate` standalone (`acp-probe.ts`).
   */
  detect?: DetectCapability;
}

/** The default `detect` for an ACP agent: see `AcpProviderOptions.detect`. */
export function defaultAcpDetect(opts: {
  command: () => string;
  args: () => string[];
  env?: Record<string, string | undefined>;
  authMethodId?: string;
  clientVersion?: string;
}): DetectCapability {
  return {
    detect: () => {
      let found: string | null = null;
      try {
        found = findOnPath(opts.command());
      } catch {
        found = null;
      }
      return Promise.resolve(
        found
          ? { installed: true, login: 'unknown', detail: 'this AI does not report its version or sign-in until a session starts' }
          : { installed: false, login: 'unknown' }
      );
    },
    login: async (signal, methodId): Promise<AiLoginResult> => {
      let command: string;
      try {
        command = opts.command();
      } catch (err) {
        return { supported: true, ok: false, reason: err instanceof Error ? err.message : errorText(err) };
      }
      const r = await probeAcpAgent({
        command,
        args: opts.args(),
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.clientVersion ? { clientVersion: opts.clientVersion } : {}),
        signal,
        authenticate: { ...((methodId ?? opts.authMethodId) ? { methodId: methodId ?? opts.authMethodId } : {}) },
      });
      if (r.ok) return { supported: true, ok: true };
      return {
        supported: true,
        ok: false,
        ...(r.error ? { reason: r.error } : {}),
        ...(r.needsMethod && r.authMethods ? { methods: r.authMethods } : {}),
      };
    },
  };
}

/** Sessions built but never adopted (a spawn that failed after `buildSpawn`)
 *  are dropped past this many, oldest first, so a run of failed starts cannot
 *  grow the map without bound. */
const MAX_UNADOPTED = 32;

export function createAcpProvider(opts: AcpProviderOptions): ProviderAdapter & {
  /** test seam: the live engine for a session id */
  sessionFor(id: string): AcpSession | undefined;
} {
  const sessions = new Map<string, AcpSession>();
  const unadopted: string[] = [];
  /** model / effort per conversation, re-applied after a load (in memory) */
  const memory = new Map<string, Remembered>();
  const resolve = <T>(v: T | (() => T)): T => (typeof v === 'function' ? (v as () => T)() : v);

  const sessionConfig = {
    displayName: opts.displayName,
    clientVersion: opts.clientVersion ?? '0.0.0',
    ...(opts.modeMap ? { modeMap: opts.modeMap } : {}),
    ...(opts.authMethodId ? { authMethodId: opts.authMethodId } : {}),
  };

  const adopt = (id: string): void => {
    const i = unadopted.indexOf(id);
    if (i >= 0) unadopted.splice(i, 1);
  };

  const engineFor = (id: string): AcpSession => {
    let s = sessions.get(id);
    if (!s) {
      // No `buildSpawn` for this id (a test double, a host that changed
      // order, or an entry dropped past MAX_UNADOPTED): the folder is unknown,
      // so the engine REFUSES to open — it says so on screen and answers every
      // control — rather than pointing the agent at the app's own directory.
      s = new AcpSession(id, { cwd: '', mcpServers: [], lost: true }, sessionConfig, memory);
      sessions.set(id, s);
    }
    return s;
  };

  return {
    manifest: {
      id: opts.id,
      displayName: opts.displayName,
      version: opts.version ?? '0.0.0',
      capabilities: ['sessions.spawn', 'sessions.resume'],
    },

    capabilities: {
      events: {
        createTranslator(hooks: TranslatorHooks, session?: { id: string }): EngineTranslator {
          if (!session) return () => [];
          const s = engineFor(session.id);
          s.setHooks(hooks);
          return (frame) => s.translate(frame);
        },
      },
      controls: {
        createControls(session: ControlSession): SessionControls {
          const s = engineFor(session.id);
          adopt(session.id);
          const controls = s.controls();
          s.attach(session);
          const forget = controls.forget;
          return {
            ...controls,
            forget: () => {
              forget?.();
              sessions.delete(session.id);
            },
          };
        },
      },
      // The agent is the authority on its own conversations, and nothing here
      // can ask it before spawn. So "yes" for any id the card holds; a
      // conversation that is not there fails `session/load`, and the engine
      // opens a new one instead (`AcpSession.onError`, 'load').
      resume: { canResume: ({ nativeSessionId }) => nativeSessionId !== '' },
      // The Session Bus, in ACP's shape: a stdio server in `session/new`'s
      // `mcpServers`, `env` as a list. The host's wiring, the agent's schema —
      // the same split Claude's `--mcp-config` file has.
      mcp: {
        configFor: (sessionId, host) => {
          const launch = host.attachSession(sessionId);
          return launch ? { mcpServers: [stdioMcpServer(BUS_SERVER_NAME, launch)] } : null;
        },
      },
      detect:
        opts.detect ??
        defaultAcpDetect({
          command: () => resolve(opts.command),
          args: () => [...(opts.args ? resolve(opts.args) : [])],
          ...(opts.env ? { env: opts.env } : {}),
          ...(opts.authMethodId ? { authMethodId: opts.authMethodId } : {}),
          ...(opts.clientVersion ? { clientVersion: opts.clientVersion } : {}),
        }),
    },

    buildSpawn(options: SpawnOptions): SpawnRecipe {
      const command = resolve(opts.command);
      const args = [...(opts.args ? resolve(opts.args) : [])];
      const s = new AcpSession(
        options.sessionId,
        {
          cwd: options.cwd,
          mcpServers: readMcpServers(options.mcpConfig),
          ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
          ...(options.autonomy ? { autonomy: options.autonomy } : {}),
        },
        sessionConfig,
        memory
      );
      sessions.set(options.sessionId, s);
      unadopted.push(options.sessionId);
      while (unadopted.length > MAX_UNADOPTED) sessions.delete(unadopted.shift()!);
      return { command, args, env: { ...opts.env }, transport: 'stream' };
    },

    sessionFor: (id) => sessions.get(id),
  };
}
