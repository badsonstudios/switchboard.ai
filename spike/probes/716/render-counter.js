// Measurement-only patch: count FeedView / Composer / ContextMeter renders.
// node spike/probes/716/render-counter.js apply|remove   (from the repo root)
const fs = require('fs');
const f = 'src/renderer/src/components/FeedView.tsx';
const g = 'src/renderer/src/components/ContextMeter.tsx';
const mode = process.argv[2];
const tag = (name) => `  ((window as unknown as Record<string, number>)['__sb${name}'] = (((window as unknown as Record<string, number>)['__sb${name}'] ?? 0) + 1)); // PROBE716\n`;
function apply(file, pairs) {
  let lines = fs.readFileSync(file, 'utf8').split('\n');
  if (mode === 'remove') {
    lines = lines.filter((l) => !l.includes('// PROBE716'));
  } else {
    for (const [anchorLineRegex, name, after] of pairs) {
      let idx = -1;
      let seen = 0;
      for (let i = 0; i < lines.length; i++) {
        if (anchorLineRegex.test(lines[i])) {
          if (seen === after) { idx = i; break; }
          seen++;
        }
      }
      if (idx < 0) throw new Error('anchor not found ' + anchorLineRegex + ' in ' + file);
      lines.splice(idx + 1, 0, tag(name).replace(/\n$/, ''));
    }
  }
  fs.writeFileSync(file, lines.join('\n'));
}
// FeedView's `const { t } = useTranslation();` is the 3rd in the file (index 2); Composer's the 5th (index 4)
// apply in reverse order so indices hold
apply(f, [[/^  const \{ t \} = useTranslation\(\);$/, 'Composer', 4]]);
apply(f, [[/^  const \{ t \} = useTranslation\(\);$/, 'FeedView', 2]]);
apply(g, [[/^  const \{ t, i18n \} = useTranslation\(\);$/, 'ContextMeter', 0]]);
