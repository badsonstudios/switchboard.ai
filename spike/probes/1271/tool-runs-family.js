// Same count as tool-runs.js, but by FAMILY, and for edits: one file or several.
const fs = require('fs');
const path = require('path');
const os = require('os');

const NL = String.fromCharCode(10);
const root = path.join(os.homedir(), '.claude', 'projects');
const FAMILY = {
  WebSearch: 'web', WebFetch: 'web',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  TaskCreate: 'tasks', TaskUpdate: 'tasks', TaskGet: 'tasks', TaskList: 'tasks', TodoWrite: 'tasks',
  Agent: 'agent', Task: 'agent',
};
function keyOf(name) {
  if (name.startsWith('mcp__')) return 'mcp:' + (name.split('__')[1] || '?');
  return FAMILY[name] || null;
}

const stats = new Map();
function get(key) {
  let s = stats.get(key);
  if (!s) {
    s = { calls: 0, runs3: 0, inRuns3: 0, maxRun: 0, hist: { '3-5': 0, '6-10': 0, '11+': 0 }, oneFile: 0, manyFiles: 0 };
    stats.set(key, s);
  }
  return s;
}

function walk(dir) {
  let out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

let files = 0;
function scan(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  files += 1;
  let runKey = null;
  let runLen = 0;
  let runFiles = new Set();
  const close = () => {
    if (runKey !== null) {
      const s = get(runKey);
      if (runLen > s.maxRun) s.maxRun = runLen;
      if (runLen >= 3) {
        s.runs3 += 1;
        s.inRuns3 += runLen;
        if (runLen <= 5) s.hist['3-5'] += 1;
        else if (runLen <= 10) s.hist['6-10'] += 1;
        else s.hist['11+'] += 1;
        if (runKey === 'edit') {
          if (runFiles.size <= 1) s.oneFile += 1;
          else s.manyFiles += 1;
        }
      }
    }
    runKey = null;
    runLen = 0;
    runFiles = new Set();
  };
  for (const line of text.split(NL)) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (e) { continue; }
    if (!o || o.isSidechain === true) continue;
    const content = o.message && o.message.content;
    if (o.type === 'user') {
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
        if (key === null) { close(); continue; }
        get(key).calls += 1;
        if (key !== runKey) { close(); runKey = key; }
        runLen += 1;
        const fp = c.input && (c.input.file_path || c.input.notebook_path);
        if (typeof fp === 'string') runFiles.add(fp.toLowerCase());
      }
    }
  }
  close();
}

for (const f of walk(root)) scan(f);
console.log('files ' + files);
console.log('family | calls | runs>=3 | calls in those runs | longest | runs of 3-5 / 6-10 / 11+ | edit runs: one file / several');
for (const [k, s] of [...stats.entries()].sort((a, b) => b[1].inRuns3 - a[1].inRuns3)) {
  console.log([k, s.calls, s.runs3, s.inRuns3, s.maxRun, s.hist['3-5'] + ' / ' + s.hist['6-10'] + ' / ' + s.hist['11+'], k === 'edit' ? s.oneFile + ' / ' + s.manyFiles : '-'].join(' | '));
}
