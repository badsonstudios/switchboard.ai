// P2-E11-03 done-when check: a REAL `claude` session, spawned through our own
// adapter, really reaches the bus — and the user's own MCP servers survive it.
//
// Exits 0 on PASS, 1 on FAIL. Run with: npm run check:mcp-attach
//
// ── WHY THIS IS NOT A CI JOB (#182) ────────────────────────────────────────
//
// It needs a LOGGED-IN `claude` CLI. It does NOT need a model turn and spends
// no tokens — `mcp_status` is a control request, and this script never sends a
// prompt — but the login is enough to keep it out of CI, so it joins the
// `check:adapter` / `check:hooks` / `check:transcripts` family in
// `check-scripts.test.ts`'s LOCAL_ONLY map rather than becoming a workflow step.
//
// `check:bus` (#762) already proves the server, the pipe and the host in CI on
// both operating systems, driving our stdio directly. The gap it cannot close
// is the one thing this covers: whether the CLI, given the config OUR adapter
// writes, actually launches the thing and merges it with what the user has.
//
// ── WHAT IT ASSERTS, AND WHY EACH ONE ──────────────────────────────────────
//
//   1. BASELINE: what MCP servers does a plain session see? Captured first,
//      because "the user's servers survived" is meaningless without knowing
//      what they were. A machine with none is reported, not failed — that is a
//      legitimate configuration, and the merge claim simply cannot be tested
//      there. Saying so beats a green tick that measured nothing.
//   2. OUR SERVER IS CONNECTED, with our `serverInfo` and our tool names. That
//      one row proves the CLI spawned the process, completed `initialize`, and
//      called `tools/list` — the whole chain, for free (#760).
//   3. THE MERGE: every baseline server is STILL THERE alongside ours. This is
//      the assertion the item exists for. `--strict-mcp-config` would evict
//      them all, measured, which is why we never pass it.
//   4. THE FLAG IS ABSENT from the argv we actually built.
//
// ⚠️ POLLS, and does not sample once. #729 measured this exact call answering
// `pending` with no tools at 0.9 s and `connected` with 3 tools at 5.0 s. And
// it does not write at t=0: #760 lost two full runs to a control request sent
// the instant `spawn()` returned, which read as "the CLI never answers".
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BusHost } from './host-channel';
import { BUS_SERVER_NAME } from './bus-paths';
import { claudeAdapter } from '../providers/claude';
import { execSpec } from '../transport/win-cmd';
import type { Logger } from '../log/logger';
import type { QueryResult, SessionSummary } from '../sessions/queries';

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures.push(label);
  console.log(`[mcp-attach] ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}
function note(msg: string): void {
  console.log(`[mcp-attach]      ${msg}`);
}

const log = {
  debug: () => {},
  info: (m: string, f?: unknown) => console.log(`[mcp-attach]      ${m}`, f ?? ''),
  warn: (m: string, f?: unknown) => console.log(`[mcp-attach] warn ${m}`, f ?? ''),
  error: (m: string, f?: unknown) => console.log(`[mcp-attach] ERR  ${m}`, f ?? ''),
  child: () => log,
} as unknown as Logger;

const SESSIONS: SessionSummary[] = [
  { id: 'sb-self', name: 'Switchboard', folder: '/p/switchboard', providerId: 'claude-code', status: 'working', exited: false },
  { id: 'sb-other', name: 'PropaneMon', folder: '/p/propanemon', providerId: 'claude-code', status: 'idle', exited: false },
];

interface StatusRow {
  name: string;
  status?: string;
  scope?: string;
  serverInfo?: unknown;
  tools?: (string | { name?: string })[];
}

const spawned: ChildProcess[] = [];

/**
 * Kill a child AND EVERYTHING UNDER IT.
 *
 * `child.kill()` alone is wrong here on Windows and review caught it: `execSpec`
 * wraps the CLI in `cmd /d /s /v:off /c`, so the handle we hold is cmd.exe's.
 * Killing it leaves the real `claude` process running, and with it the Electron
 * bus server the CLI spawned as ITS child — two orphans per session, two
 * sessions per run. The e2e harness learned the same lesson (`taskkill /T /F`).
 */
function killTree(c: ChildProcess): void {
  try {
    if (process.platform === 'win32' && c.pid !== undefined) {
      spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      c.kill();
    }
  } catch {
    /* already gone */
  }
}

function killSpawned(): void {
  for (const c of spawned) killTree(c);
}

/**
 * Spawn a stream session and poll `mcp_status` until `until` is satisfied.
 *
 * Deliberately goes through `claudeAdapter.buildSpawn` rather than composing
 * argv here: the thing under test is OUR spawn path, and a check that built its
 * own arguments would pass just as happily against an adapter that had stopped
 * writing the flag entirely.
 */
function statusFor(
  args: { mcpConfig?: Record<string, unknown> },
  cwd: string,
  stateDir: string,
  sessionId: string,
  until: (rows: StatusRow[]) => boolean
): Promise<{ rows: StatusRow[] | null; argv: string[] }> {
  const recipe = claudeAdapter.buildSpawn({
    cwd,
    sessionId,
    stateDir,
    transport: 'stream',
    mcpConfig: args.mcpConfig,
  });
  // THROUGH `execSpec`, not `spawn(recipe.command, …)` directly. On Windows the
  // CLI resolves to `claude.cmd`, and since the CVE-2024-27980 fix Node refuses
  // to spawn a `.cmd` at all — `spawn EINVAL`, which is exactly what the first
  // version of this check died on. `execSpec` is the app's own answer (#714) and
  // using it here means the check spawns the CLI the same way a real session
  // does, rather than a second way that could drift.
  const spec = execSpec(recipe.command, recipe.args);
  const child = spawn(spec.file, spec.argv, {
    cwd,
    env: { ...process.env, ...recipe.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  spawned.push(child);

  return new Promise((resolve) => {
    let buf = '';
    let latest: StatusRow[] | null = null;
    let done = false;
    let n = 0;
    const send = (): void => {
      child.stdin?.write(
        JSON.stringify({
          type: 'control_request',
          request_id: `sb763-${++n}`,
          request: { subtype: 'mcp_status' },
        }) + '\n'
      );
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(first);
      clearTimeout(cap);
      killTree(child);
      resolve({ rows: latest, argv: recipe.args });
    };
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // `continue`, never `return` — one unparseable line must
          // not abandon the rest of the chunk.
        }
        if (m.type !== 'control_response') continue;
        const r = (m.response ?? {}) as Record<string, unknown>;
        // ⚠️ DOUBLY NESTED: `m.response.response.mcpServers`. A reader that
        // stops one level too early matches nothing, for ever, and looks
        // exactly like a CLI that never answered (#721 finding 1).
        const inner = (r.response ?? {}) as Record<string, unknown>;
        const servers = (inner.mcpServers ?? r.mcpServers) as StatusRow[] | undefined;
        if (!servers) continue;
        latest = servers;
        if (until(servers)) finish();
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => process.stderr.write(d));
    // NOT at t=0 — see the header.
    const first = setTimeout(send, 800);
    const timer = setInterval(send, 1500);
    const cap = setTimeout(finish, 30_000);
  });
}

const names = (rows: StatusRow[] | null): string[] => (rows ?? []).map((r) => r.name);
const toolNames = (r: StatusRow): string[] =>
  (r.tools ?? []).map((t) => (typeof t === 'string' ? t : (t.name ?? '')));

async function main(): Promise<void> {
  // ── THE REPO, NOT A TEMP DIR, AND THAT IS THE WHOLE MERGE TEST ────────────
  //
  // The first version ran in `mkdtemp` and reported "no baseline servers" on a
  // machine that demonstrably has one: MCP `local` scope is PER PROJECT, and a
  // `.mcp.json` is per repo, so a session started in an empty temp directory
  // sees neither. It was not measuring the merge at all — it was measuring an
  // empty set against an empty set and printing a tick.
  //
  // Safe, despite "a cwd is not a sandbox" (#760's probe enumerated the whole
  // machine from a temp dir under `bypassPermissions`, so the temp dir was
  // never the protection anyway). What makes this safe is different and
  // stronger: NO PROMPT IS EVER SENT and no model turn ever happens. The only
  // thing written to stdin is a `mcp_status` control request, and the child is
  // killed the moment it answers. Nothing can call a tool because nothing ever
  // asks it to.
  const cwd = process.cwd();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-attach-state-'));
  const host = new BusHost({
    stateDir,
    log,
    queries: {
      listSessions: (): QueryResult<SessionSummary[]> => ({ ok: true, value: SESSIONS }),
      // This script never calls a tool — it only proves the CLI LISTS our
      // server beside the user's own (`mcp_status` is free; a tool call needs a
      // model turn). The two read tools exist here to satisfy `BusQueries` and
      // refuse if anything ever does reach them, which would be a bug in this
      // script rather than a condition to answer.
      sessionOutput: () => ({ ok: false, reason: 'mcp-attach-check answers no reads' }),
      sessionDiff: () => Promise.resolve({ ok: false, reason: 'mcp-attach-check answers no reads' }),
    },
    // Same reasoning, for the one tool that writes (#765): refusing, so a call
    // that somehow got here could not be mistaken for a delivery.
    delivery: { send: () => Promise.resolve({ ok: false, reason: 'mcp-attach-check sends nothing' }) },
  });

  try {
    // ── 1. baseline ───────────────────────────────────────────────────────
    note('baseline: spawning a session with NO --mcp-config…');
    const base = await statusFor({}, cwd, stateDir, 'sb-baseline', (rows) =>
      rows.every((r) => r.status !== 'pending')
    );
    // ⚠️ `null` AND `[]` ARE DIFFERENT FACTS, and conflating them let this
    // script print PASS while measuring nothing (review of #763). `null` means
    // the CLI never answered inside the 30 s cap — a broken run — while `[]`
    // means a machine with no MCP servers configured, which is legitimate. The
    // old code treated both as "(none configured)", skipped the merge assertion,
    // and exited 0.
    check('the baseline session answered mcp_status at all', base.rows !== null,
      base.rows === null ? 'no control_response inside 30s — is the CLI logged in?' : '');
    const baseline = names(base.rows);
    note(`baseline servers: ${baseline.length ? baseline.join(', ') : '(none configured)'}`);
    check('a baseline session carries no switchboard server', !baseline.includes(BUS_SERVER_NAME));
    check('the baseline argv has no --mcp-config', !base.argv.includes('--mcp-config'));

    // ── 2 & 3. attached ───────────────────────────────────────────────────
    const sessionId = 'sb-attach-check';
    const launch = host.attachSession(sessionId);
    if (!launch) {
      check('the bus attached at all', false, 'run `npm run build` first — no compiled bus-server.js');
      return;
    }
    const mcpConfig = claudeAdapter.capabilities!.mcp!.configFor(sessionId, {
      // Already attached above — hand the capability the launch we got rather
      // than opening a second endpoint for the same session.
      attachSession: () => launch,
      releaseSession: (id) => host.releaseSession(id),
    })!;
    note('attached: spawning a session WITH our --mcp-config…');
    const att = await statusFor({ mcpConfig }, cwd, stateDir, sessionId, (rows) => {
      const ours = rows.find((r) => r.name === BUS_SERVER_NAME);
      return !!ours && ours.status === 'connected' && toolNames(ours).length > 0;
    });

    const ours = (att.rows ?? []).find((r) => r.name === BUS_SERVER_NAME);
    check('our server is present at all', !!ours, `saw: ${names(att.rows).join(', ') || '(none)'}`);
    check('…and CONNECTED', ours?.status === 'connected', `status: ${ours?.status ?? 'absent'}`);
    check('…carrying our serverInfo', !!ours?.serverInfo, JSON.stringify(ours?.serverInfo ?? null));
    check('…and listing our tools', toolNames(ours ?? { name: '' }).length > 0, toolNames(ours ?? { name: '' }).join(', '));
    // The scope the MCP manager will show it under (§5.17). Reported rather
    // than asserted: it is the CLI's word, and #763 decided to SHOW the row
    // rather than filter it, so a change here is a UI question, not a failure.
    note(`scope reported by the CLI: ${ours?.scope ?? '(none)'}`);

    // ── THE MERGE — the assertion this whole item turns on ────────────────
    if (base.rows !== null && baseline.length === 0) {
      note('⚠️ NO baseline servers on this machine, so the MERGE claim — the one');
      note('   this whole item turns on — was NOT exercised by this run.');
      note('   Configure one (`claude mcp add …`) in this repo and re-run.');
      note('   NOTE: MCP `local` scope is PER PROJECT, so run this from the repo.');
    } else if (base.rows !== null) {
      const after = names(att.rows);
      const lost = baseline.filter((b) => !after.includes(b));
      check(
        "the user's own servers SURVIVED the attach",
        lost.length === 0,
        lost.length ? `LOST: ${lost.join(', ')}` : `kept all ${baseline.length}`
      );
    }

    // ── 4. the flag, in the argv we really built ──────────────────────────
    check('--mcp-config was passed', att.argv.includes('--mcp-config'));
    check('--strict-mcp-config was NOT passed', !att.argv.includes('--strict-mcp-config'));
  } finally {
    killSpawned();
    host.stop();
    // BEST-EFFORT. `kill()` signals; it does not wait, and on Windows a child
    // that still holds the directory makes this EPERM — which used to throw out
    // of the `finally` and replace a completed run's verdict with a housekeeping
    // failure. The temp dir is the OS's problem after that.
    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* the child has not let go yet; not this check's verdict */
    }
  }
}

main()
  .then(() => {
    console.log(failures.length ? `\n[mcp-attach] FAILED: ${failures.join('; ')}` : '\n[mcp-attach] PASS');
    process.exit(failures.length ? 1 : 0);
  })
  .catch((err) => {
    console.error('[mcp-attach] threw:', err);
    killSpawned();
    process.exit(1);
  });
