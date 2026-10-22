// A "Something else" AI as a provider (E40 item 08, #1291): any program that
// speaks ACP, on the general engine, with NO code change — the epic's exit
// criterion for a second ACP agent.
//
// LAUNCHED BY ABSOLUTE PATH ONLY (S-01). The command is resolved on PATH at
// every spawn, so installing the program mid-run works. A command that cannot
// be resolved is NOT passed through as typed: the session spawns with the
// user's project as its cwd, and on Windows a bare name is looked up in the cwd
// before PATH, so a same-named program sitting in the project would run (the
// planted-binary footgun). Instead the spawn fails, on screen, for that session
// — exactly how a missing `claude` fails.
//
// The arguments were VALIDATED when the entry was added
// (`ai-catalog/custom-ais.ts`). The stream transport's `launchSpec` lets libuv
// build the command line: right for argv the app writes, and not for argv a
// person typed, when the program is a `.cmd` shim. So nothing cmd.exe acts on
// may appear, and no argument may contain whitespace. libuv quotes an argument
// with a space, and once a quoted command path is followed by a second quoted
// string, `cmd /c` strips the outer quotes and runs `C:\Program`. The RESOLVED
// path is checked here too, because PATH is not something the user typed.
import type { CustomAi, CustomAiTestResult } from '../../../shared/ais';
import type { ProviderAdapter } from '../../extensibility/contributions';
import { findOnPath } from '../../transport/find-on-path';
import { createAcpProvider } from './acp-provider';
import { probeAcpAgent, PROBE_TIMEOUT_MS } from './acp-probe';

/** what `cmd.exe` would act on in a resolved command path */
const CMD_META = /[()%!^"<>&|]/;

/** `ai.command` as an absolute path we are willing to launch, or a thrown, readable reason. */
export function resolveCustomCommand(ai: Pick<CustomAi, 'name' | 'command'>, find: (c: string) => string | null = (c) => findOnPath(c)): string {
  const resolved = find(ai.command);
  if (!resolved) throw new Error(`"${ai.command}" was not found on this computer. Is ${ai.name} installed?`);
  if (CMD_META.test(resolved)) {
    throw new Error(`${ai.name} is installed at a path this app cannot launch safely: ${resolved}`);
  }
  return resolved;
}

export function customAcpProvider(ai: CustomAi, clientVersion?: string): ProviderAdapter {
  return createAcpProvider({
    id: ai.id,
    displayName: ai.name,
    command: () => resolveCustomCommand(ai),
    args: [...ai.args],
    ...(ai.env ? { env: { ...ai.env } } : {}),
    ...(clientVersion ? { clientVersion } : {}),
  });
}

/**
 * "Test": start the command, say `initialize`, report what came back, and
 * leave nothing running (`acp-probe.ts`). Never rejects.
 */
export async function testAcpCommand(
  cmd: { command: string; args: string[]; env?: Record<string, string> },
  opts: { signal?: AbortSignal; timeoutMs?: number; clientVersion?: string } = {}
): Promise<CustomAiTestResult> {
  const r = await probeAcpAgent({
    command: cmd.command,
    args: cmd.args,
    ...(cmd.env ? { env: cmd.env } : {}),
    timeoutMs: opts.timeoutMs ?? PROBE_TIMEOUT_MS,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.clientVersion ? { clientVersion: opts.clientVersion } : {}),
  });
  return {
    ok: r.ok,
    ms: r.ms,
    ...(r.agentName ? { agentName: r.agentName } : {}),
    ...(r.agentVersion ? { agentVersion: r.agentVersion } : {}),
    ...(r.protocolVersion !== undefined ? { protocolVersion: r.protocolVersion } : {}),
    ...(r.authMethods ? { authMethods: r.authMethods } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.errorCode ? { errorCode: r.errorCode } : {}),
  };
}
