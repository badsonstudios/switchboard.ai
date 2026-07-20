// Pseudo-locale generator (§5.21): mangles every en string so hardcoded UI
// text is visually obvious — anything NOT wrapped in ⟦…⟧ slipped past i18n.
// ICU argument blocks ({...}) are preserved untouched so formatting still works.
const MAP: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'đ', e: 'é', f: 'ƒ', g: 'ğ', h: 'ĥ', i: 'í',
  j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: ' q', r: 'ŕ',
  s: 'š', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Đ', E: 'É', F: 'Ƒ', G: 'Ğ', H: 'Ĥ', I: 'Í',
  J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'M', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Q', R: 'Ŕ',
  S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

export function pseudolocalize(s: string): string {
  let out = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '{') depth++;
    if (ch === '}') depth = Math.max(0, depth - 1);
    out += depth > 0 || ch === '{' || ch === '}' ? ch : (MAP[ch] ?? ch);
  }
  return `⟦${out}⟧`;
}

/** Deep-map every leaf string of a translation resource. */
export function pseudolocalizeResource(node: unknown): unknown {
  if (typeof node === 'string') return pseudolocalize(node);
  if (Array.isArray(node)) return node.map(pseudolocalizeResource);
  if (typeof node === 'object' && node !== null) {
    return Object.fromEntries(
      Object.entries(node).map(([k, v]) => [k, pseudolocalizeResource(v)])
    );
  }
  return node;
}
