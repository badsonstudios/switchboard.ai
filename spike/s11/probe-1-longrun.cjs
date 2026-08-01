// S-11 probe 1 — LONG-RUN STABILITY of the duplex stream-json transport.
//
// Every S-09/S-10 probe was a SINGLE TURN. The product is 8 sessions holding
// open pipes for 8 hours. A PTY is a well-understood long-lived object; an
// NDJSON pipe with a control channel is not, and unhandled stdout backpressure
// deadlocks a busy session — the #112/#117 class of bug.
//
// Four questions, in order of how much they would hurt:
//   Q1 BACKPRESSURE. If we stop draining stdout, does the CLI block, die, drop
//      messages, or wedge permanently? Does it recover when we resume? Does a
//      user message sent DURING the stall get processed after it? This is the
//      deadlock, and it is the reason this probe runs first.
//   Q2 SURVIVAL. Does the process stay alive across hours of idle? What is the
//      keep_alive cadence, and does anything time it out?
//   Q3 DRIFT. Does the child's memory grow? Does ours? Does turn latency?
//   Q4 CONTEXT COST. Each turn resends the conversation. Does an 8-hour session
//      get expensive, hit a limit, or auto-compact? `result.usage` per turn.
//
// Token spend is deliberately small: ~25 one-word heartbeat turns plus ONE
// deliberately chatty turn to fill the pipe for Q1.
//
// Writes findings as it goes — the summary JSON is rewritten every sample, so
// it is readable mid-run and survives a kill:
//   spike/findings/artifacts/s11/longrun-summary.json
//   spike/findings/artifacts/s11/longrun-events.ndjson
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const num = (k, d) => (process.env[k] ? Number(process.env[k]) : d);
const DURATION_MS = num('S11_DURATION_MS', 8 * 60 * 60_000);
const HEARTBEAT_MS = num('S11_HEARTBEAT_MS', 20 * 60_000);
const SAMPLE_MS = num('S11_SAMPLE_MS', 5 * 60_000);
const BACKPRESSURE_AT_MS = num('S11_BACKPRESSURE_AT_MS', 3 * 60_000);
const PAUSE_MS = num('S11_PAUSE_MS', 120_000);
const EVENT_LOG_CAP = num('S11_EVENT_CAP', 20 * 1024 * 1024);

const OUT = process.env.S11_OUT || path.join(__dirname, '..', 'findings', 'artifacts', 's11');
fs.mkdirSync(OUT, { recursive: true });
const eventPath = path.join(OUT, 'longrun-events.ndjson');
const summaryPath = path.join(OUT, 'longrun-summary.json');
const events = fs.createWriteStream(eventPath, { flags: 'a' });

const START = Date.now();
let eventBytes = 0;
let eventLogFull = false;

function rec(kind, data) {
  const line = JSON.stringify({ t: Date.now(), ms: Date.now() - START, kind, ...data }) + '\n';
  if (eventLogFull) return;
  if (eventBytes + line.length > EVENT_LOG_CAP) {
    eventLogFull = true;
    events.write(JSON.stringify({ t: Date.now(), kind: 'event-log-capped', cap: EVENT_LOG_CAP }) + '\n');
    return;
  }
  eventBytes += line.length;
  events.write(line);
}

// ---------------------------------------------------------------- the session
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-s11-longrun-'));
fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
fs.writeFileSync(path.join(work, '.claude', 'settings.json'), '{}');

const cli = process.env.SB_CLAUDE || 'claude.cmd';
const args = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--permission-prompt-tool', 'stdio',
];
const isCmd = process.platform === 'win32' && cli.toLowerCase().endsWith('.cmd');
const proc = spawn(isCmd ? 'cmd.exe' : cli, isCmd ? ['/c', cli, ...args] : args, {
  cwd: work,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  env: { ...process.env },
});

const S = {
  probe: 's-11 probe 1 — long-run stability',
  startedAt: new Date(START).toISOString(),
  cwd: work,
  pid: proc.pid,
  cli,
  config: { DURATION_MS, HEARTBEAT_MS, SAMPLE_MS, BACKPRESSURE_AT_MS, PAUSE_MS },
  init: null,
  alive: true,
  exit: null,
  stdoutBytes: 0,
  stdoutLines: 0,
  parseFailures: 0,          // a torn/garbled line would land here — framing integrity
  typeCounts: {},
  keepAlives: { count: 0, firstMs: null, lastMs: null, gapsMs: [] },
  turns: [],                 // { n, sentMs, firstDeltaMs, resultMs, latencyMs, usage, subtype }
  samples: [],               // { ms, childRssMb, procCount, hostRssMb, stdoutBytes }
  backpressure: null,        // the Q1 verdict object
  rateLimit: null,
  compactions: [],
  stderr: [],
  verdicts: {},
};

function writeSummary() {
  S.elapsedMs = Date.now() - START;
  try { fs.writeFileSync(summaryPath, JSON.stringify(S, null, 2)); } catch {}
}

function send(o) {
  try { proc.stdin.write(JSON.stringify(o) + '\n'); } catch (e) { rec('stdin-error', { message: String(e) }); }
}
function ask(text) {
  send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '' });
}

// ------------------------------------------------------------------ the pump
let buf = '';
let lastMsgAt = START;
let turn = null;

proc.stdout.on('data', (d) => {
  S.stdoutBytes += d.length;
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    S.stdoutLines++;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      // Framing integrity: after a stall, a torn line would show up here.
      S.parseFailures++;
      rec('parse-failure', { head: line.slice(0, 200), len: line.length });
      continue;
    }
    handle(m);
  }
});

proc.stderr.on('data', (d) => {
  const s = d.toString().trim().slice(0, 400);
  if (!s) return;
  if (S.stderr.length < 200) S.stderr.push({ ms: Date.now() - START, s });
  rec('stderr', { s });
});

proc.on('exit', (code, signal) => {
  S.alive = false;
  S.exit = { code, signal, ms: Date.now() - START };
  rec('exit', S.exit);
  finish('child-exited');
});

function handle(m) {
  const now = Date.now();
  const tag = `${m.type}${m.subtype ? ':' + m.subtype : ''}`;
  S.typeCounts[tag] = (S.typeCounts[tag] || 0) + 1;

  if (m.type === 'keep_alive') {
    const k = S.keepAlives;
    if (k.firstMs === null) k.firstMs = now - START;
    else if (k.gapsMs.length < 500) k.gapsMs.push(now - lastMsgAt);
    k.lastMs = now - START;
    k.count++;
    lastMsgAt = now;
    return;
  }
  lastMsgAt = now;

  if (m.type === 'system' && m.subtype === 'init') {
    S.init = {
      ms: now - START,
      session_id: m.session_id,
      model: m.model,
      version: m.claude_code_version,
      apiKeySource: m.apiKeySource,
      slashCommands: (m.slash_commands || []).length,
      keys: Object.keys(m),
    };
    rec('init', S.init);
    return;
  }

  if (m.type === 'rate_limit_event') {
    S.rateLimit = { ms: now - START, payload: m };
    return;
  }

  // Auto-approve anything the CLI delegates; a long run must not stall on a
  // prompt nobody is watching.
  if (m.type === 'control_request') {
    const req = m.request || {};
    rec('control_request', { subtype: req.subtype, tool: req.tool_name, reason_type: req.decision_reason_type });
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: m.request_id,
        response: req.subtype === 'can_use_tool' ? { behavior: 'allow', updatedInput: req.input } : {},
      },
    });
    return;
  }

  if (m.type === 'stream_event') {
    if (turn && turn.firstDeltaMs === null) {
      turn.firstDeltaMs = now - turn.sentAt;
      rec('first-delta', { n: turn.n, ms: turn.firstDeltaMs });
    }
    return; // deliberately not logged one-by-one
  }

  if (m.type === 'system' && /compact/i.test(m.subtype || '')) {
    S.compactions.push({ ms: now - START, subtype: m.subtype });
    rec('compaction', { subtype: m.subtype });
    return;
  }

  if (m.type === 'result') {
    // The message we push in mid-stall is not a tracked turn (the backpressure
    // turn owns the slot), so its result lands here with `turn` already null.
    // Catching it is the whole point: a result for a message written while the
    // CLI was blocked on stdout is the difference between BACKPRESSURE and
    // DEADLOCK. Without this it was silently discarded and the verdict said
    // "see events", which is not an answer.
    if (!turn && bp.sentDuringStall && bp.stallProbeResultMs == null) {
      bp.stallProbeResultMs = now - START;
      bp.stallProbeHonoured = true;
      rec('backpressure-stdin-honoured', { ms: bp.stallProbeResultMs, afterResumeMs: bp.stallProbeResultMs - (bp.resumeMs ?? 0) });
      writeSummary();
      return;
    }
    if (turn) {
      turn.resultMs = now - START;
      turn.latencyMs = now - turn.sentAt;
      turn.subtype = m.subtype;
      turn.is_error = m.is_error;
      turn.usage = m.usage
        ? {
            input: m.usage.input_tokens,
            output: m.usage.output_tokens,
            cacheRead: m.usage.cache_read_input_tokens,
            cacheCreate: m.usage.cache_creation_input_tokens,
          }
        : null;
      rec('turn-done', { n: turn.n, latencyMs: turn.latencyMs, subtype: turn.subtype, usage: turn.usage });
      const done = turn;
      turn = null;
      if (done.kind === 'backpressure') onBackpressureResult(done);
    }
    return;
  }

  if (m.type === 'assistant') {
    const texts = (m.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text);
    if (turn && texts.length) turn.reply = (turn.reply || '') + texts.join('').slice(0, 200);
    return;
  }
}

// ------------------------------------------------------------- turn machinery
let turnNo = 0;
function startTurn(kind, text) {
  if (turn) {
    rec('turn-overlap-skipped', { pending: turn.n });
    return null;
  }
  const t = { n: turnNo++, kind, sentAt: Date.now(), sentMs: Date.now() - START, firstDeltaMs: null, resultMs: null, latencyMs: null, prompt: text.slice(0, 120) };
  turn = t;
  S.turns.push(t);
  rec('turn-sent', { n: t.n, kind, prompt: t.prompt });
  ask(text);
  return t;
}

// -------------------------------------------------- Q1: the backpressure test
// Ask for a deliberately chatty answer, let it start streaming, then STOP
// DRAINING stdout for PAUSE_MS. The OS pipe buffer fills; the CLI's next write
// blocks. What we are measuring is what a blocked writer does to the rest of
// the session — and whether a user message sent DURING the stall is honoured
// after it, which is the difference between "backpressure" and "deadlock".
//
// SIZING, learned the hard way (smoke run 2026-08-01): a 5k-token answer is
// only ~90 KB of stdout, and Node's 64 KB readableHighWaterMark plus the OS
// pipe buffer absorb ALL of it — the CLI never blocks and the probe reports a
// cheerful RECOVERED it never earned. The payload must exceed both buffers by
// a clear margin, and if it does not, the verdict is INCONCLUSIVE, not a pass.
const MIN_UNREAD_BYTES = num('S11_MIN_UNREAD', 150 * 1024); // > 64K hwm + ~64K pipe
const bp = {
  state: 'pending',       // pending → stalled → resumed → done
  stallStartMs: null,
  resumeMs: null,
  bytesAtStall: 0,
  bytesAtResume: 0,
  bytesAfterResume: 0,    // what was sitting unread — the proof the pipe filled
  aliveAfterStall: null,
  sentDuringStall: false,
  stallProbeResultMs: null,
  stallProbeHonoured: false,
};

function runBackpressure() {
  if (bp.state !== 'pending') return;
  const t = startTurn(
    'backpressure',
    'Print the integers from 1 to 12000, one per line, as plain text. No commentary, no code, no tools, no truncation — just the numbers.'
  );
  if (!t) { setTimeout(runBackpressure, 30_000); return; }

  // Let it get going, then stop reading.
  setTimeout(() => {
    if (!S.alive) return;
    bp.state = 'stalled';
    bp.stallStartMs = Date.now() - START;
    bp.bytesAtStall = S.stdoutBytes;
    proc.stdout.pause();
    rec('backpressure-stall-begin', { bytesSoFar: S.stdoutBytes, pauseMs: PAUSE_MS });

    // Mid-stall, write to stdin. If the CLI is deadlocked on its stdout write
    // it cannot read this; the question is whether it picks it up on resume.
    setTimeout(() => {
      if (bp.state !== 'stalled') return;
      bp.sentDuringStall = true;
      rec('backpressure-stdin-during-stall', {});
      send({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'STALL-PROBE' }] }, parent_tool_use_id: null, session_id: '' });
    }, Math.floor(PAUSE_MS / 2));

    setTimeout(() => {
      bp.aliveAfterStall = S.alive;
      bp.state = 'resumed';
      bp.resumeMs = Date.now() - START;
      bp.bytesAtResume = S.stdoutBytes;
      proc.stdout.resume();
      rec('backpressure-resume', { aliveAfterStall: bp.aliveAfterStall, stalledMs: bp.resumeMs - bp.stallStartMs });
      // Wedge watchdog. It must test PROGRESS, not completion: this run's
      // backpressure turn legitimately took 111s more to drain 358 KB, and a
      // completion-based watchdog cried "no result within 90s" over a session
      // that was working perfectly. A slow drain is healthy; a static pipe is
      // not. So it re-arms as long as bytes are still moving, and only a
      // genuinely silent stdout is reported — and it never marks the test
      // `done`, which is the result handler's job.
      let lastSeenBytes = S.stdoutBytes;
      const wedgeCheck = setInterval(() => {
        if (bp.state !== 'resumed') { clearInterval(wedgeCheck); return; }
        if (S.stdoutBytes > lastSeenBytes) { lastSeenBytes = S.stdoutBytes; return; }
        clearInterval(wedgeCheck);
        bp.bytesAfterResume = S.stdoutBytes - bp.bytesAtResume;
        bp.verdict = `WEDGED — stdout static for 90s after resume (${bp.bytesAfterResume} bytes drained, no result)`;
        S.backpressure = bp;
        rec('backpressure-verdict', { verdict: bp.verdict, bytesAfterResume: bp.bytesAfterResume });
        writeSummary();
      }, 90_000);
    }, PAUSE_MS);
  }, 4_000);
}

function onBackpressureResult(t) {
  bp.state = 'done';
  bp.resultAfterResumeMs = t.resultMs - (bp.resumeMs ?? 0);
  bp.totalTurnMs = t.latencyMs;
  bp.parseFailures = S.parseFailures;
  // Everything that arrived once we started reading again was, by definition,
  // waiting in a buffer while we were not reading. That number is the only
  // evidence the writer was ever under pressure.
  bp.bytesAfterResume = S.stdoutBytes - bp.bytesAtResume;
  bp.filledBuffers = bp.bytesAfterResume >= MIN_UNREAD_BYTES;

  if (!bp.filledBuffers) {
    bp.verdict =
      `INCONCLUSIVE — only ${bp.bytesAfterResume} bytes were waiting after the stall ` +
      `(need >= ${MIN_UNREAD_BYTES} to exceed Node's 64K highWaterMark + the OS pipe ` +
      `buffer). The CLI was never blocked, so this run proves nothing about deadlock.`;
  } else if (S.parseFailures > 0) {
    bp.verdict = `RECOVERED BUT FRAMING TORN — ${S.parseFailures} parse failures after a real stall`;
  } else {
    bp.verdict = `RECOVERED — ${bp.bytesAfterResume} bytes were blocked behind us and arrived intact; the turn completed`;
  }
  S.backpressure = bp;
  rec('backpressure-verdict', { verdict: bp.verdict, bytesAfterResume: bp.bytesAfterResume, filledBuffers: bp.filledBuffers, parseFailures: S.parseFailures });
  writeSummary();
}

// ------------------------------------------------------------------ sampling
function procTree(rootPid, cb) {
  if (process.platform === 'win32') {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress'],
      { maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return cb(null);
        let rows;
        try { rows = JSON.parse(stdout); } catch { return cb(null); }
        if (!Array.isArray(rows)) rows = [rows];
        const kids = new Map();
        for (const r of rows) {
          if (!kids.has(r.ParentProcessId)) kids.set(r.ParentProcessId, []);
          kids.get(r.ParentProcessId).push(r);
        }
        const byId = new Map(rows.map((r) => [r.ProcessId, r]));
        const seen = new Set();
        const queue = [rootPid];
        let rss = 0, count = 0;
        while (queue.length) {
          const id = queue.shift();
          if (seen.has(id)) continue;
          seen.add(id);
          const self = byId.get(id);
          if (self) { rss += self.WorkingSetSize || 0; count++; }
          for (const k of kids.get(id) || []) queue.push(k.ProcessId);
        }
        cb({ rssMb: +(rss / 1048576).toFixed(1), count });
      }
    );
  } else {
    execFile('ps', ['-eo', 'pid=,ppid=,rss='], (err, stdout) => {
      if (err) return cb(null);
      const kids = new Map();
      const self = new Map();
      for (const l of stdout.split('\n')) {
        const [pid, ppid, rss] = l.trim().split(/\s+/).map(Number);
        if (!pid) continue;
        self.set(pid, rss);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
      }
      const seen = new Set();
      const queue = [rootPid];
      let rss = 0, count = 0;
      while (queue.length) {
        const id = queue.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        if (self.has(id)) { rss += self.get(id); count++; }
        for (const k of kids.get(id) || []) queue.push(k);
      }
      cb({ rssMb: +(rss / 1024).toFixed(1), count });
    });
  }
}

function sample() {
  procTree(proc.pid, (tree) => {
    const s = {
      ms: Date.now() - START,
      alive: S.alive,
      childRssMb: tree ? tree.rssMb : null,
      procCount: tree ? tree.count : null,
      hostRssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
      stdoutBytes: S.stdoutBytes,
      stdoutLines: S.stdoutLines,
      keepAlives: S.keepAlives.count,
      msSinceLastMsg: Date.now() - lastMsgAt,
    };
    S.samples.push(s);
    rec('sample', s);
    writeSummary();
  });
}

// -------------------------------------------------------------------- verdicts
function computeVerdicts() {
  const done = S.turns.filter((t) => t.latencyMs !== null);
  const hb = done.filter((t) => t.kind === 'heartbeat');
  const first = S.samples[0];
  const last = S.samples[S.samples.length - 1];
  S.verdicts = {
    Q1_backpressure: S.backpressure ? S.backpressure.verdict : 'NOT REACHED',
    Q1_stdinDuringStallHonoured: !bp.sentDuringStall
      ? 'not sent'
      : bp.stallProbeHonoured
        ? `YES — answered ${bp.stallProbeResultMs - bp.resumeMs}ms after we resumed reading, so a message written to a BLOCKED CLI was queued, not lost`
        : 'NO — the message written during the stall was never answered (lost, not merely delayed)',
    Q2_survivedMs: Date.now() - START,
    Q2_exit: S.exit ? `EXITED code=${S.exit.code} signal=${S.exit.signal} at ${S.exit.ms}ms` : 'still alive at shutdown',
    Q2_keepAliveCount: S.keepAlives.count,
    Q2_keepAliveMedianGapMs: median(S.keepAlives.gapsMs),
    Q3_childRssMb: first && last ? `${first.childRssMb} → ${last.childRssMb}` : 'no samples',
    Q3_hostRssMb: first && last ? `${first.hostRssMb} → ${last.hostRssMb}` : 'no samples',
    Q3_heartbeatLatencyMs: hb.length ? `${hb[0].latencyMs} → ${hb[hb.length - 1].latencyMs} (median ${median(hb.map((t) => t.latencyMs))})` : 'none',
    // The conversation is resent every turn, so the growth shows up as cache
    // READS, not as input tokens — `input` stays at 2 all day and would say
    // "an 8-hour session costs nothing", which is the opposite of the truth.
    Q4_cacheReadTokens: hb.length && hb[0].usage && hb[hb.length - 1].usage
      ? `${hb[0].usage.cacheRead} → ${hb[hb.length - 1].usage.cacheRead}`
      : 'no usage',
    Q4_inputTokens: hb.length && hb[0].usage && hb[hb.length - 1].usage
      ? `${hb[0].usage.input} → ${hb[hb.length - 1].usage.input}`
      : 'no usage',
    Q4_compactions: S.compactions.length,
    framing_parseFailures: S.parseFailures,
    turnsCompleted: done.length,
    turnsSent: S.turns.length,
  };
}
function median(a) {
  if (!a || !a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

let finished = false;
function finish(why) {
  if (finished) return;
  finished = true;
  S.stoppedBecause = why;
  computeVerdicts();
  writeSummary();
  rec('finish', { why, verdicts: S.verdicts });
  try { events.end(); } catch {}
  console.log(`[s11] finished (${why}) — ${summaryPath}`);
  try { if (S.alive) proc.kill(); } catch {}
  setTimeout(() => process.exit(0), 800);
}

// ------------------------------------------------------------------ schedule
rec('spawn', { pid: proc.pid, cwd: work, args });
writeSummary();

setTimeout(() => startTurn('heartbeat', 'Reply with exactly: PING-0'), 2_000);
setTimeout(runBackpressure, BACKPRESSURE_AT_MS);
const hbTimer = setInterval(() => startTurn('heartbeat', `Reply with exactly: PING-${turnNo}`), HEARTBEAT_MS);
const sampleTimer = setInterval(sample, SAMPLE_MS);
setTimeout(() => { clearInterval(hbTimer); clearInterval(sampleTimer); finish('duration-reached'); }, DURATION_MS);

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => finish(`signal:${sig}`));
