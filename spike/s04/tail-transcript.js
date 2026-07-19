// S-04: transcript discovery + live tailing, transcript-only (no hooks).
//   node tail-transcript.js <session-cwd-mixed> <outDir> [--follow-ms N]
//
// Discovery: snapshot ~/.claude/projects/* before the session starts, then
// poll for a NEW .jsonl anywhere under it; record which project dir it landed
// in and how that dir name maps to the session cwd (the slug question).
//
// Tailing: byte-offset polling every 100ms (fs.watch is unreliable on
// Windows); split on \n; per-line tolerant parse — a malformed line increments
// a counter and never throws.
//
// Derived live state (printed as a status line, transcript-only):
//   status: working | awaiting-input | done (heuristic from last entry)
//   tokens: running totals from message.usage
//   tools:  count + last tool + files touched
//   lag:    entry.timestamp vs wall clock at read (per-line, summarized)
const fs = require('fs');
const path = require('path');
const os = require('os');

const [, , sessionCwd, outDir] = process.argv;
const followMsArg = process.argv.indexOf('--follow-ms');
const FOLLOW_MS = followMsArg > -1 ? Number(process.argv[followMsArg + 1]) : 120000;
if (!outDir) { console.error('usage: tail-transcript.js <cwd> <outDir> [--follow-ms N]'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
const ev = (s) => {
  const line = `${new Date().toISOString()} ${s}`;
  fs.appendFileSync(path.join(outDir, 'tailer.log'), line + '\n');
  console.log(line);
};

// --- discovery ---------------------------------------------------------------
const before = new Set();
for (const dir of fs.readdirSync(projectsRoot)) {
  for (const f of safeList(path.join(projectsRoot, dir))) {
    if (f.endsWith('.jsonl')) before.add(path.join(projectsRoot, dir, f));
  }
}
ev(`discovery: snapshot ${before.size} existing transcripts; waiting for a new one...`);

function safeList(p) { try { return fs.readdirSync(p); } catch (_) { return []; } }

const t0 = Date.now();
const findNew = setInterval(() => {
  for (const dir of safeList(projectsRoot)) {
    for (const f of safeList(path.join(projectsRoot, dir))) {
      const full = path.join(projectsRoot, dir, f);
      if (f.endsWith('.jsonl') && !before.has(full)) {
        clearInterval(findNew);
        const discoveryMs = Date.now() - t0;
        ev(`discovery: NEW transcript after ${discoveryMs}ms: ${full}`);
        ev(`discovery: project dir slug = ${dir}`);
        ev(`discovery: session cwd      = ${sessionCwd}`);
        const naive = sessionCwd.replace(/[\\/:. ]/g, '-');
        ev(`discovery: naive slug guess (cwd with [\\/:. ]->'-') = ${naive} ; match=${dir === naive}`);
        tail(full, discoveryMs);
        return;
      }
    }
  }
  if (Date.now() - t0 > 60000) { clearInterval(findNew); ev('discovery: TIMEOUT'); process.exit(1); }
}, 100);

// --- tailing -----------------------------------------------------------------
function tail(file, discoveryMs) {
  let offset = 0;
  let buf = '';
  const state = {
    discoveryMs,
    lines: 0, parsed: 0, malformed: 0,
    types: {}, status: 'starting',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    tools: [], files: new Set(),
    lags: [], firstLineMs: null, sessionId: null,
  };

  const iv = setInterval(() => {
    let st;
    try { st = fs.statSync(file); } catch (_) { return; }
    if (st.size <= offset) return;
    const fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(st.size - offset);
    fs.readSync(fd, chunk, 0, chunk.length, offset);
    fs.closeSync(fd);
    offset = st.size;
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      state.lines++;
      if (state.firstLineMs === null) state.firstLineMs = Date.now() - t0;
      let e;
      try { e = JSON.parse(line); } catch (_) { state.malformed++; continue; }
      state.parsed++;
      handle(e);
    }
    render();
  }, 100);

  function handle(e) {
    const type = e.type || '(untyped)';
    state.types[type] = (state.types[type] || 0) + 1;
    if (e.sessionId) state.sessionId = e.sessionId;
    if (e.timestamp) {
      const lag = Date.now() - Date.parse(e.timestamp);
      if (Number.isFinite(lag)) state.lags.push(lag);
    }
    const usage = e.message && e.message.usage;
    if (usage) {
      state.tokens.input += usage.input_tokens || 0;
      state.tokens.output += usage.output_tokens || 0;
      state.tokens.cacheRead += usage.cache_read_input_tokens || 0;
      state.tokens.cacheCreate += usage.cache_creation_input_tokens || 0;
    }
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use') {
        state.tools.push(c.name);
        const fp = c.input && (c.input.file_path || c.input.path || c.input.notebook_path);
        if (fp) state.files.add(fp);
        state.status = `working:${c.name}`;
      }
    }
    if (type === 'assistant') state.status = 'working';
    if (type === 'user') state.status = 'working:awaiting-tool-or-turn';
    if (type === 'result' || e.subtype === 'success') state.status = 'done';
  }

  function render() {
    const lag = state.lags.length
      ? `${Math.min(...state.lags)}/${median(state.lags)}/${Math.max(...state.lags)}ms`
      : '-';
    process.stdout.write(
      `\r[status:${state.status}] lines=${state.lines} bad=${state.malformed} ` +
      `tok(in/out/cr)=${state.tokens.input}/${state.tokens.output}/${state.tokens.cacheRead} ` +
      `tools=${state.tools.length} files=${state.files.size} lag(min/med/max)=${lag}   `
    );
  }

  setTimeout(() => {
    clearInterval(iv);
    console.log('');
    const summary = {
      ...state,
      files: [...state.files],
      lags: undefined,
      lagMinMs: state.lags.length ? Math.min(...state.lags) : null,
      lagMedianMs: state.lags.length ? median(state.lags) : null,
      lagMaxMs: state.lags.length ? Math.max(...state.lags) : null,
      lagSamples: state.lags.length,
    };
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    ev(`tail complete: ${JSON.stringify({ lines: state.lines, malformed: state.malformed, types: state.types })}`);
    process.exit(0);
  }, FOLLOW_MS);
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
