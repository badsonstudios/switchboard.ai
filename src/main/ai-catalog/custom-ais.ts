// "Something else" (E40 item 08, #1291; owner, 2026-10-15: in v1): any
// program that speaks ACP, added by name + command + arguments.
//
// THE ID SCHEME. `custom:<slug>`, the slug from the name (lower-case, runs of
// anything but a-z0-9 become one `-`, at most 40 characters), with `-2`, `-3`…
// on a collision. The same string is the provider id cards persist, and the
// `custom:` prefix is what keeps a user's entry from ever shadowing a
// built-in provider (`bootstrap.ts` refuses a taken id regardless).
//
// WHAT IS REFUSED, and why. The stream transport launches through
// `launchSpec`, which lets libuv build the command line: correct for argv the
// app writes, and a command-injection hole for argv a person typed when the
// program is a `.cmd` shim (`transport/win-cmd.ts` has the measurements). So
// arguments may not contain the characters cmd.exe acts on, and nothing may
// contain a control character. Refused at add time, with the reason, rather
// than mangled at spawn time.
import type { CustomAi, CustomAiDraft } from '../../shared/ais';

export const CUSTOM_PREFIX = 'custom:';
const MAX_NAME = 60;
const MAX_ARGS = 32;
const MAX_ARG_LEN = 1000;

const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);
/** cmd.exe's metacharacters (`win-cmd.ts` `escapeForCmd`), refused everywhere.
 *  Parentheses too, in the command: `cmd /c` drops the quotes round a path
 *  that holds one (`C:/Program Files (x86)/…`) and the launch breaks. */
const CMD_META = /[()%!^"<>&|]/;
const WHITESPACE = /[ \t]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function slugOf(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'ai';
}

/** The id for a new entry called `name`, given the ids already taken. */
export function customIdFor(name: string, taken: (id: string) => boolean): string {
  const base = CUSTOM_PREFIX + slugOf(name);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken(id)) return id;
  }
}

export type DraftCheck = { ok: true; draft: Required<Pick<CustomAiDraft, 'name' | 'command' | 'args'>> & { env?: Record<string, string> } } | { ok: false; error: string };

/** Narrow whatever crossed the wire to a draft we are willing to launch. */
export function checkDraft(raw: unknown): DraftCheck {
  const d = (raw ?? {}) as Partial<Record<keyof CustomAiDraft, unknown>>;
  const name = typeof d.name === 'string' ? d.name.trim() : '';
  const command = typeof d.command === 'string' ? d.command.trim() : '';
  if (!name) return { ok: false, error: 'Give it a name.' };
  if (name.length > MAX_NAME) return { ok: false, error: `Keep the name under ${MAX_NAME} characters.` };
  if (CONTROL.test(name)) return { ok: false, error: 'The name has a character that cannot be shown.' };
  if (!command) return { ok: false, error: 'Say which program to run.' };
  if (CONTROL.test(command) || CMD_META.test(command)) {
    return { ok: false, error: 'The command may not contain any of: ( ) % ! ^ " < > & |' };
  }
  // A program name (looked up on PATH) or a FULL path. A relative path with a
  // separator would be resolved against the session's folder, i.e. a program
  // sitting inside the user's project (S-01's planted-binary rule).
  if (/[\\/]/.test(command) && !/^([A-Za-z]:[\\/]|[\\/])/.test(command)) {
    return { ok: false, error: 'Give a program name, or its full path (not a relative one).' };
  }
  if (d.args !== undefined && !Array.isArray(d.args)) return { ok: false, error: 'The arguments must be a list.' };
  const args = (Array.isArray(d.args) ? d.args : []).map((a) => (typeof a === 'string' ? a : null));
  if (args.some((a) => a === null)) return { ok: false, error: 'Every argument must be text.' };
  const clean = (args as string[]).map((a) => a.trim()).filter((a) => a !== '');
  if (clean.length > MAX_ARGS) return { ok: false, error: `At most ${MAX_ARGS} arguments.` };
  for (const a of clean) {
    if (a.length > MAX_ARG_LEN) return { ok: false, error: 'One of the arguments is too long.' };
    if (CONTROL.test(a) || CMD_META.test(a)) {
      return { ok: false, error: `The argument "${a.slice(0, 40)}" may not contain any of: ( ) % ! ^ " < > & |` };
    }
    if (WHITESPACE.test(a)) {
      return { ok: false, error: `The argument "${a.slice(0, 40)}" has a space in it; put each part in its own argument.` };
    }
  }
  let env: Record<string, string> | undefined;
  if (d.env !== undefined) {
    if (!d.env || typeof d.env !== 'object' || Array.isArray(d.env)) return { ok: false, error: 'The environment must be name = value pairs.' };
    env = {};
    for (const [k, v] of Object.entries(d.env as Record<string, unknown>)) {
      if (!ENV_NAME.test(k) || typeof v !== 'string' || CONTROL.test(v)) {
        return { ok: false, error: `The environment variable "${k.slice(0, 40)}" is not usable.` };
      }
      env[k] = v;
    }
    if (Object.keys(env).length === 0) env = undefined;
  }
  return { ok: true, draft: { name, command, args: clean, ...(env ? { env } : {}) } };
}

/** A persisted entry, or null when it is not one we would have written. */
export function validCustomAi(v: unknown): CustomAi | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id.startsWith(CUSTOM_PREFIX) || o.id.length <= CUSTOM_PREFIX.length) return null;
  const c = checkDraft(o);
  if (!c.ok) return null;
  const addedAt = typeof o.addedAt === 'number' && Number.isFinite(o.addedAt) ? o.addedAt : 0;
  return { id: o.id, ...c.draft, addedAt };
}
