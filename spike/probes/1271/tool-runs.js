// Counts consecutive runs of the same tool in real Claude Code transcripts.
// Read-only. A run ends at a different tool, an assistant text block, or a user prompt.
const fs = require('fs');
const path = require('path');
const os = require('os');

const NL = String.fromCharCode(10);
const root = path.join(os.homedir(), '.claude', 'projects');
const SHELL = new Set(['Bash', 'PowerShell']);
const READ = new Set(['Read', 'Glob', 'Grep', 'LS']);
const EDIT = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function keyOf(name) {
  if (name.startsWith('mcp__')) return 'mcp:' + (name.split('__')[1] || '?');
  return name;
}
function categoryOf(name) {
  if (SHELL.has(name)) return 'shell';
  if (READ.has(name)) return 'read';
  if (EDIT.has(name)) return 'edit';
  return name.startsWith('mcp__') ? 'other(mcp)' : 'other';
}

const stats = new Map(); // key -> {cat, calls, runs3, callsInRuns3, maxRun, files:Set}
function bump(key, cat) {
  let s = stats.get(key);
  if (!s) {
    s = { cat, calls: 0, runs3: 0, callsInRuns3: 0, maxRun: 0, files: new Set() };
    stats.set(key, s);
  }
  return s;
}

let files = 0;
let bytes = 0;
let badLines = 0;

function walk(dir) {
  let out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function scan(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return;
  }
  files += 1;
  bytes += text.length;
  let runKey = null;
  let runLen = 0;
  const close = () => {
    if (runKey !== null) {
      const s = stats.get(runKey);
      if (runLen > s.maxRun) s.maxRun = runLen;
      if (runLen >= 3) {
        s.runs3 += 1;
        s.callsInRuns3 += runLen;
        s.files.add(file);
      }
    }
    runKey = null;
    runLen = 0;
  };
  for (const line of text.split(NL)) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (e) {
      badLines += 1;
      continue;
    }
    if (!o || o.isSidechain === true) continue;
    const content = o.message && o.message.content;
    if (o.type === 'user') {
      // a real prompt ends a run; tool results do not
      const isPrompt =
        typeof content === 'string' ||
        (Array.isArray(content) && content.some((c) => c && c.type === 'text'));
      if (isPrompt) close();
      continue;
    }
    if (o.type !== 'assistant' || !Array.isArray(content)) continue;
    for (const c of content) {
      if (!c) continue;
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim() !== '') {
        close();
      } else if (c.type === 'tool_use' && typeof c.name === 'string') {
        const key = keyOf(c.name);
        const s = bump(key, categoryOf(c.name));
        s.calls += 1;
        if (key === runKey) runLen += 1;
        else {
          close();
          runKey = key;
          runLen = 1;
        }
      }
    }
  }
  close();
}

for (const f of walk(root)) scan(f);

const rows = [...stats.entries()]
  .map(([key, s]) => ({
    key,
    cat: s.cat,
    calls: s.calls,
    runs3: s.runs3,
    inRuns3: s.callsInRuns3,
    maxRun: s.maxRun,
    convs: s.files.size,
  }))
  .sort((a, b) => b.inRuns3 - a.inRuns3 || b.calls - a.calls);

console.log('files ' + files + '  MB ' + Math.round(bytes / 1048576) + '  unparsed lines ' + badLines);
console.log(['tool', 'category', 'calls', 'runs>=3', 'calls in those runs', 'longest run', 'conversations'].join(' | '));
for (const r of rows.slice(0, 45)) {
  console.log([r.key, r.cat, r.calls, r.runs3, r.inRuns3, r.maxRun, r.convs].join(' | '));
}
console.log('distinct tools ' + rows.length);
