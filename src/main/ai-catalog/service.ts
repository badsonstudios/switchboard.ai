// The model behind the AIs tab and the AI switch (E40 item 08, #1291): which
// AIs exist, which are here and signed in, which is the default, and the
// "Something else" entries. #1292 draws it; #1293 puts the icons on cards.
//
// Talks to providers only through what `index.ts` hands it — the registered
// list, each one's `detect` capability, and the bootstrap's register /
// unregister for custom AIs — so nothing here speaks any AI's wire.
import type {
  AiListItem,
  AiLoginResult,
  AisSnapshot,
  CustomAi,
  CustomAiAddResult,
  CustomAiTestResult,
  DefaultAiState,
  RegistryCheckResult,
} from '../../shared/ais';
import { errorText } from '../../shared/error-text';
import type { DetectCapability } from '../extensibility/contributions';
import type { AisStore } from './ais-store';
import { catalogEntries } from './catalog';
import { checkDraft, customIdFor } from './custom-ais';
import { defaultAiResolver } from './default-ai';
import { DetectionRunner, pathProbe, type DetectionTarget, type Probe } from './detection';
import { pathIndex, type PathLookup } from '../transport/find-on-path';

/** A registered provider, as the catalog needs to see it. */
export interface ProviderView {
  id: string;
  displayName: string;
  detect?: DetectCapability;
}

export interface AiCatalogLog {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export interface AiCatalogDeps {
  store: AisStore;
  /** every registered provider, in registration order */
  providers: () => ProviderView[];
  registerCustom: (ai: CustomAi) => boolean;
  unregisterCustom: (id: string) => boolean;
  testCommand: (
    cmd: { command: string; args: string[]; env?: Record<string, string> },
    opts: { signal: AbortSignal }
  ) => Promise<CustomAiTestResult>;
  checkRegistry: () => Promise<RegistryCheckResult>;
  lastRegistryCheck: () => RegistryCheckResult | null;
  /** `ais:changed` */
  push: (snapshot: AisSnapshot) => void;
  log: AiCatalogLog;
  now?: () => number;
  timeoutMs?: number;
  /** test seam for the PATH fallback (default: one async `pathIndex` per run) */
  find?: (command: string) => string | null;
}

const UNREPORTED: Probe = () =>
  Promise.resolve({ installed: 'unknown', login: 'unknown', detail: 'this AI does not report whether it is installed' });

export class AiCatalogService {
  private readonly runner: DetectionRunner;
  private readonly resolveDefault: () => DefaultAiState;
  /** user-pressed work that started a process: aborted at quit */
  private readonly inFlight = new Set<AbortController>();
  private readonly logins = new Map<string, Promise<AiLoginResult>>();
  /** one-AI re-check runs in flight, so quit can end them too */
  private readonly narrowRuns = new Set<DetectionRunner>();
  private disposed = false;

  constructor(private readonly deps: AiCatalogDeps) {
    this.runner = new DetectionRunner({
      targets: () => this.targets(),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      log: (msg, data) => deps.log.info(msg, data),
      onDone: () => this.changed(),
    });
    this.resolveDefault = defaultAiResolver(
      () => deps.store.defaultAi(),
      () => deps.providers().map((p) => p.id),
      (msg, data) => deps.log.warn(msg, data)
    );
  }

  /** Register every persisted custom AI. Called once, at startup, before any card starts. */
  registerPersisted(): void {
    for (const ai of this.deps.store.customAis()) {
      try {
        if (!this.deps.registerCustom(ai)) {
          this.deps.log.warn('a custom AI was not registered: its id is taken', { id: ai.id });
        }
      } catch (err) {
        this.deps.log.warn('a custom AI could not be registered', { id: ai.id, error: errorText(err) });
      }
    }
  }

  // ── the default ──────────────────────────────────────────────────────────

  defaultState(): DefaultAiState {
    return this.resolveDefault();
  }

  /** What `start-plan.ts` and the dispatcher read. */
  defaultProviderId(): string {
    return this.resolveDefault().id;
  }

  setDefault(id: unknown): { ok: true; default: DefaultAiState } | { ok: false; error: string } {
    if (typeof id !== 'string' || !id) return { ok: false, error: 'Say which AI.' };
    if (!this.deps.providers().some((p) => p.id === id)) return { ok: false, error: 'That AI is not set up here.' };
    this.deps.store.setDefaultAi(id);
    this.deps.log.info('default AI set', { id });
    this.changed();
    return { ok: true, default: this.defaultState() };
  }

  // ── the list ─────────────────────────────────────────────────────────────

  list(): AiListItem[] {
    const providers = this.deps.providers();
    const byId = new Map(providers.map((p) => [p.id, p]));
    const covered = new Set<string>();
    const items: AiListItem[] = [];
    for (const entry of catalogEntries()) {
      const providerId = entry.providerId;
      const registered = !!providerId && byId.has(providerId);
      if (providerId) covered.add(providerId);
      const detection = this.runner.result(entry.id);
      items.push({
        kind: 'catalog',
        entry,
        ...(providerId ? { providerId } : {}),
        registered,
        ...(detection ? { detection } : {}),
      });
    }
    for (const ai of this.deps.store.customAis()) {
      covered.add(ai.id);
      const detection = this.runner.result(ai.id);
      items.push({ kind: 'custom', entry: ai, providerId: ai.id, registered: byId.has(ai.id), ...(detection ? { detection } : {}) });
    }
    for (const p of providers) {
      if (covered.has(p.id)) continue;
      const detection = this.runner.result(p.id);
      items.push({
        kind: 'provider',
        entry: { id: p.id, name: p.displayName },
        providerId: p.id,
        registered: true,
        ...(detection ? { detection } : {}),
      });
    }
    return items;
  }

  snapshot(): AisSnapshot {
    return { items: this.list(), default: this.defaultState(), detecting: this.runner.running };
  }

  private changed(): void {
    try {
      this.deps.push(this.snapshot());
    } catch (err) {
      this.deps.log.warn('could not tell the window the AIs changed', { error: errorText(err) });
    }
  }

  // ── detection ────────────────────────────────────────────────────────────

  private targets(only?: ReadonlySet<string>): DetectionTarget[] {
    const byId = new Map(this.deps.providers().map((p) => [p.id, p]));
    // ONE asynchronous read of PATH for the whole run, built on first use and
    // shared by every fallback probe in it.
    let index: Promise<PathLookup> | null = null;
    const find =
      this.deps.find ??
      (async (c: string): Promise<string | null> => {
        index ??= pathIndex();
        return (await index)(c);
      });
    const probeOf = (providerId: string | undefined, command: string | undefined): Probe => {
      const cap = providerId ? byId.get(providerId)?.detect : undefined;
      if (cap) return (signal) => cap.detect(signal);
      if (command) return pathProbe(command, find);
      return UNREPORTED;
    };
    const out: DetectionTarget[] = [];
    for (const item of this.list()) {
      if (only && !only.has(item.entry.id)) continue;
      if (item.kind === 'catalog') out.push({ id: item.entry.id, probe: probeOf(item.registered ? item.providerId : undefined, item.entry.detectCommand) });
      else if (item.kind === 'custom') out.push({ id: item.entry.id, probe: probeOf(item.registered ? item.providerId : undefined, item.entry.command) });
      else out.push({ id: item.entry.id, probe: probeOf(item.providerId, undefined) });
    }
    return out;
  }

  /**
   * Probe every AI (startup after first paint, and "Look again"). Shared while
   * one is in flight; resolves with the new snapshot, which was also pushed.
   */
  async detectAll(reason: string): Promise<AisSnapshot> {
    const p = this.runner.run(reason);
    this.changed(); // `detecting: true`, so a Look-again button can show it
    await p;
    return this.snapshot();
  }

  /** Probe just these ids (a custom AI added, a login finished). */
  private async detectOnly(reason: string, ids: string[]): Promise<void> {
    if (this.disposed || ids.length === 0) return;
    const only = new Set(ids);
    const r = new DetectionRunner({
      targets: () => this.targets(only),
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      log: (msg, data) => this.deps.log.info(msg, data),
    });
    this.narrowRuns.add(r);
    try {
      await r.run(reason);
    } finally {
      this.narrowRuns.delete(r);
    }
    if (this.disposed) return;
    for (const id of ids) {
      const res = r.result(id);
      if (res) this.runner.adopt(id, res);
    }
    this.changed();
  }

  // ── custom AIs ───────────────────────────────────────────────────────────

  async addCustom(raw: unknown): Promise<CustomAiAddResult> {
    const c = checkDraft(raw);
    if (!c.ok) return c;
    const taken = new Set([...this.deps.providers().map((p) => p.id), ...this.deps.store.customAis().map((a) => a.id)]);
    const ai: CustomAi = { id: customIdFor(c.draft.name, (id) => taken.has(id)), ...c.draft, addedAt: (this.deps.now ?? Date.now)() };
    let registered = false;
    try {
      registered = this.deps.registerCustom(ai);
    } catch (err) {
      return { ok: false, error: `It could not be set up: ${errorText(err)}` };
    }
    if (!registered) return { ok: false, error: 'An AI with that name is already set up.' };
    if (!this.deps.store.addCustom(ai)) {
      this.deps.log.warn('a custom AI was added but could not be saved; it lasts until the app closes', { id: ai.id });
    }
    this.deps.log.info('custom AI added', { id: ai.id, command: ai.command, args: ai.args.length });
    await this.detectOnly('custom AI added', [ai.id]);
    return { ok: true, ai };
  }

  removeCustom(id: unknown): boolean {
    if (typeof id !== 'string' || !this.deps.store.customAis().some((a) => a.id === id)) return false;
    this.deps.store.removeCustom(id);
    try {
      this.deps.unregisterCustom(id);
    } catch (err) {
      this.deps.log.warn('a custom AI could not be unregistered', { id, error: errorText(err) });
    }
    // A default that named it would fall back on every read and warn about a
    // choice the user just undid; forget the choice instead.
    if (this.deps.store.defaultAi() === id) this.deps.store.setDefaultAi(undefined);
    this.runner.forget(id);
    this.deps.log.info('custom AI removed', { id });
    this.changed();
    return true;
  }

  /** "Test": start it, `initialize`, report, leave nothing running. */
  async testCustom(raw: unknown): Promise<CustomAiTestResult> {
    const c = checkDraft(raw);
    if (!c.ok) return { ok: false, error: c.error, ms: 0 };
    const controller = new AbortController();
    this.inFlight.add(controller);
    try {
      const r = await this.deps.testCommand(
        { command: c.draft.command, args: c.draft.args, ...(c.draft.env ? { env: c.draft.env } : {}) },
        { signal: controller.signal }
      );
      this.deps.log.info('custom AI tested', { command: c.draft.command, ok: r.ok, ms: r.ms, error: r.error });
      return r;
    } catch (err) {
      return { ok: false, error: errorText(err), ms: 0 };
    } finally {
      this.inFlight.delete(controller);
    }
  }

  // ── sign-in ──────────────────────────────────────────────────────────────

  /** Run the AI's OWN sign-in. One at a time per AI. */
  login(providerId: unknown, methodId?: unknown): Promise<AiLoginResult> {
    if (typeof providerId !== 'string') return Promise.resolve({ supported: false, reason: 'Say which AI.' });
    const running = this.logins.get(providerId);
    if (running) return running;
    const p = this.deps.providers().find((x) => x.id === providerId);
    const cap = p?.detect;
    if (!p || !cap?.login) {
      return Promise.resolve({
        supported: false,
        reason: p ? `${p.displayName} signs in on its own; there is nothing to run from here.` : 'That AI is not set up here.',
      });
    }
    const controller = new AbortController();
    this.inFlight.add(controller);
    const login = cap.login.bind(cap);
    const work = (async (): Promise<AiLoginResult> => {
      try {
        // Through a resolved promise, so even a capability that throws
        // SYNCHRONOUSLY settles after `logins.set` below — otherwise its
        // `finally` would delete the entry before it was set, and the settled
        // promise would answer every later press.
        const r = await Promise.resolve().then(() =>
          login(controller.signal, typeof methodId === 'string' && methodId ? methodId : undefined)
        );
        this.deps.log.info('AI sign-in finished', { providerId, ok: r.ok ?? null, supported: r.supported });
        return r;
      } catch (err) {
        return { supported: true, ok: false, reason: errorText(err) };
      } finally {
        this.inFlight.delete(controller);
        this.logins.delete(providerId);
      }
    })();
    this.logins.set(providerId, work);
    void work.then(() => {
      const ids = this.list()
        .filter((i) => i.providerId === providerId)
        .map((i) => i.entry.id);
      return this.detectOnly('after sign-in', ids);
    }).catch(() => undefined);
    return work;
  }

  // ── the registry ─────────────────────────────────────────────────────────

  async checkRegistry(): Promise<RegistryCheckResult> {
    const r = await this.deps.checkRegistry();
    this.deps.log.info('AI registry checked (user pressed)', r.ok ? { added: r.diff.added.length, changed: r.diff.changed.length, removed: r.diff.removed.length } : { error: r.error });
    return r;
  }

  lastRegistryCheck(): RegistryCheckResult | null {
    return this.deps.lastRegistryCheck();
  }

  /**
   * App quit: end everything that started a process — a Test, a sign-in, the
   * startup / Look-again run and any one-AI re-check — so each kills what it
   * started, and start nothing new.
   */
  dispose(): void {
    this.disposed = true;
    for (const c of this.inFlight) c.abort();
    this.inFlight.clear();
    this.runner.abort();
    for (const r of this.narrowRuns) r.abort();
    this.narrowRuns.clear();
  }
}
