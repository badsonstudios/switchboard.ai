// #807 probe — does our per-session token total reconcile with the CLI's own
// ledger (`cost-state.modelUsage`) once subagent files are counted the way the
// watcher counts them?
//
// Read-only over ~/.claude/projects (PROBE_ROOT overrides). Spawns nothing.
//
// For every PARENT transcript carrying a `cost-state` line, and for EACH
// cost-state line in it, sums message.usage under several rules and prints the
// ratio ours ÷ CLI per field:
//   P-raw   parent file only, every usage line          (neither fix)
//   P-dd    parent file only, de-duped on id:requestId  (#787's probe)
//   PS-raw  parent + subagents/*.jsonl, every line      (TODAY'S WATCHER)
//   PS-dd   parent + subagents, de-duped
// Each rule is computed over two windows: ALL lines before the cost-state line
// (what a replay-from-byte-0 watcher sees), and only lines whose timestamp is
// >= the cost-state's startTime (the CLI process run the ledger describes).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.env.PROBE_ROOT ?? path.join(os.homedir(), '.claude', 'projects');

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'subagents') continue;
      yield* walk(p);
    } else if (e.isFile() && p.endsWith('.jsonl')) yield p;
  }
}

function readLines(file) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  let n = 0;
  for (const line of text.split('\n')) {
    n++;
    if (!line.trim()) continue;
    try {
      out.push({ n, e: JSON.parse(line) });
    } catch {
      /* torn line */
    }
  }
  return out;
}

const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, lines: 0 });
const tsOf = (e) => (typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) : NaN);

function sum(lines, { dedupe, since, beforeTs }) {
  const acc = zero();
  const byModel = {};
  const seen = new Set();
  const last = new Map();
  const picked = [];
  for (const { e } of lines) {
    const u = e?.message?.usage;
    if (!u || typeof u !== 'object') continue;
    const t = tsOf(e);
    if (since !== undefined && !(t >= since)) continue;
    if (beforeTs !== undefined && Number.isFinite(t) && t > beforeTs) continue;
    const id = e.message.id;
    const k = id ? `${id}:${e.requestId ?? ''}` : null;
    if (dedupe === 'last' && k) {
      last.set(k, e);
      continue;
    }
    if (dedupe && k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    picked.push(e);
  }
  picked.push(...last.values());
  for (const e of picked) {
    const u = e.message.usage;
    const m = e.message.model ?? '?';
    const bm = (byModel[m] ??= zero());
    for (const [dst, src] of [
      ['input', 'input_tokens'],
      ['output', 'output_tokens'],
      ['cacheRead', 'cache_read_input_tokens'],
      ['cacheCreate', 'cache_creation_input_tokens'],
    ]) {
      const v = typeof u[src] === 'number' ? u[src] : 0;
      acc[dst] += v;
      bm[dst] += v;
    }
    acc.lines++;
    bm.lines++;
  }
  return { acc, byModel };
}

function cliTotals(mu) {
  const t = zero();
  const keys = new Set();
  for (const v of Object.values(mu ?? {})) {
    for (const k of Object.keys(v ?? {})) keys.add(k);
    t.input += v?.inputTokens ?? 0;
    t.output += v?.outputTokens ?? 0;
    t.cacheRead += v?.cacheReadInputTokens ?? 0;
    t.cacheCreate += v?.cacheCreationInputTokens ?? 0;
  }
  return { t, keys: [...keys].sort() };
}

const r = (a, b) => (b ? Number((a / b).toFixed(4)) : a ? 'inf' : 1);
const ratios = (ours, cli) => ({
  input: r(ours.input, cli.input),
  output: r(ours.output, cli.output),
  cacheRead: r(ours.cacheRead, cli.cacheRead),
  cacheCreate: r(ours.cacheCreate, cli.cacheCreate),
});

const report = [];
for (const file of walk(ROOT)) {
  const parent = readLines(file);
  const cs = parent.filter(({ e }) => e?.type === 'cost-state');
  if (!cs.length) continue;
  const subDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  let subFiles = [];
  try {
    subFiles = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(subDir, f));
  } catch {
    /* none */
  }
  const sub = subFiles.flatMap(readLines);
  for (const { n, e } of cs) {
    const before = parent.filter((l) => l.n < n);
    const csTs = tsOf(e);
    const since = typeof e.startTime === 'number' ? e.startTime : Date.parse(e.startTime);
    const { t: cli, keys } = cliTotals(e.modelUsage);
    const rules = {};
    for (const win of ['all', 'run']) {
      const opt = win === 'run' ? { since, beforeTs: csTs } : { beforeTs: csTs };
      for (const [name, lines, dedupe] of [
        ['P-raw', before, false],
        ['P-dd', before, true],
        ['PS-raw', [...before, ...sub], false],
        ['PS-dd', [...before, ...sub], true],
        ['PS-last', [...before, ...sub], 'last'],
      ]) {
        const { acc } = sum(lines, { ...opt, dedupe });
        rules[`${win}:${name}`] = { ...ratios(acc, cli), lines: acc.lines };
      }
    }
    const runPSdd = sum([...before, ...sub], { since, beforeTs: csTs, dedupe: true });
    report.push({
      file: path.relative(ROOT, file),
      csLine: n,
      startTime: e.startTime,
      costTs: e.timestamp,
      subagentFiles: subFiles.length,
      cliKeys: keys,
      cli,
      cliModels: Object.fromEntries(
        Object.entries(e.modelUsage ?? {}).map(([m, v]) => [
          m,
          { in: v.inputTokens, out: v.outputTokens, cr: v.cacheReadInputTokens, cc: v.cacheCreationInputTokens },
        ]),
      ),
      oursRunPSddByModel: runPSdd.byModel,
      rules,
    });
  }
}

process.stdout.write(JSON.stringify(report, null, 2) + '\n');
const summaryRules = ['all:P-dd', 'all:PS-raw', 'run:PS-raw', 'run:PS-dd'];
for (const x of report) {
  process.stderr.write(`\n${x.file} @${x.csLine} subs=${x.subagentFiles}\n`);
  for (const k of summaryRules) {
    const v = x.rules[k];
    process.stderr.write(
      `  ${k.padEnd(11)} in=${v.input} out=${v.output} cr=${v.cacheRead} cc=${v.cacheCreate} (lines ${v.lines})\n`,
    );
  }
}
