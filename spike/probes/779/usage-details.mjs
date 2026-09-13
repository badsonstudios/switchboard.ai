// Probe for #779 — is `message.usage.output_tokens_details.thinking_tokens` a
// BREAKDOWN of `output_tokens`, or a separate quantity to be added on top?
//
// This is the one question in #779 that changes code rather than a comment. The
// schema already carries two hard-won warnings of exactly this shape —
// `cache_creation` ("a per-TTL breakdown of the same tokens … never added on
// top") and `iterations` ("an iteration count, not tokens") — because getting it
// wrong inflates every number the usage pane shows and nothing goes red.
//
// The binary says the CLI tracks the two separately (`o.outputTokens +=
// t.output_tokens` beside `o.thinkingTokens = … + t.output_tokens_details
// ?.thinking_tokens`), which tells us it does not sum them but not whether one
// contains the other. So measure: if thinking is a breakdown, thinking_tokens
// <= output_tokens on EVERY line, and a single violation disproves it.
//
// THE CONTROL (#776's lesson — a probe that agrees with you is not evidence):
// the same pass counts lines that carry the field at all and lines where
// thinking_tokens > 0. A "0 violations" result over a corpus where the field is
// always absent, or always zero, would be vacuous — the violation count is only
// meaningful next to those two.
//
// Run: node spike/probes/779/usage-details.mjs [transcriptsRoot]
import fs from 'fs';
import path from 'path';
import os from 'os';

const root = process.argv[2] ?? path.join(os.homedir(), '.claude', 'projects');

function* walkJsonl(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

let withUsage = 0;
let withDetails = 0;
let compared = 0;
let thinkingPositive = 0;
let violations = 0;
let maxRatio = 0;
const subKeys = new Map();
const examples = [];

for (const file of walkJsonl(root)) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const usage = line?.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    withUsage++;
    const details = usage.output_tokens_details;
    if (details === undefined || details === null) continue;
    withDetails++;
    for (const k of Object.keys(details)) subKeys.set(k, (subKeys.get(k) ?? 0) + 1);
    const thinking = details.thinking_tokens;
    const output = usage.output_tokens;
    // A line carrying the details object but no numeric `output_tokens` cannot be
    // compared. Counting those OUT LOUD is the third control: without it, "0
    // violations over 42,071 lines" could in future mean "0 violations over the 3
    // lines that were actually comparable", and the printed controls would not
    // show it — which is the exact failure this probe's own header warns about.
    if (typeof thinking !== 'number' || typeof output !== 'number') continue;
    compared++;
    if (thinking > 0) thinkingPositive++;
    if (output > 0) maxRatio = Math.max(maxRatio, thinking / output);
    if (thinking > output) {
      violations++;
      if (examples.length < 5) {
        examples.push(`thinking=${thinking} output=${output} version=${line.version} ${path.basename(file)}`);
      }
    }
  }
}

console.log(`lines with message.usage            : ${withUsage}`);
console.log(`  ...carrying output_tokens_details : ${withDetails}   <- control: 0 here makes the rest vacuous`);
console.log(`  ...actually comparable (both nums) : ${compared}   <- control: the denominator of the verdict`);
console.log(`  ...with thinking_tokens > 0       : ${thinkingPositive}   <- control: 0 here makes the rest vacuous`);
console.log(`sub-keys seen under the details obj : ${[...subKeys.entries()].map(([k, n]) => `${k}(${n})`).join(', ')}`);
console.log(`max thinking_tokens / output_tokens : ${maxRatio.toFixed(4)}`);
console.log(`thinking_tokens > output_tokens     : ${violations}   <- any violation disproves "breakdown"`);
for (const e of examples) console.log(`  violation: ${e}`);
