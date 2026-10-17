// "Check for new AIs" (E40 item 08, #1291; design record §6: "The registry
// is fetched only when the user presses Check for new AIs").
//
// ON A USER PRESS ONLY. Nothing in the app calls `checkRegistry` except the
// `ais:checkRegistry` IPC handler, and nothing calls that except a button. It
// is one unauthenticated GET of a public JSON file; it sends nothing about the
// user, and the result is diffed against the snapshot the app shipped with.
//
// What is kept: the last check's DIFF (not the fetched registry) in
// `ai-registry-check.json` under userData, so the answer survives a restart
// without asking again. Nothing reads the network to show it.
import fs from 'fs';
import path from 'path';
import type { RegistryAgent, RegistryCheckResult, RegistryDiff } from '../../shared/ais';
import { errorText } from '../../shared/error-text';
import { REGISTRY_URL, shippedRegistry } from './catalog';

export const REGISTRY_CHECK_FILE = 'ai-registry-check.json';
export const REGISTRY_TIMEOUT_MS = 15_000;
const MAX_BYTES = 4 * 1024 * 1024;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** One registry agent as the registry's JSON gives it, trimmed; null if it is not one. */
export function readRegistryAgent(v: unknown): RegistryAgent | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const name = str(o.name);
  const version = str(o.version);
  if (!id || !name || !version) return null;
  const dist = o.distribution && typeof o.distribution === 'object' ? Object.keys(o.distribution).sort() : [];
  const authors = Array.isArray(o.authors) ? o.authors : [];
  const maker = str(authors[0])?.replace(/\s*<[^>]*>\s*$/, '');
  const description = str(o.description);
  const license = str(o.license);
  const website = str(o.website);
  const repository = str(o.repository);
  return {
    id,
    name,
    version,
    distributions: dist,
    ...(description ? { description } : {}),
    ...(maker ? { maker } : {}),
    ...(license ? { license } : {}),
    ...(website ? { website } : {}),
    ...(repository ? { repository } : {}),
  };
}

/** The registry document's agents, or null when it is not a registry. */
export function parseRegistry(raw: unknown): RegistryAgent[] | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as Record<string, unknown>).agents)) return null;
  const out: RegistryAgent[] = [];
  for (const a of (raw as { agents: unknown[] }).agents) {
    const r = readRegistryAgent(a);
    if (r && !out.some((x) => x.id === r.id)) out.push(r);
  }
  return out;
}

/** What is new, changed (version) or gone in `fetched` against `shipped`. */
export function diffRegistry(shipped: readonly RegistryAgent[], fetched: readonly RegistryAgent[]): RegistryDiff {
  const before = new Map(shipped.map((a) => [a.id, a]));
  const after = new Map(fetched.map((a) => [a.id, a]));
  const added = fetched.filter((a) => !before.has(a.id));
  const changed = fetched
    .filter((a) => before.has(a.id) && before.get(a.id)!.version !== a.version)
    .map((a) => ({ id: a.id, name: a.name, from: before.get(a.id)!.version, to: a.version }));
  const removed = shipped.filter((a) => !after.has(a.id)).map((a) => ({ id: a.id, name: a.name }));
  return { added, changed, removed };
}

export interface RegistryCheckDeps {
  userDataDir: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  fsx?: Pick<typeof fs, 'writeFileSync' | 'renameSync' | 'mkdirSync' | 'readFileSync' | 'existsSync'>;
  shipped?: readonly RegistryAgent[];
}

/** Fetch, diff, cache the diff. Never rejects. */
export async function checkRegistry(deps: RegistryCheckDeps): Promise<RegistryCheckResult> {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, error: 'no network access in this runtime' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REGISTRY_TIMEOUT_MS);
  let body: string;
  try {
    const res = await doFetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, error: `the registry answered ${res.status}` };
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_BYTES) return { ok: false, error: 'the registry sent more than expected' };
    body = await res.text();
  } catch (err) {
    return { ok: false, error: controller.signal.aborted ? 'the registry did not answer in time' : `could not reach the registry: ${errorText(err)}` };
  } finally {
    clearTimeout(timer);
  }
  if (body.length > MAX_BYTES) return { ok: false, error: 'the registry sent more than expected' };
  let agents: RegistryAgent[] | null = null;
  try {
    agents = parseRegistry(JSON.parse(body));
  } catch {
    agents = null;
  }
  if (!agents) return { ok: false, error: 'the registry sent something that is not a registry' };
  const result: RegistryCheckResult = {
    ok: true,
    fetchedAt: (deps.now ?? Date.now)(),
    total: agents.length,
    diff: diffRegistry(deps.shipped ?? shippedRegistry(), agents),
  };
  writeCache(deps, result);
  return result;
}

function writeCache(deps: RegistryCheckDeps, result: RegistryCheckResult): void {
  const fsx = deps.fsx ?? fs;
  const file = path.join(deps.userDataDir, REGISTRY_CHECK_FILE);
  try {
    fsx.mkdirSync(deps.userDataDir, { recursive: true });
    fsx.writeFileSync(`${file}.tmp`, JSON.stringify(result, null, 2));
    fsx.renameSync(`${file}.tmp`, file);
  } catch {
    /* a cache; the answer was already returned */
  }
}

/** The last check's answer, from disk. Null when there is none or it is unreadable. */
export function lastRegistryCheck(deps: Pick<RegistryCheckDeps, 'userDataDir' | 'fsx'>): RegistryCheckResult | null {
  const fsx = deps.fsx ?? fs;
  const file = path.join(deps.userDataDir, REGISTRY_CHECK_FILE);
  try {
    if (!fsx.existsSync(file)) return null;
    const v = JSON.parse(fsx.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const diff = v.diff as RegistryDiff | undefined;
    if (v.ok !== true || typeof v.fetchedAt !== 'number' || !diff || !Array.isArray(diff.added) || !Array.isArray(diff.changed) || !Array.isArray(diff.removed)) {
      return null;
    }
    return v as unknown as RegistryCheckResult;
  } catch {
    return null;
  }
}
