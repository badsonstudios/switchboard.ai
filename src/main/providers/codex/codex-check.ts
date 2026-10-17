// `npm run check:codex` (E40 item 07, #1290): ONE real Codex turn and ONE
// resume, through the real `SessionManager`, the real `StreamService` and the
// real `codexAdapter` — the path the app takes, minus the window. Exits 0 on
// PASS, 1 on FAIL.
//
// ⚠️ LOCAL-ONLY, AND IT SPENDS REAL TOKENS on whatever ChatGPT account
// `~/.codex` is logged into (#182: `check-scripts.test.ts` `LOCAL_ONLY`). Two
// model turns, both on the cheapest model measured (`gpt-6-luna`, effort
// `low`), both one-word replies. It never signs in: logged out (or unknown) it
// FAILS before starting a session, because a session would run Codex's browser
// sign-in, which is a person's to do, not a script's.
//
// SAFETY, in the order it is enforced:
//   - the session runs in a fresh temp folder, never a project;
//   - every permission Codex asks is DENIED (a one-word reply needs none);
//   - the sessions it leaves in Codex's own history are deleted with
//     `codex delete --force <id>` — ONLY rollouts that are new since the start
//     AND whose recorded cwd is this run's temp folder, so a session the user
//     started meanwhile is never touched;
//   - every child goes through `StreamSession`'s stdin-EOF-then-tree-kill.
//
// THE AI SWITCH (E40 item 11, #1294), OPT-IN: `CHECK_CODEX_SWITCH=1` adds
// Claude -> Codex -> Claude on ONE card, decided by the app's own
// `switchCardAi` + `planSessionStart`: a Claude turn (haiku), a switch to Codex
// (one fresh Codex turn), a switch back (one Claude turn, which must RESUME the
// first Claude conversation and remember it). That is two Claude turns and one
// Codex turn beyond the default run, which is why it is behind a flag. Its
// Claude transcripts are written under this run's temp folder's slug in
// `~/.claude/projects`, and that one directory is removed afterwards.
//
// Run with: npm run check:codex   (after npm run build)
//      or: CHECK_CODEX_SWITCH=1 npm run check:codex
import { errorText } from '../../../shared/error-text';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ContributionRegistry } from '../../../shared/extensibility/registry';
import type { MainContributions, McpAttachmentHost } from '../../extensibility/contributions';
import { DISPLAY_CAPS } from '../../feed/blocks';
import { LogSink, createLogger } from '../../log/logger';
import type { EngineEvent } from '../../sessions/engine-events';
import { SessionManager } from '../../sessions/session-manager';
import { buildEnv } from '../../transport/env';
import { StreamService, launchSpec } from '../../transport/stream-service';
import { codexInstalled, codexLoginState, codexVersion, npxPath } from './codex-detect';
import { createLimitsReader } from './codex-limits';
import { CODEX_PROVIDER_ID, codexAdapter } from './codex-provider';
import { claudeAdapter } from '../claude';
import { switchCardAi } from '../../sessions/ai-switch';
import { planSessionStart } from '../../sessions/start-plan';
import { slugForCwd } from '../../transcripts/paths';
import type { PersistedSession } from '../../workspace/store';

const TAG = '[codex-check]';
const MODEL = 'gpt-6-luna';
const EFFORT = 'low';
const PROMPT_1 = 'Reply with the single word pong.';
const PROMPT_2 = 'What single word did you reply with in your previous message? Reply with that word only.';
const SWITCH = process.env.CHECK_CODEX_SWITCH === '1';
const CLAUDE_MODEL = 'haiku';
const SWITCH_PROMPT_1 = 'Reply with the single word ping.';
const SWITCH_PROMPT_CODEX = 'Reply with the single word pong.';
const SWITCH_PROMPT_2 =
  'What single word did you reply with in your FIRST message of this conversation? Reply with that word only.';
const OPEN_MS = 240_000; // a cold `npx -y` installs the adapter first
const TURN_MS = 150_000;
/**
 * A backstop only: every wait above is bounded, and their sum is below this.
 * If it ever fires, the exit SKIPS the clean-up (the run is wedged): this run's
 * temp folder and its rollouts in `~/.codex/sessions` are left, and the line
 * printed says so. Delete them with `codex delete --force <id>`.
 */
const OVERALL_MS = 20 * 60_000;

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures.push(label);
  console.log(`${TAG} ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}
const say = (s: string): void => console.log(`${TAG} ${s}`);

function until(pred: () => boolean, ms: number, what: string): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (pred()) return resolve(true);
      if (Date.now() - t0 > ms) {
        say(`timed out waiting for ${what}`);
        return resolve(false);
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const { file, argv } = launchSpec(command, args);
    execFile(file, argv, { timeout: timeoutMs, windowsHide: true, env: buildEnv(process.env) }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: `${String(stdout)}${String(stderr)}`.trim() })
    );
  });
}

/** Codex's history: `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-*.jsonl`. */
function codexSessionsDir(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

function rollouts(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(full);
    }
  };
  walk(codexSessionsDir());
  return out;
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** The rollout's recorded cwd (its first line is `session_meta`), or null. */
function rolloutCwd(file: string): string | null {
  try {
    const first = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10), 1)[0];
    const meta = JSON.parse(first) as { payload?: { cwd?: unknown }; cwd?: unknown };
    const cwd = meta.payload?.cwd ?? meta.cwd;
    return typeof cwd === 'string' ? cwd : null;
  } catch {
    return null;
  }
}

const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function textsOf(events: EngineEvent[], kind: 'user' | 'assistant'): string[] {
  const out: string[] = [];
  for (const ev of events) {
    if (ev.type !== 'message') continue;
    for (const b of ev.derive(DISPLAY_CAPS, {})) {
      if (b.t === 'block' && b.block.kind === kind) out.push(b.block.text ?? '');
    }
  }
  return out;
}

async function main(): Promise<number> {
  // ── preconditions: no session is started unless all of these hold ─────────
  const npx = npxPath();
  const cli = codexInstalled();
  check('npx is on PATH (it runs the ACP adapter)', npx !== null, npx ?? 'not found');
  check('the codex CLI is on PATH (limits, login state, clean-up)', cli !== null, cli ?? 'not found');
  if (!npx || !cli) return 1;
  say(`installed codex CLI: ${(await codexVersion(cli)) ?? 'unknown version'} (the adapter runs its own bundled Codex)`);
  const login = await codexLoginState(cli);
  check('Codex is logged in (this check never signs in)', login.state === 'logged-in', login.state);
  if (login.state !== 'logged-in') return 1;
  say(`plan: ${login.plan ?? 'not given'}`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-codex-check-'));
  const rolloutsBefore = new Set(rollouts());
  say(`work folder: ${work}`);
  say(`codex sessions before: ${rolloutsBefore.size}`);

  const registry = new ContributionRegistry<MainContributions>();
  registry.register('provider-adapter', codexAdapter);
  if (SWITCH) registry.register('provider-adapter', claudeAdapter);
  const streams = new StreamService({
    onDiagnostic: (d) => {
      if (d.kind !== 'stderr') say(`diag ${d.kind}: ${d.detail.slice(0, 200)}`);
    },
  });
  const m = new SessionManager(registry, streams, createLogger(new LogSink({ dir: work }), 'sessions'), work);

  const events: Array<{ sessionId: string; ev: EngineEvent }> = [];
  let permissionsAsked = 0;
  m.onEngineEvent((sessionId, ev) => {
    events.push({ sessionId, ev });
    if (ev.type === 'permission-request') {
      permissionsAsked += 1;
      say(`Codex asked permission for "${ev.tool}" — denied (this check needs none)`);
      m.answerPermission(sessionId, ev.requestId, { behavior: 'deny', message: 'not in this check' });
    }
  });
  const exited = new Set<string>();
  m.onSessionExit((e) => exited.add(e.sessionId));
  const of = (sid: string): EngineEvent[] => events.filter((e) => e.sessionId === sid).map((e) => e.ev);
  const ofType = <T extends EngineEvent['type']>(sid: string, t: T) =>
    of(sid).filter((e): e is Extract<EngineEvent, { type: T }> => e.type === t);

  // The Session Bus path, with a stand-in server: the provider's REAL `mcp`
  // capability builds the `mcpServers` entry, and the stub logs that Codex
  // launched it and listed its tools. No tool is ever called (no extra turn).
  const stub = path.join(process.cwd(), 'spike', 'probes', '1285', 'mcp-stub.mjs');
  const stubLog = path.join(work, 'mcp-stub.log');
  const host: McpAttachmentHost = {
    attachSession: () =>
      fs.existsSync(stub)
        ? { command: process.execPath, args: [stub], env: { ELECTRON_RUN_AS_NODE: '1', STUB_LOG: stubLog } }
        : null,
    releaseSession: () => {},
  };
  const mcpConfigFor = (sid: string) => codexAdapter.capabilities?.mcp?.configFor(sid, host) ?? undefined;
  const identity = { title: 'codex-check', folder: work, providerId: CODEX_PROVIDER_ID };
  let turns = 0;
  const sessionIds: string[] = [];

  try {
    // ── session 1: open, set the cheap model, one turn ───────────────────────
    const s1 = m.create(identity, { autonomy: 'ask', mcpConfigFor }).id;
    sessionIds.push(s1);
    const opened = await until(() => ofType(s1, 'conversation').length > 0, OPEN_MS, 'session 1 to open');
    check('session 1 opened (initialize, session/new)', opened);
    if (!opened) return 1;
    const conversation = ofType(s1, 'conversation')[0].id;
    say(`conversation: ${conversation}`);
    // (the set waits for the session to be ready, which is after the mode the
    // card asked for has been applied)
    const model = await m.setModel(s1, MODEL);
    check(`model set to ${MODEL}`, model.ok, model.ok ? '' : JSON.stringify(model));
    check(
      'the card mode was applied and reads back as ask (workspace-write, never agent)',
      ofType(s1, 'mode').at(-1)?.mode === 'ask',
      JSON.stringify(ofType(s1, 'mode'))
    );
    const effort = await m.setEffort(s1, EFFORT);
    check(`effort set to ${EFFORT}`, effort.ok, effort.ok ? '' : JSON.stringify(effort));
    const controls = m.controlsOf(s1);
    say(`declared controls: ${controls ? `${controls.ai}: ${controls.has.join(', ')}` : 'none'}`);

    turns += 1;
    check('turn 1 sent', m.submitPrompt(s1, PROMPT_1));
    const t1 = await until(() => ofType(s1, 'turn-end').length > 0, TURN_MS, 'turn 1 to end');
    const end1 = ofType(s1, 'turn-end')[0];
    check('turn 1 ended, not failed', t1 && end1?.failed === false, end1?.label ?? 'no turn end');
    const reply1 = textsOf(of(s1), 'assistant').join(' ');
    say(`turn 1 reply: ${JSON.stringify(reply1.slice(0, 200))}`);
    check('turn 1 says pong', /pong/i.test(reply1));
    check('the prompt is drawn as the user turn', textsOf(of(s1), 'user').includes(PROMPT_1));
    const usage1 = ofType(s1, 'usage');
    say(`turn 1 usage: ${JSON.stringify(usage1)}`);
    check('turn 1 reported token usage', usage1.some((u) => (u.inputTokens ?? 0) + (u.outputTokens ?? 0) > 0));
    // the plan windows, through the ENGINE (read at ready and after the turn,
    // looped back as a token-free usage event) — the path the status bar reads
    await until(() => ofType(s1, 'usage').some((u) => (u.limits?.length ?? 0) >= 2), 20_000, 'the limits event');
    const limitEvents = ofType(s1, 'usage').filter((u) => u.limits);
    check('the engine sent the 5-hour and weekly windows as a usage event', limitEvents.some((u) => (u.limits?.length ?? 0) >= 2));
    check(
      'that event carries no tokens',
      limitEvents.every((u) => u.inputTokens === undefined && u.outputTokens === undefined)
    );
    check('turn 1 named its model on the usage event', usage1.some((u) => u.model === MODEL), usage1.map((u) => u.model).join(','));
    const ctx = await m.contextUsage(s1);
    say(`context meter: ${JSON.stringify(ctx)}`);
    check('the context meter has an answer', ctx.ok);

    let stubLines = '';
    try {
      stubLines = fs.readFileSync(stubLog, 'utf8');
    } catch {
      /* not launched */
    }
    if (fs.existsSync(stub)) {
      check('Codex launched the mcpServers entry and listed its tools', stubLines.includes('"tools/list"'));
    } else {
      say(`(no MCP stub at ${stub}; run from the repo root to check the Session Bus path)`);
    }

    m.remove(s1);
    check('session 1 closed', await until(() => exited.has(s1), 15_000, 'session 1 to exit'));

    // ── session 2: resume the same conversation, one turn ────────────────────
    const s2 = m.create(identity, { autonomy: 'ask', resumeSessionId: conversation, mcpConfigFor }).id;
    sessionIds.push(s2);
    const reopened = await until(() => ofType(s2, 'conversation').length > 0, OPEN_MS, 'session 2 to load');
    check('session 2 opened', reopened);
    if (!reopened) return 1;
    check(
      'session 2 is the SAME conversation (session/load, not a new one)',
      ofType(s2, 'conversation')[0].id === conversation,
      ofType(s2, 'conversation')[0].id
    );
    check('the load replayed turn 1', textsOf(of(s2), 'user').includes(PROMPT_1));
    check('the model was re-applied after the load', ofType(s2, 'model').at(-1)?.id === MODEL, ofType(s2, 'model').at(-1)?.id);

    turns += 1;
    const before = textsOf(of(s2), 'assistant').length;
    check('turn 2 sent', m.submitPrompt(s2, PROMPT_2));
    const t2 = await until(() => ofType(s2, 'turn-end').length > 0, TURN_MS, 'turn 2 to end');
    const end2 = ofType(s2, 'turn-end')[0];
    check('turn 2 ended, not failed', t2 && end2?.failed === false, end2?.label ?? 'no turn end');
    const reply2 = textsOf(of(s2), 'assistant').slice(before).join(' ');
    say(`turn 2 reply: ${JSON.stringify(reply2.slice(0, 200))}`);
    check('turn 2 remembers turn 1 (pong)', /pong/i.test(reply2));
    const usage2 = ofType(s2, 'usage');
    say(`turn 2 usage: ${JSON.stringify(usage2)}`);
    check('turn 2 reported token usage', usage2.some((u) => (u.inputTokens ?? 0) + (u.outputTokens ?? 0) > 0));
    m.remove(s2);
    check('session 2 closed', await until(() => exited.has(s2), 15_000, 'session 2 to exit'));

    // ── the AI switch, Claude -> Codex -> Claude (#1294), opt-in ─────────────
    if (SWITCH) {
      const nameOf = (id: string): string => registry.resolve('provider-adapter', id)?.manifest.displayName ?? id;
      const planFor = (c: PersistedSession) =>
        planSessionStart(
          {
            capabilitiesOf: (id) => registry.resolve('provider-adapter', id)?.capabilities,
            isRegistered: (id) => !!registry.resolve('provider-adapter', id),
            defaultProviderId: () => 'claude-code',
            folder: work,
            prior: { providerId: c.identity.providerId, nativeSessionId: c.nativeSessionId, nativeSessionLineage: c.nativeSessionLineage },
            claimedNativeIds: () => [],
          },
          { buildHookSettings: () => ({}), releaseHookSettings: () => {} }
        );
      const turn = async (sid: string, prompt: string, what: string): Promise<string> => {
        turns += 1;
        const ends = ofType(sid, 'turn-end').length;
        const said = textsOf(of(sid), 'assistant').length;
        check(`${what} sent`, m.submitPrompt(sid, prompt));
        const done = await until(() => ofType(sid, 'turn-end').length > ends, TURN_MS, `${what} to end`);
        const end = ofType(sid, 'turn-end')[ends];
        check(`${what} ended, not failed`, done && end?.failed === false, end?.label ?? 'no turn end');
        const reply = textsOf(of(sid), 'assistant').slice(said).join(' ');
        say(`${what} reply: ${JSON.stringify(reply.slice(0, 200))}`);
        say(`${what} usage: ${JSON.stringify(ofType(sid, 'usage').slice(-2))}`);
        return reply;
      };
      const claudeParty = { providerId: 'claude-code', name: nameOf('claude-code') };
      const codexParty = { providerId: CODEX_PROVIDER_ID, name: nameOf(CODEX_PROVIDER_ID) };
      let c: PersistedSession = {
        id: 'switch-card',
        identity: { title: 'codex-check switch', folder: work, providerId: 'claude-code' },
        layoutSlot: 0,
        suspendedAt: '',
      };
      // 1. Claude, fresh
      const p1 = planFor(c);
      check('switch: the card starts on Claude, fresh', p1.providerId === 'claude-code' && !p1.resumeSessionId);
      const a1 = m.create(c.identity, { autonomy: 'ask', transport: 'stream' }).id;
      sessionIds.push(a1);
      const cm1 = await m.setModel(a1, CLAUDE_MODEL);
      check(`switch: Claude model set to ${CLAUDE_MODEL}`, cm1.ok, cm1.ok ? '' : JSON.stringify(cm1));
      const r1 = await turn(a1, SWITCH_PROMPT_1, 'switch: Claude turn 1');
      check('switch: Claude says ping', /ping/i.test(r1));
      const claudeId = ofType(a1, 'conversation').at(-1)?.id;
      check('switch: Claude named its conversation', !!claudeId, claudeId ?? 'none');
      if (!claudeId) return 1;
      c = { ...c, nativeSessionId: claudeId };
      m.remove(a1);
      await until(() => exited.has(a1), 15_000, 'Claude session 1 to exit');

      // 2. to Codex: Claude's conversation parked, Codex fresh
      c = switchCardAi(c, claudeParty, codexParty, new Date().toISOString(), 'switch-1');
      check('switch: the Claude conversation is parked on the card', c.conversations?.['claude-code']?.nativeSessionId === claudeId);
      const p2 = planFor(c);
      check('switch: the first switch to Codex starts FRESH', p2.providerId === CODEX_PROVIDER_ID && !p2.resumeSessionId);
      const x1 = m.create(c.identity, { autonomy: 'ask', mcpConfigFor }).id;
      sessionIds.push(x1);
      check('switch: the Codex session opened', await until(() => ofType(x1, 'conversation').length > 0, OPEN_MS, 'the switched Codex session to open'));
      await m.setModel(x1, MODEL);
      await m.setEffort(x1, EFFORT);
      const rx = await turn(x1, SWITCH_PROMPT_CODEX, 'switch: Codex turn');
      check('switch: Codex says pong', /pong/i.test(rx));
      c = { ...c, nativeSessionId: ofType(x1, 'conversation').at(-1)?.id };
      m.remove(x1);
      await until(() => exited.has(x1), 15_000, 'the switched Codex session to exit');

      // 3. back: Claude RESUMES its own conversation
      c = switchCardAi(c, codexParty, claudeParty, new Date().toISOString(), 'switch-2');
      const p3 = planFor(c);
      check(
        'switch: switching back RESUMES the original Claude conversation',
        p3.providerId === 'claude-code' && p3.resumeSessionId === claudeId,
        p3.resumeSessionId ?? 'fresh'
      );
      const a2 = m.create(c.identity, { autonomy: 'ask', transport: 'stream', resumeSessionId: p3.resumeSessionId }).id;
      sessionIds.push(a2);
      await m.setModel(a2, CLAUDE_MODEL);
      const r2 = await turn(a2, SWITCH_PROMPT_2, 'switch: Claude turn 2');
      check('switch: the resumed Claude remembers its first reply (ping)', /ping/i.test(r2));
      check(
        'switch: in the SAME conversation',
        ofType(a2, 'conversation').at(-1)?.id === claudeId,
        ofType(a2, 'conversation').at(-1)?.id
      );
      m.remove(a2);
      await until(() => exited.has(a2), 15_000, 'Claude session 2 to exit');
    }

    // ── the plan limits, from the app-server reader ──────────────────────────
    const limits = await createLimitsReader({ log: say })();
    say(`limits: ${JSON.stringify(limits)}`);
    check('the 5-hour and weekly windows were read', (limits?.length ?? 0) >= 2);

    // what the event stream carried, by type
    const counts: Record<string, number> = {};
    for (const { ev } of events) counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    say(`events seen: ${JSON.stringify(counts)}`);
    say(`permissions asked: ${permissionsAsked}`);
    return failures.length ? 1 : 0;
  } finally {
    for (const sid of sessionIds) if (m.get(sid)) m.remove(sid);
    await until(() => sessionIds.every((sid) => exited.has(sid)), 15_000, 'every session to exit');
    say(`model turns sent: ${turns}`);
    // ── clean up Codex's history: only what THIS run made ────────────────────
    const fresh = rollouts().filter((f) => !rolloutsBefore.has(f));
    let deleted = 0;
    let ours = 0;
    for (const f of fresh) {
      const cwd = rolloutCwd(f);
      const id = UUID.exec(f)?.[1];
      if (!id || !cwd || !samePath(cwd, work)) {
        say(`left alone (not this run's): ${path.basename(f)}`);
        continue;
      }
      ours += 1;
      const r = await run(cli, ['delete', '--force', id], 30_000);
      if (r.ok) deleted += 1;
      else say(`codex delete ${id} failed: ${r.out.slice(0, 200)}`);
    }
    const after = rollouts().length;
    say(`codex sessions: before ${rolloutsBefore.size}, new ${fresh.length}, this run's ${ours}, deleted ${deleted}, after ${after}`);
    check('the sessions this run made were deleted', ours === deleted);
    if (SWITCH) {
      // this run's Claude transcripts: the temp folder's own slug, nothing else
      const mine = path.join(os.homedir(), '.claude', 'projects', slugForCwd(work));
      try {
        fs.rmSync(mine, { recursive: true, force: true });
        say(`removed this run's Claude transcripts: ${mine}`);
      } catch (err) {
        say(`Claude transcripts not removed (${mine}): ${errorText(err)}`);
      }
    }
    try {
      fs.rmSync(work, { recursive: true, force: true });
    } catch (err) {
      say(`work folder not removed: ${errorText(err)}`);
    }
  }
}

const overall = setTimeout(() => {
  console.log(`${TAG} FAIL overall deadline (${OVERALL_MS / 60_000} min); clean-up SKIPPED, see the header`);
  process.exit(1);
}, OVERALL_MS);
main()
  .then((code) => {
    clearTimeout(overall);
    console.log(`${TAG} ${code === 0 && failures.length === 0 ? 'PASS' : `FAIL (${failures.join('; ')})`}`);
    process.exit(code === 0 && failures.length === 0 ? 0 : 1);
  })
  .catch((err: unknown) => {
    clearTimeout(overall);
    console.log(`${TAG} FAIL ${err instanceof Error && err.stack ? err.stack : errorText(err)}`);
    process.exit(1);
  });
