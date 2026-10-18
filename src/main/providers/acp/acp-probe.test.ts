// The standalone ACP probe (#1291) against the REAL fake agent, run as a real
// child process: "Test" on a "Something else" entry, and "Log in".
//
// The fake is compiled for the test with esbuild (the app's own build does the
// same through rollup into `out/main/fake-acp-cli.js`), into a temp dir, and
// started with this Node — so the probe spawns, talks NDJSON over real pipes,
// and must leave no process behind. That last part is asserted by pid.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { probeAcpAgent } from './acp-probe';
import { testAcpCommand } from './custom-acp';
import { defaultAcpDetect } from './acp-provider';

let dir: string;
let agentJs: string;
let silentJs: string;
let dyingJs: string;
let quickJs: string;
let home: string;

/** true while a process with this pid exists */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function goneSoon(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-acp-probe-'));
  home = path.join(dir, 'home');
  fs.mkdirSync(home);
  agentJs = path.join(dir, 'fake-acp-cli.js');
  buildSync({
    entryPoints: [path.join(__dirname, 'fake-acp-cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: agentJs,
    logLevel: 'silent',
  });
  silentJs = path.join(dir, 'silent.js');
  fs.writeFileSync(silentJs, 'setInterval(() => {}, 1000);\n');
  quickJs = path.join(dir, 'quick.js');
  // answers initialize and exits AT ONCE: the answer must not be lost to 'exit'
  fs.writeFileSync(
    quickJs,
    "process.stdin.once('data', () => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 0, result: { protocolVersion: 1, agentInfo: { name: 'quick', version: '1.0.0' }, authMethods: [] } }) + String.fromCharCode(10)); process.exit(0); });\n"
  );
  dyingJs = path.join(dir, 'dying.js');
  fs.writeFileSync(dyingJs, "process.stderr.write('no such model');\nprocess.exit(3);\n");
}, 30_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const node = process.execPath;
/** the fake keeps its history under HOME; point it at the temp dir */
const env = (): Record<string, string> => ({ HOME: home, USERPROFILE: home });

describe('probeAcpAgent: Test (initialize only)', () => {
  it('starts the agent, reports what initialize said, and leaves nothing running', async () => {
    const r = await probeAcpAgent({ command: node, args: [agentJs], env: env(), timeoutMs: 15_000 });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, agentName: 'fake-acp', agentVersion: '0.0.0', protocolVersion: 1, authMethods: ['fake-login'] });
    // the agent's own label for each method rides along, by id (#1316)
    expect(r.authMethodNames).toEqual({ 'fake-login': 'Fake login' });
    expect(r.pid).toBeTypeOf('number');
    expect(await goneSoon(r.pid!)).toBe(true);
  });

  it('a command that is not on this computer is a plain answer, not a throw', async () => {
    const r = await probeAcpAgent({ command: 'definitely-not-an-agent-1291', args: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/was not found on this computer/);
  });

  it('an agent that answers and exits at once still counts as answered', async () => {
    const r = await probeAcpAgent({ command: node, args: [quickJs], timeoutMs: 15_000 });
    expect(r).toMatchObject({ ok: true, agentName: 'quick', agentVersion: '1.0.0', protocolVersion: 1, authMethods: [] });
  });

  it('a program that exits before answering says so, with its last words', async () => {
    const r = await probeAcpAgent({ command: node, args: [dyingJs], timeoutMs: 15_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/exited \(code 3\) before answering: no such model/);
  });

  it('a program that never answers times out, and is killed', async () => {
    const r = await probeAcpAgent({ command: node, args: [silentJs], timeoutMs: 800 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not answer within 1 s/);
    expect(await goneSoon(r.pid!)).toBe(true);
  });

  it('an abort (app quit) ends it and kills the child', async () => {
    const c = new AbortController();
    const p = probeAcpAgent({ command: node, args: [silentJs], timeoutMs: 15_000, signal: c.signal });
    setTimeout(() => c.abort(), 300);
    const r = await p;
    expect(r.error).toBe('cancelled');
    expect(await goneSoon(r.pid!)).toBe(true);
  });
});

describe('probeAcpAgent: Log in (the agent’s own authenticate)', () => {
  it('runs the one method the agent offers', async () => {
    const r = await probeAcpAgent({
      command: node,
      args: [agentJs],
      env: { ...env(), FAKE_ACP_REQUIRE_AUTH: '1' },
      authenticate: {},
      timeoutMs: 15_000,
    });
    expect(r).toMatchObject({ ok: true, authMethod: 'fake-login' });
    expect(await goneSoon(r.pid!)).toBe(true);
  });

  it('a method the agent does not offer is refused before anything is sent', async () => {
    const r = await probeAcpAgent({ command: node, args: [agentJs], env: env(), authenticate: { methodId: 'api-key' }, timeoutMs: 15_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not offer the sign-in method "api-key"/);
  });

  it('defaultAcpDetect.login maps the probe onto the AiLoginResult the IPC returns', async () => {
    const cap = defaultAcpDetect({ command: () => node, args: () => [agentJs], env: env(), authMethodId: 'fake-login' });
    expect(await cap.login!(new AbortController().signal)).toEqual({ supported: true, ok: true });
    const missing = defaultAcpDetect({ command: () => 'definitely-not-an-agent-1291', args: () => [] });
    const r = await missing.login!(new AbortController().signal);
    expect(r).toMatchObject({ supported: true, ok: false });
    expect(r.reason).toMatch(/not found/);
  });
});

describe('defaultAcpDetect.detect: a PATH scan, nothing started', () => {
  it('installed when the command resolves; version and login unknown', async () => {
    const found = await defaultAcpDetect({ command: () => node, args: () => [] }).detect(new AbortController().signal);
    expect(found).toMatchObject({ installed: true, login: 'unknown' });
    const missing = await defaultAcpDetect({ command: () => 'definitely-not-an-agent-1291', args: () => [] }).detect(
      new AbortController().signal
    );
    expect(missing).toEqual({ installed: false, login: 'unknown' });
  });
});

describe('testAcpCommand: the custom-AI Test result', () => {
  it('reports the agent and drops the pid', async () => {
    const r = await testAcpCommand({ command: node, args: [agentJs], env: env() }, { timeoutMs: 15_000 });
    expect(r).toMatchObject({ ok: true, agentName: 'fake-acp', agentVersion: '0.0.0', protocolVersion: 1, authMethods: ['fake-login'] });
    expect(r).not.toHaveProperty('pid');
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });
});
