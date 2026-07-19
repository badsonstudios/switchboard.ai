// Redaction layer (§5.22): secrets never reach disk. Two nets, both always on:
//  1. key-based — any field whose name smells like a credential
//  2. value-based — any string that matches known secret shapes
// False positives are acceptable; leaked tokens are not.

const SECRET_KEY_RE = /(token|secret|password|passwd|credential|api[-_]?key|authorization|cookie|bearer)/i;

const SECRET_VALUE_RES: RegExp[] = [
  /sk-[A-Za-z0-9_-]{10,}/g, // API-key style (incl. sk-ant-...)
  /(?:Bearer|Basic)\s+[A-Za-z0-9+/._=-]{8,}/gi,
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, // JWT
  /\b[0-9a-f]{32,}\b/gi, // long hex (session tokens, hashes-as-secrets)
];

export const REDACTED = '[REDACTED]';

export function redactString(s: string): string {
  let out = s;
  for (const re of SECRET_VALUE_RES) out = out.replace(re, REDACTED);
  return out;
}

/** Deep-redact any JSON-serializable value. Cycles are cut, not followed. */
export function redactValue(v: unknown, keyHint?: string, seen = new WeakSet<object>()): unknown {
  if (keyHint && SECRET_KEY_RE.test(keyHint)) return REDACTED;
  if (typeof v === 'string') return redactString(v);
  if (typeof v !== 'object' || v === null) return v;
  if (seen.has(v)) return '[CYCLE]';
  seen.add(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, undefined, seen));
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactValue(x, k, seen)])
  );
}
