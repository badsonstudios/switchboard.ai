// S-05: watch a project's transcript dir during a session that spawns a Task
// subagent; record how sidechain activity appears — same file or separate,
// which fields mark it (isSidechain? parentUuid? agent name?), and with what
// latency subagent tool calls become visible.
//   node tail-all.js <session-cwd-mixed> <outDir> <followMs>
const fs = require('fs');
const path = require('path');
const os = require('os');

const [, , sessionCwd, outDir, followMsArg] = process.argv;
const FOLLOW_MS = Number(followMsArg || 180000);
fs.mkdirSync(outDir, { recursive: true });

const slug = sessionCwd.replace(/[\\/:. ]/g, '-');
const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
const ev = (s) => {
  fs.appendFileSync(path.join(outDir, 'watcher.log'), `${new Date().toISOString()} ${s}\n`);
  console.log(s);
};

// Watch the whole projects root (subagent transcripts might not land in the
// project's own slug dir — that's part of what we're probing), but only files
// created after start.
function safeList(p) { try { return fs.readdirSync(p); } catch (_) { return []; } }

// Recursive .jsonl scan, bounded depth — subagent transcripts live nested at
// <slug>/<session-uuid>/subagents/agent-<id>.jsonl (discovered the hard way).
function scanJsonl(root, depth = 0, acc = []) {
  if (depth > 4) return acc;
  for (const name of safeList(root)) {
    const full = path.join(root, name);
    let st; try { st = fs.statSync(full); } catch (_) { continue; }
    if (st.isDirectory()) scanJsonl(full, depth + 1, acc);
    else if (name.endsWith('.jsonl')) acc.push(full);
  }
  return acc;
}

const before = new Set(scanJsonl(projectsRoot));

const t0 = Date.now();
const tracked = new Map(); // file -> {offset, buf}
const record = []; // per-line observations
const perFile = {};

const iv = setInterval(() => {
  for (const full of scanJsonl(projectsRoot)) {
    if (before.has(full)) continue;
    if (!tracked.has(full)) {
      tracked.set(full, { offset: 0, buf: '' });
      const rel = path.relative(projectsRoot, full);
      const topDir = rel.split(path.sep)[0];
      ev(`NEW FILE +${Date.now() - t0}ms rel=${rel} inProjectSlug=${topDir === slug} isSubagentFile=${rel.includes('subagents')}`);
      // .meta.json sidecar (subagent identity) — capture if present
      const meta = full.replace(/\.jsonl$/, '.meta.json');
      let metaObj = null;
      try { metaObj = JSON.parse(fs.readFileSync(meta, 'utf8')); ev(`  meta: ${JSON.stringify(metaObj)}`); } catch (_) {}
      perFile[full] = { rel, inProjectSlug: topDir === slug, isSubagentFile: rel.includes('subagents'),
        meta: metaObj, firstSeenMs: Date.now() - t0, lines: 0, types: {}, sidechainLines: 0, agents: new Set(), tools: [] };
    }
    drain(full);
  }
}, 100);

function drain(full) {
  const t = tracked.get(full);
  let st;
  try { st = fs.statSync(full); } catch (_) { return; }
  if (st.size <= t.offset) return;
  const fd = fs.openSync(full, 'r');
  const chunk = Buffer.alloc(st.size - t.offset);
  fs.readSync(fd, chunk, 0, chunk.length, t.offset);
  fs.closeSync(fd);
  t.offset = st.size;
  t.buf += chunk.toString('utf8');
  let nl;
  while ((nl = t.buf.indexOf('\n')) >= 0) {
    const line = t.buf.slice(0, nl); t.buf = t.buf.slice(nl + 1);
    if (!line.trim()) continue;
    const pf = perFile[full];
    pf.lines++;
    let e;
    try { e = JSON.parse(line); } catch (_) { pf.types['(malformed)'] = (pf.types['(malformed)'] || 0) + 1; continue; }
    const type = e.type || '(untyped)';
    pf.types[type] = (pf.types[type] || 0) + 1;
    if (e.isSidechain) pf.sidechainLines++;
    // hunt for agent identity in plausible places
    for (const k of ['agentName', 'agent', 'subagent_type', 'agentType', 'agentId']) {
      if (e[k]) pf.agents.add(`${k}=${e[k]}`);
    }
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const c of content) {
      if (c && c.type === 'tool_use') {
        // spawner tool is 'Agent' in 2.1.x (was 'Task'); match both
        pf.tools.push({ atMs: Date.now() - t0, name: c.name, sidechain: !!e.isSidechain,
          task: (c.name === 'Task' || c.name === 'Agent') ? { desc: c.input && c.input.description, type: c.input && c.input.subagent_type } : undefined });
        if (c.name === 'TodoWrite') {
          record.push({ kind: 'todowrite', atMs: Date.now() - t0, todos: c.input && c.input.todos });
        }
      }
    }
    record.push({
      kind: 'line', atMs: Date.now() - t0, file: path.basename(full), inProjectSlug: pf.inProjectSlug,
      type, isSidechain: !!e.isSidechain, uuid: e.uuid, parentUuid: e.parentUuid, sessionId: e.sessionId,
      lagMs: e.timestamp ? Date.now() - Date.parse(e.timestamp) : null,
    });
  }
}

setTimeout(() => {
  clearInterval(iv);
  for (const pf of Object.values(perFile)) pf.agents = [...pf.agents];
  fs.writeFileSync(path.join(outDir, 'observations.json'), JSON.stringify({ files: perFile, record }, null, 2));
  ev(`done: ${Object.keys(perFile).length} new files, ${record.length} recorded events`);
  process.exit(0);
}, FOLLOW_MS);
