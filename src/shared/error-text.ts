/**
 * Turn whatever a `catch` handed you into text a person can read.
 *
 * A catch variable is `unknown`, and the idiom this tree used everywhere was
 * `String(err)`. That is right for an `Error` — it gives `Error: the message`,
 * `code` prefix and all — and wrong for everything else that can be thrown: a
 * plain object renders as the literal text `[object Object]`, in a log line, a
 * diagnostic bundle, or a banner the user reads. Nothing here throws plain
 * objects on purpose; a rejected IPC call, a JSON-RPC error body and a
 * library's `{ code, message }` all do it for us.
 *
 * `no-base-to-string` could not catch it: that rule runs with
 * `checkUnknown: false`, and a catch variable is `unknown` (#670).
 *
 * The contract, in order:
 *
 *   1. Whatever `String(err)` already said, if it said something — so an
 *      `Error`, a primitive and anything with its own `toString` read exactly
 *      as they did before. No log line that was already useful changes.
 *   2. The object's own `message`, when it has one.
 *   3. The object as JSON, capped — the fields are the only information left.
 *   4. A sentence naming its keys, when even that cannot be had (a cycle).
 *
 * It never throws: this runs inside catch blocks, and a second failure there
 * would replace the error being reported with one about reporting it.
 *
 * This is not `asDisplayString`, which is for a FIELD off the wire and answers
 * a non-primitive with the caller's fallback. An error has no fallback worth
 * showing — "something failed" with the reason dropped is the bug.
 */
export function errorText(thrown: unknown): string {
  let plain: string | undefined;
  try {
    plain = String(thrown);
  } catch {
    // a hostile or broken toString — fall through to the object's fields
  }
  if (plain !== undefined && !plain.includes(OBJECT_TAG)) return plain;
  if (typeof thrown !== 'object' || thrown === null) return plain ?? 'unknown error';

  try {
    const message = (thrown as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  } catch {
    // a throwing getter — the JSON attempt below will fail the same way
  }

  try {
    const json = JSON.stringify(thrown);
    if (typeof json === 'string') {
      return json.length > MAX_JSON ? `${json.slice(0, MAX_JSON)}…` : json;
    }
  } catch {
    // a cycle, a BigInt, a throwing toJSON
  }

  try {
    const keys = Object.keys(thrown);
    return keys.length > 0
      ? `a thrown object that could not be shown (keys: ${keys.join(', ')})`
      : 'a thrown object that could not be shown';
  } catch {
    return 'a thrown object that could not be shown';
  }
}

/** what `Object.prototype.toString` prints: `[object Object]`, `[object Map]`… */
const OBJECT_TAG = '[object ';

/** enough for a JSON-RPC error body; short enough that one line stays one line */
const MAX_JSON = 500;
