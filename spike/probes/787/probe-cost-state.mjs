#!/usr/bin/env node
// Probe for #787 — WHEN does the CLI write `cost-state`, and is its number
// usable LIVE?
//
// The issue reports 14 of 3,259 transcripts carrying one. Before designing a
// pane around "the CLI's own cost", we need to know whether that line lands
// only at session end (in which case it is an epitaph, not a live readout) and
// how far its number sits from the estimate §5.13 ships today.
//
// Read-only over ~/.claude/projects. Writes a JSON report to stdout and a
// summary table to stderr. Spawns nothing.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const ROOT = process.env.PROBE_ROOT ?? path.join(os.homedir(), '.claude', 'projects');

/** Same rate table §5.13 ships in renderer/src/lib/usage.ts, so the comparison
 *  is against what the app ACTUALLY shows, not an idealised table. */
const RATES = [
  { match: /opus/i, rate: { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 } },
  { match: /haiku/i, rate: { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 } },
  { match: /sonnet|fable|mythos/i, rate: { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 } },
];
const DEFAULT_RATE = RATES[2].rate;
const rateFor = (m) => (m && RATES.find((r) => r.match.test(m))?.rate) || DEFAULT_RATE;

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && p.endsWith('.jsonl')) yield p;
  }
}

async function scanFile(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  let total = 0;
  let malformed = 0;
  const costStates = [];
  const versions = new Set();
  let lastTimestamp = null;
  let lastModel;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  // dedupe on messageId (streaming repeats the same usage across lines)
  const seenMsg = new Set();

  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    total++;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (typeof e?.version === 'string') versions.add(e.version);
    if (typeof e?.timestamp === 'string') lastTimestamp = e.timestamp;
    const msg = e?.message;
    if (msg && typeof msg === 'object') {
      if (typeof msg.model === 'string' && msg.model !== '<synthetic>') lastModel = msg.model;
      const u = msg.usage;
      const key = msg.id ? `${msg.id}:${e.requestId ?? ''}` : null;
      if (u && (!key || !seenMsg.has(key))) {
        if (key) seenMsg.add(key);
        usage.input += u.input_tokens ?? 0;
        usage.output += u.output_tokens ?? 0;
        usage.cacheRead += u.cache_read_input_tokens ?? 0;
        usage.cacheCreate += u.cache_creation_input_tokens ?? 0;
      }
    }
    if (e?.type === 'cost-state') {
      costStates.push({
        lineNo,
        keys: Object.keys(e).sort(),
        totalCostUSD: e.totalCostUSD,
        hasUnknownModelCost: e.hasUnknownModelCost,
        startTime: e.startTime,
        totalDuration: e.totalDuration,
        totalAPIDuration: e.totalAPIDuration,
        totalLinesAdded: e.totalLinesAdded,
        totalLinesRemoved: e.totalLinesRemoved,
        timestamp: e.timestamp ?? null,
        sessionId: e.sessionId ?? null,
        uuid: e.uuid ?? null,
        models: e.modelUsage ? Object.keys(e.modelUsage) : [],
        modelUsageKeys: e.modelUsage
          ? [...new Set(Object.values(e.modelUsage).flatMap((v) => Object.keys(v ?? {})))].sort()
          : [],
        modelUsage: e.modelUsage ?? null,
      });
    }
  }
  return { file, total, malformed, lineNo, costStates, versions: [...versions], lastTimestamp, lastModel, usage };
}

const files = [...walk(ROOT)];
process.stderr.write(`scanning ${files.length} transcripts under ${ROOT}\n`);

const hits = [];
let scanned = 0;
for (const f of files) {
  let r;
  try {
    r = await scanFile(f);
  } catch (err) {
    process.stderr.write(`  ! ${f}: ${err.message}\n`);
    continue;
  }
  scanned++;
  if (r.costStates.length) hits.push(r);
  if (scanned % 500 === 0) process.stderr.write(`  ...${scanned}/${files.length}\n`);
}

const report = {
  root: ROOT,
  transcriptsScanned: scanned,
  transcriptsWithCostState: hits.length,
  files: hits.map((h) => {
    const last = h.costStates[h.costStates.length - 1];
    const r = rateFor(h.lastModel);
    const estimate =
      (h.usage.input * r.input +
        h.usage.output * r.output +
        h.usage.cacheRead * r.cacheRead +
        h.usage.cacheCreate * r.cacheCreate) /
      1_000_000;
    return {
      file: path.relative(ROOT, h.file),
      lines: h.lineNo,
      versions: h.versions,
      costStateCount: h.costStates.length,
      // THE question: is the last cost-state the last line, or is there
      // conversation after it? Lines-after > 0 means it is written LIVE.
      linesAfterLastCostState: h.lineNo - last.lineNo,
      costStateLineNumbers: h.costStates.map((c) => c.lineNo),
      totalCostUSDSeries: h.costStates.map((c) => c.totalCostUSD),
      monotonic: h.costStates.every(
        (c, i) => i === 0 || !(c.totalCostUSD < h.costStates[i - 1].totalCostUSD),
      ),
      hasUnknownModelCost: h.costStates.map((c) => c.hasUnknownModelCost),
      lastKeys: last.keys,
      lastModels: last.models,
      modelUsageKeys: last.modelUsageKeys,
      hasTimestamp: last.timestamp !== null,
      hasSessionId: last.sessionId !== null,
      hasUuid: last.uuid !== null,
      lastTranscriptTimestamp: h.lastTimestamp,
      costStateTimestamp: last.timestamp,
      cliTotalCostUSD: last.totalCostUSD,
      ourEstimateUSD: Number(estimate.toFixed(4)),
      ratio: last.totalCostUSD ? Number((estimate / last.totalCostUSD).toFixed(3)) : null,
      lastModel: h.lastModel,
      tokens: h.usage,
      modelUsage: last.modelUsage,
    };
  }),
};

process.stdout.write(JSON.stringify(report, null, 2));

process.stderr.write(`\n=== ${hits.length}/${scanned} transcripts carry cost-state ===\n`);
for (const f of report.files) {
  process.stderr.write(
    `${f.file}\n` +
      `   lines=${f.lines} costStates=${f.costStateCount} at ${JSON.stringify(f.costStateLineNumbers)} ` +
      `linesAfterLast=${f.linesAfterLastCostState}\n` +
      `   cli=$${f.cliTotalCostUSD} ours=$${f.ourEstimateUSD} ratio=${f.ratio} ` +
      `unknownCost=${JSON.stringify(f.hasUnknownModelCost)} models=${JSON.stringify(f.lastModels)}\n` +
      `   versions=${JSON.stringify(f.versions)} ts=${f.hasTimestamp} sessionId=${f.hasSessionId} uuid=${f.hasUuid}\n`,
  );
}
