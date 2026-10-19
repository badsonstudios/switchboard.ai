// Summarise every results/result-*.json: per technique, how many runs
// took the OS foreground and how many left our window on top without it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, 'results');
const files = fs.readdirSync(dir).filter((f) => f.startsWith('result-') && f.endsWith('.json'));
const agg = new Map();
for (const f of files) {
  const { rows } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const r of rows) {
    const k = `${r.technique} [${r.start}${r.idleMs ? `, idle ${r.idleMs / 1000}s` : ''}]`;
    const a = agg.get(k) || { runs: 0, invalid: 0, took: 0, topOnly: 0, focusedLie: 0 };
    if (!r.validStart) a.invalid++;
    else {
      a.runs++;
      if (r.tookForeground) a.took++;
      else if (r.onTopAtCentre) a.topOnly++;
      if (!r.tookForeground && r.isFocused) a.focusedLie++;
    }
    agg.set(k, a);
  }
}
console.log(`files: ${files.length}`);
for (const [k, a] of agg)
  console.log(`${k} | valid runs ${a.runs} (invalid ${a.invalid}) | took foreground ${a.took} | on top, no foreground ${a.topOnly} | isFocused() true without foreground ${a.focusedLie}`);
