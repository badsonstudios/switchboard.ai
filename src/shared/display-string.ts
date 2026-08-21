/**
 * Turn an untrusted value into something safe to show a person.
 *
 * Every caller reads a field out of a payload we did not write — a
 * `stream-json` control message, a hook's JSON body, a `tool_use` block from
 * the CLI — so the static type is `unknown` and the runtime type is whatever
 * arrived on the wire. The idiom these calls used to share was
 * `String(x ?? fallback)`, which is fail-open (it never throws) but renders a
 * malformed payload as the literal text `[object Object]`: on a permission
 * card, in a feed block, or — worse — as a FILE NAME in the stream fake.
 *
 * This keeps the fail-open half and drops the `[object Object]` half. A
 * primitive is shown as itself; anything that is not a primitive (an object,
 * an array, a function, a symbol) is not display text at all, so it gets the
 * caller's fallback and the caller's existing empty-value path handles it —
 * which for an id or a path is already "we cannot use this", the honest answer.
 *
 * Deliberately `??` semantics, not `||`: `0`, `false` and `''` are real values
 * a payload can carry and they survive, exactly as they did before.
 *
 * @param value    the field as it came off the wire
 * @param fallback what to show when `value` is nullish or is not a primitive
 */
export function asDisplayString(value: unknown, fallback = ''): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    default:
      return fallback;
  }
}
