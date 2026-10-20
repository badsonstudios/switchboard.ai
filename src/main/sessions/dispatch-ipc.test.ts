// The window's side of a manual dispatch (P2-E13-03, §5.15, #948).
//
// Same house contract as `delivery-ipc.test.ts`: stand-in collaborators, because
// the claim under test is what each handler DECIDES — and a refusal is a value
// back plus a line in the log, never a throw.
//
// Four properties carry this item and each one is asserted against a plausible
// wrong implementation rather than merely exercised:
//
//  * NO TEMPLATE OBJECT CROSSES IPC. #946's `isSaneRoleTemplate` refuses the
//    `builtin:` namespace, so a channel that took an object could only validate it
//    with a predicate that rejects the three templates a fresh install has. The
//    test pins that `prepare` resolves from an ID and that a built-in works.
//  * THE LIST IS DEDUPED IN MAIN. A duplicate id is reachable only by hand-editing
//    `workspace.json`, and the cost lands at the surface as a React `key`
//    collision. Fixed here so every surface inherits it.
//  * THE BRIEFING IS SINGLE USE. A `dispatchId` lives in a dockview panel param,
//    which is re-sent on every remount — so `consume` is what stops a reviewer
//    being briefed twice mid-conversation.
//  * A REFUSAL NAMES ITS OWN REASON. Keys, not sentences, and the right key.
import { describe, it, expect, vi } from 'vitest';
import {
  registerDispatchIpc,
  DISPATCH_TTL_MS,
  MAX_EXPIRED_DISPATCHES,
  LOGIN_WAIT_MS,
  MAX_PENDING_DISPATCHES,
  OPTIONS_LOGIN_WAIT_MS,
} from './dispatch-ipc';
import type { DispatchContextDeps } from './dispatch-context';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import {
  BUILT_IN_TEMPLATES,
  isSaneRoleTemplate,
  type RoleTemplate,
} from '../../shared/dispatch';
import type { DispatchAiLogin, DispatchOptions, DispatchPrepared } from '../../shared/dispatch-wire';
import { SessionQueries, type DiffSource, type SessionSummary } from './queries';
import en from '../../shared/i18n/locales/en.json';

type Handler = (e: unknown, ...args: unknown[]) => unknown;

const AUTHOR = 'sess-author';
const REVIEWER_ID = BUILT_IN_TEMPLATES[0].id;

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: AUTHOR,
  name: 'TradingApp',
  folder: 'C:/Projects/TradingApp',
  providerId: 'claude-code',
  status: 'working',
  exited: false,
  ...over,
});

const A_DIFF = ['diff --git a/x.ts b/x.ts', '-const a = 1;', '+const a = 2;'].join('\n');
const git: DiffSource = { diff: async () => ({ isRepo: true, text: A_DIFF }) };

const userTemplate = (over: Partial<RoleTemplate> = {}): RoleTemplate => ({
  id: 'mine-1',
  name: 'Security review',
  rolePrompt: 'Look for injection.',
  autonomy: 'plan',
  contextPolicy: 'clean-room',
  workspacePolicy: 'same-folder',
  ...over,
});

function harness(
  opts: {
    templates?: RoleTemplate[];
    sessions?: SessionSummary[];
    transcript?: string | null;
    fork?: boolean;
    conversationId?: string | null;
    provider?: string;
    /** a repo with nothing uncommitted — one half of an empty briefing */
    cleanTree?: boolean;
    /** what `taskStatementOf` answers, per session id */
    tasks?: Record<string, string>;
    /** the registered AIs (#1296); default Claude, plus `provider` when it names another */
    providers?: Array<{ id: string; name: string }>;
    /** each AI's login answer; absent = no `loginStateOf` dep at all */
    logins?: Record<string, DispatchAiLogin | 'throw' | 'hang' | 'slow-out'>;
    /** the TTL override (#1378's e2e seam) */
    ttlMs?: number;
  } = {}
) {
  const handlers = new Map<string, Handler>();
  const loginAsks: string[] = [];
  const logs: { level: string; msg: string; fields?: LogFields }[] = [];
  const broker = {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
  } as unknown as IpcBroker;
  const record =
    (level: string) =>
    (msg: string, fields?: LogFields): void =>
      void logs.push({ level, msg, fields });
  const log: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
  };
  const contextDeps: DispatchContextDeps = {
    queries: new SessionQueries({
      list: () => opts.sessions ?? [session()],
      transcriptFor: () => opts.transcript ?? null,
      git: opts.cleanTree ? { diff: async () => ({ isRepo: true, text: '' }) } : git,
    }),
    experimentalFork: () => opts.fork === true,
    conversationIdFor: () => opts.conversationId ?? null,
  };
  const registry = registerDispatchIpc({
    broker,
    log,
    listTemplates: () => opts.templates ?? [],
    contextDeps,
    // ANSWERS PER ID, so the `dispatch:options` guard is actually exercised. Review
    // found the first version returned `undefined` for everything, which made the
    // "a bad session id costs the task default" test pass against an implementation
    // that ignored the guard entirely.
    taskStatementOf: (id) => opts.tasks?.[id],
    experimentalFork: () => opts.fork === true,
    ...(opts.ttlMs === undefined ? {} : { ttlMs: opts.ttlMs }),
    providers: () =>
      opts.providers ?? [
        { id: 'claude-code', name: 'Claude Code' },
        ...(opts.provider && opts.provider !== 'claude-code' ? [{ id: opts.provider, name: opts.provider }] : []),
      ],
    ...(opts.logins === undefined
      ? {}
      : {
          loginStateOf: (id: string) => {
            loginAsks.push(id);
            const v = opts.logins![id];
            if (v === 'throw') return Promise.reject(new Error('login check exploded'));
            if (v === 'hang') return new Promise<never>(() => {});
            // a COLD check: answers logged-out after a second, as Codex's ~1.6 s does
            if (v === 'slow-out')
              return new Promise<DispatchAiLogin>((r) => setTimeout(() => r('logged-out'), 1_000));
            return Promise.resolve(v ?? 'unknown');
          },
        }),
  });
  const call = (channel: string, ...args: unknown[]): unknown => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(null, ...args);
  };
  const options = (id = AUTHOR): Promise<DispatchOptions> =>
    call('dispatch:options', id) as Promise<DispatchOptions>;
  const prepare = (req: unknown): Promise<DispatchPrepared> =>
    call('dispatch:prepare', req) as Promise<DispatchPrepared>;
  return { call, options, prepare, registry, logs, handlers, loginAsks };
}

/** The `ok: true` half, or a failure with the refusal in the message. */
async function prepared(
  h: ReturnType<typeof harness>,
  req: Record<string, unknown> = { from: AUTHOR, templateId: REVIEWER_ID }
): Promise<DispatchPrepared & { ok: true }> {
  const answer = await h.prepare(req);
  if (!answer.ok) throw new Error(`prepare refused: ${answer.reason}`);
  return answer;
}

describe('dispatch:options', () => {
  it('offers the three built-ins first, then the user\u2019s', async () => {
    const { options } = harness({ templates: [userTemplate()] });
    const names = (await options()).templates.map((x) => x.name);
    expect(names.slice(0, 3)).toEqual(BUILT_IN_TEMPLATES.map((t) => t.name));
    expect(names[3]).toBe('Security review');
  });

  it('marks which are built-in, and carries each one\u2019s policies', async () => {
    const { options } = harness({ templates: [userTemplate()] });
    const rows = (await options()).templates;
    expect(rows.filter((x) => x.builtIn)).toHaveLength(3);
    expect(rows.find((x) => x.id === 'mine-1')?.builtIn).toBe(false);
    const reviewer = rows.find((x) => x.id === REVIEWER_ID)!;
    expect(reviewer.contextPolicy).toBe('clean-room');
    expect(reviewer.autonomy).toBe('plan');
  });

  it('⚠️ never hands out a rolePrompt — a menu row does not need one', async () => {
    const { options } = harness({ templates: [userTemplate()] });
    for (const row of (await options()).templates) {
      expect(row).not.toHaveProperty('rolePrompt');
    }
  });

  it('⚠️ DEDUPES BY ID, and says so — a React key cannot collide', async () => {
    // Reachable only by hand-editing `workspace.json`: `keepSane` does not dedupe,
    // deliberately and consistently with the other five persisted lists. The cost
    // is at the surface, so the fix is here.
    const { options, logs } = harness({
      templates: [userTemplate({ name: 'First' }), userTemplate({ name: 'Second' })],
    });
    const rows = (await options()).templates;
    expect(rows.filter((x) => x.id === 'mine-1')).toHaveLength(1);
    // FIRST WINS, matching `upsertDispatchTemplate`'s own `findIndex` — so the row
    // the user sees is the row an edit would actually change.
    expect(rows.find((x) => x.id === 'mine-1')?.name).toBe('First');
    expect(logs.some((l) => l.msg.includes('duplicate dispatch template id'))).toBe(true);
  });

  it('greys out a `full` template while the fork flag is off, with a key that exists', async () => {
    const { options } = harness({ templates: [userTemplate({ contextPolicy: 'full' })] });
    const row = (await options()).templates.find((x) => x.id === 'mine-1')!;
    expect(row.refusalKey).toBe('dispatch.refusal.fullContext');
    // A KEY, NOT A SENTENCE (§5.21), and one the catalogue actually has — the
    // failure this catches is a renderer printing the key itself on screen.
    expect(en.dispatch.refusal.fullContext).toBeTruthy();
  });

  it('...and stops greying it out when the flag is on', async () => {
    const { options } = harness({
      templates: [userTemplate({ contextPolicy: 'full' })],
      fork: true,
    });
    expect((await options()).templates.find((x) => x.id === 'mine-1')?.refusalKey).toBeUndefined();
  });

  it('refuses a Phase 3 workspace policy with its own reason', async () => {
    const { options } = harness({
      templates: [userTemplate({ workspacePolicy: 'fresh-worktree' })],
    });
    expect((await options()).templates.find((x) => x.id === 'mine-1')?.refusalKey).toBe(
      'dispatch.refusal.freshWorktree'
    );
  });

  it('hands back the author’s opening prompt as the task default', async () => {
    // The field the dialog prefills, and the whole reason a dispatch has a task
    // line at all. Read through the SAME query the bundle would have used, so the
    // prefill and the fallback cannot describe different text.
    const { options } = harness({ tasks: { [AUTHOR]: 'do it.' } });
    expect((await options()).taskStatement).toBe('do it.');
  });

  it('omits a task default that is only whitespace', async () => {
    // `''` and `'   '` both mean "nothing was recorded", and an absent field is what
    // leaves the dialog's box empty rather than pre-filled with three spaces the
    // user then has to notice and delete.
    // Built from char codes rather than written as escapes: this file is read back
    // by tooling that treats a literal control byte as a binary file.
    const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
    for (const blank of ['', '   ', CRLF + String.fromCharCode(9)]) {
      const { options } = harness({ tasks: { [AUTHOR]: blank } });
      expect((await options()).taskStatement, JSON.stringify(blank)).toBeUndefined();
    }
  });

  it('never refuses — a bad session id costs the task default and nothing else', async () => {
    // The GUARD is what this pins: with a real `taskStatementOf` behind it, an
    // implementation that passed a non-string straight through would answer the
    // author's task for `null` or `42`. Asserted against a harness that WOULD have
    // answered, which the first version of this test could not claim.
    const { call, options } = harness({ templates: [userTemplate()], tasks: { [AUTHOR]: 'do it.' } });
    expect((await options()).taskStatement).toBe('do it.'); // it really does answer
    for (const bad of [undefined, null, 42, '']) {
      const answer = (await call('dispatch:options', bad)) as DispatchOptions;
      expect(answer.templates.length, JSON.stringify(bad)).toBe(4);
      expect(answer.taskStatement, JSON.stringify(bad)).toBeUndefined();
      // …and the folder goes the same way, for the same reason.
      expect(answer.folder, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('says where a dispatch would run, from the SAME resolve prepare uses (#949)', async () => {
    // ⚠️ THE POINT IS THAT IT IS ONE ANSWER. The renderer knows a folder for the
    // card it opened the dialog from; showing that one would be a second
    // description of a fact `prepare` settles a moment later, and the one on
    // screen would be the one that spawned nothing. Pinned by comparing the two.
    const h = harness();
    expect((await h.options()).folder).toBe('C:/Projects/TradingApp');
    expect((await prepared(h)).folder).toBe((await h.options()).folder);
  });

  it('omits the folder when the session does not resolve', async () => {
    const { options } = harness({ sessions: [] });
    expect((await options()).folder).toBeUndefined();
    // Still every template, because this channel never refuses.
    expect((await options()).templates).toHaveLength(3);
  });
});

describe('dispatch:prepare', () => {
  it('resolves the template from its ID and prepares a briefing', async () => {
    const h = harness();
    const answer = await prepared(h);
    expect(answer.dispatchId).toMatch(/[0-9a-f-]{36}/);
    expect(answer.folder).toBe('C:/Projects/TradingApp');
    expect(answer.templateName).toBe('Code Reviewer');
  });

  it('⚠️ WORKS FOR A BUILT-IN, which `isSaneRoleTemplate` would have refused', async () => {
    // #946's contract, as a test: the predicate that guards the workspace file
    // says NO to every built-in, so a channel that accepted template objects and
    // validated them with it would refuse the three templates a new install has.
    // Passing an id and resolving with `templateById` is what makes this pass.
    expect(isSaneRoleTemplate(BUILT_IN_TEMPLATES[0])).toBe(false);
    const h = harness();
    await expect(prepared(h, { from: AUTHOR, templateId: REVIEWER_ID })).resolves.toBeTruthy();
  });

  it('refuses an unknown template id rather than guessing at one', async () => {
    const h = harness();
    const answer = await h.prepare({ from: AUTHOR, templateId: 'builtin:not-a-thing' });
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reason).toContain('no such template');
  });

  it('validates its input and refuses, never throws (§5.29)', async () => {
    const h = harness();
    for (const bad of [
      undefined,
      null,
      'a string',
      { templateId: REVIEWER_ID },
      { from: '', templateId: REVIEWER_ID },
      { from: AUTHOR },
      { from: AUTHOR, templateId: '' },
      { from: AUTHOR, templateId: REVIEWER_ID, taskStatement: 5 },
      { from: AUTHOR, templateId: REVIEWER_ID, acceptanceCriteria: {} },
    ]) {
      const answer = await h.prepare(bad);
      expect(answer.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('re-asks the policy refusal rather than trusting the list\u2019s snapshot', async () => {
    // `DispatchGates.forkEnabled` warns that the failure mode is a CACHED `true` —
    // a row offered while the flag was on and clicked after it was turned off.
    const h = harness({ templates: [userTemplate({ contextPolicy: 'full' })] });
    const answer = await h.prepare({ from: AUTHOR, templateId: 'mine-1' });
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reasonKey).toBe('dispatch.refusal.fullContext');
  });

  it('forwards #947\u2019s own refusal keys — a fork with no conversation to adopt', async () => {
    const h = harness({
      templates: [userTemplate({ contextPolicy: 'full' })],
      fork: true,
      conversationId: null,
    });
    const answer = await h.prepare({ from: AUTHOR, templateId: 'mine-1' });
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reasonKey).toBe('dispatch.refusal.noConversation');
  });

  it('a `full` dispatch across providers is refused (§5.5: formats are not interchangeable)', async () => {
    const h = harness({
      templates: [userTemplate({ contextPolicy: 'full' })],
      fork: true,
      conversationId: '11111111-2222-3333-4444-555555555555',
      provider: 'some-other-cli',
    });
    // The target is now the user's pick (#1296), not a dep pinned to the default.
    const answer = await h.prepare({ from: AUTHOR, templateId: 'mine-1', targetProviderId: 'some-other-cli' });
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reasonKey).toBe('dispatch.refusal.crossProviderFork');
  });

  it('⚠️ SUCCEEDS with an empty briefing, and says so in the log', async () => {
    // A clean tree and no transcript: there is nothing to hand over, and the
    // dispatch still goes — the bundle prints its own sentences for each of those
    // facts (#947) and a reviewer told "the tree is clean" can say so. But the
    // dialog shows no size (see `dispatch-wire.ts`), so the log is the only place
    // "the reviewer had nothing to review" is recorded — and that is the first
    // question to ask about a dispatch that came back with nothing.
    const h = harness({ transcript: null, cleanTree: true });
    await expect(prepared(h)).resolves.toBeTruthy();
    expect(h.logs.some((l) => l.msg.includes('empty briefing'))).toBe(true);
  });

  it('does not claim empty when there IS a diff', async () => {
    const h = harness({ transcript: null });
    await prepared(h);
    expect(h.logs.some((l) => l.msg.includes('empty briefing'))).toBe(false);
  });
});

describe('the pending registry', () => {
  it('⚠️ IS SINGLE USE — a remounted card cannot be briefed twice', async () => {
    const h = harness();
    const { dispatchId } = await prepared(h);
    expect(h.registry.peek(dispatchId)).toBeTruthy();
    h.registry.consume(dispatchId);
    // The panel param survives the spawn and arrives again on every remount; this
    // is the line that makes a second briefing impossible rather than unlikely.
    expect(h.registry.peek(dispatchId)).toBeUndefined();
  });

  it('peeks as often as asked — every refusal between the read and the spawn', async () => {
    // `sessions:create` reads this several times (the fork operand, the autonomy,
    // the accent) before it commits, and several things in between can still
    // refuse. A consuming read would eat the briefing on each of those paths.
    const h = harness();
    const { dispatchId } = await prepared(h);
    expect(h.registry.peek(dispatchId)).toBeTruthy();
    expect(h.registry.peek(dispatchId)).toBeTruthy();
    expect(h.registry.peek(dispatchId)?.template.id).toBe(REVIEWER_ID);
  });

  it('holds the TEMPLATE, not its id — one dispatch is decided at one moment', async () => {
    // Re-resolving at spawn time would let a template be edited between the dialog
    // and the spawn, producing a session briefed one way and instructed another.
    const h = harness({ templates: [userTemplate()] });
    const { dispatchId } = await prepared(h, { from: AUTHOR, templateId: 'mine-1' });
    const held = h.registry.peek(dispatchId)!;
    expect(held.template.rolePrompt).toBe('Look for injection.');
    expect(held.from).toBe(AUTHOR);
    expect(held.folder).toBe('C:/Projects/TradingApp');
  });

  it('ignores a rubbish id rather than throwing on the spawn path', async () => {
    const h = harness();
    for (const bad of [undefined, null, 42, '', 'not-an-id']) {
      expect(h.registry.peek(bad)).toBeUndefined();
      expect(() => h.registry.consume(bad)).not.toThrow();
    }
  });

  it('expires, and says so — a param can arrive on a later launch', async () => {
    const h = harness();
    const { dispatchId } = await prepared(h);
    const held = h.registry.peek(dispatchId)!;
    // Reach into the held entry's age rather than faking timers: the property is
    // "older than the TTL is gone", and mutating `at` states exactly that.
    (held as { at: number }).at = Date.now() - DISPATCH_TTL_MS - 1;
    expect(h.registry.peek(dispatchId)).toBeUndefined();
    expect(h.logs.some((l) => l.msg.includes('expired before its card started'))).toBe(true);
  });

  it('is bounded — oldest out first, so a loop of prepares cannot grow for ever', async () => {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_DISPATCHES + 3; i++) {
      ids.push((await prepared(h)).dispatchId);
    }
    // The first three are gone; the newest — the one a user is about to spawn — is
    // never the one dropped.
    expect(h.registry.peek(ids[0])).toBeUndefined();
    expect(h.registry.peek(ids[ids.length - 1])).toBeTruthy();
    expect(h.logs.some((l) => l.msg.includes('stay under the cap'))).toBe(true);
  });
});

// ── AN EXPIRED BRIEFING IS REMEMBERED AS EXPIRED (#1378) ─────────────────────
//
// Expiry drops the briefing; without a record of it, an expired id reads exactly
// like one main never held (a relaunch), and `sessions:create` fails THAT open —
// so a card dispatched to a chosen AI quietly became an unbriefed session on the
// default one. The registry keeps a tombstone: enough to name what was lost.
describe('expired briefings (#1378)', () => {
  const expire = (h: ReturnType<typeof harness>, id: string): void => {
    (h.registry.peek(id) as { at: number }).at = Date.now() - DISPATCH_TTL_MS - 1;
  };

  it('a live briefing is not "expired"', async () => {
    const h = harness();
    const { dispatchId } = await prepared(h);
    expect(h.registry.expired(dispatchId)).toBeUndefined();
  });

  it('once past its TTL it says WHICH AI, WHICH role and WHO sent it — and keeps saying so', async () => {
    const two = [
      { id: 'claude-code', name: 'Claude Code' },
      { id: 'codex', name: 'Codex' },
    ];
    const h = harness({ providers: two });
    const { dispatchId } = await prepared(h, {
      from: AUTHOR,
      templateId: REVIEWER_ID,
      targetProviderId: 'codex',
    });
    expect(h.registry.peek(dispatchId)?.fromName).toBe('TradingApp');
    expire(h, dispatchId);
    const gone = h.registry.expired(dispatchId);
    expect(gone).toMatchObject({
      from: AUTHOR,
      fromName: 'TradingApp',
      providerId: 'codex',
      providerName: 'Codex',
      templateId: REVIEWER_ID,
      templateName: BUILT_IN_TEMPLATES[0].name,
    });
    // the briefing itself is gone, and NOT kept in the tombstone
    expect(h.registry.peek(dispatchId)).toBeUndefined();
    expect(JSON.stringify(gone)).not.toContain('const a = 2');
    // not consuming: every Try again gets the same answer
    expect(h.registry.expired(dispatchId)).toEqual(gone);
    // the existing expiry line is still logged, once
    expect(h.logs.filter((l) => l.msg.includes('expired before its card started'))).toHaveLength(1);
  });

  it('notices an expiry nobody has read yet — `expired` asks before `peek` ever did', async () => {
    const h = harness();
    const { dispatchId } = await prepared(h);
    expire(h, dispatchId);
    // no peek in between: the entry is still in the pending map, past its TTL
    expect(h.registry.expired(dispatchId)?.templateId).toBe(REVIEWER_ID);
  });

  it('a SPENT briefing is not expired — that card started and was briefed', async () => {
    const h = harness();
    const { dispatchId } = await prepared(h);
    h.registry.consume(dispatchId);
    expect(h.registry.expired(dispatchId)).toBeUndefined();
  });

  it('an id it never held is not expired — that is the relaunch case, fail-open by design', () => {
    const h = harness();
    for (const id of ['never-held', '', undefined, 42]) expect(h.registry.expired(id)).toBeUndefined();
  });

  it('a briefing EVICTED by the cap is as gone as an expired one', async () => {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_DISPATCHES + 1; i++) ids.push((await prepared(h)).dispatchId);
    expect(h.registry.peek(ids[0])).toBeUndefined();
    expect(h.registry.expired(ids[0])?.templateId).toBe(REVIEWER_ID);
  });

  it('the tombstones are bounded too', async () => {
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < MAX_EXPIRED_DISPATCHES + 2; i++) {
      const { dispatchId } = await prepared(h);
      expire(h, dispatchId);
      h.registry.peek(dispatchId);
      ids.push(dispatchId);
    }
    expect(h.registry.expired(ids[0])).toBeUndefined();
    expect(h.registry.expired(ids[ids.length - 1])).toBeTruthy();
  });

  it('honours the TTL override (the e2e seam), and ignores a nonsense one', async () => {
    const short = harness({ ttlMs: 1 });
    const a = (await prepared(short)).dispatchId;
    // 2 ms old: past a 1 ms lifetime, nowhere near the real 15 minutes
    (short.registry.peek(a) as { at: number }).at = Date.now() - 2;
    expect(short.registry.peek(a)).toBeUndefined();
    expect(short.registry.expired(a)).toBeTruthy();

    const bogus = harness({ ttlMs: -5 });
    const b = (await prepared(bogus)).dispatchId;
    // the same 2 ms: a nonsense override falls back to the real lifetime
    (bogus.registry.peek(b) as { at: number }).at = Date.now() - 2;
    expect(bogus.registry.peek(b)).toBeTruthy();
  });
});

// ── "RUN IT ON" (E40 item 13, #1296) ─────────────────────────────────────────
//
// The dispatch chooses its AI: the user's pick, else the author's own. The
// claims that a plausible wrong implementation gets wrong:
//  * a target that is not registered is REFUSED, never swapped for the default;
//  * only a DEFINITE logged-out refuses — `unknown` (and a check that throws or
//    hangs) goes ahead, because our login check failing must not block a dispatch;
//  * the author's own AI is never asked about, and nothing is asked at all for
//    the palette's session-less read at app mount.
describe('Run it on (#1296)', () => {
  const two = [
    { id: 'claude-code', name: 'Claude Code' },
    { id: 'codex', name: 'Codex' },
  ];

  it('lists every registered AI with its login, and names the author’s own', async () => {
    const h = harness({ providers: two, logins: { codex: 'logged-out' } });
    const o = await h.options();
    expect(o.currentAi).toBe('claude-code');
    expect(o.ais).toEqual([
      { id: 'claude-code', name: 'Claude Code', login: 'unknown' },
      { id: 'codex', name: 'Codex', login: 'logged-out' },
    ]);
    // the author's own AI is running a session right now; it is not asked
    expect(h.loginAsks).toEqual(['codex']);
  });

  it('asks about NO logins for a session-less read (the palette at app mount)', async () => {
    const h = harness({ providers: two, logins: { codex: 'logged-in' } });
    const o = (await h.call('dispatch:options', '')) as DispatchOptions;
    expect(o.ais?.map((a) => a.login)).toEqual(['unknown', 'unknown']);
    expect(o.currentAi).toBeUndefined();
    expect(h.loginAsks).toEqual([]);
  });

  it('a login check that throws, or never answers, reads as `unknown` (fail-open)', async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        providers: [...two, { id: 'gemini', name: 'Gemini CLI' }],
        logins: { codex: 'throw', gemini: 'hang' },
      });
      const pending = h.options();
      await vi.advanceTimersByTimeAsync(LOGIN_WAIT_MS + 10);
      const o = await pending;
      expect(o.ais?.map((a) => [a.id, a.login])).toEqual([
        ['claude-code', 'unknown'],
        ['codex', 'unknown'],
        ['gemini', 'unknown'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⚠️ the dialog does NOT wait for a cold login check — prepare does, and still refuses', async () => {
    // Review: a menu click that did nothing for ~1.6 s read as broken. So options
    // waits only long enough for a cached answer; prepare waits the full bound,
    // behind the dialog's own "Preparing…" state.
    vi.useFakeTimers();
    try {
      const h = harness({ providers: two, logins: { codex: 'slow-out' } });
      const opening = h.options();
      await vi.advanceTimersByTimeAsync(OPTIONS_LOGIN_WAIT_MS + 10);
      expect((await opening).ais?.find((a) => a.id === 'codex')?.login).toBe('unknown');
      const going = h.prepare({ from: AUTHOR, templateId: REVIEWER_ID, targetProviderId: 'codex' });
      await vi.advanceTimersByTimeAsync(1_100);
      const answer = await going;
      expect(answer.ok === false && answer.reasonKey).toBe('dispatch.refusal.aiLoggedOut');
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries a template’s preferred AI to the dialog', async () => {
    const h = harness({ providers: two, templates: [userTemplate({ preferredProviderId: 'codex' })] });
    const row = (await h.options()).templates.find((x) => x.id === 'mine-1')!;
    expect(row.preferredProviderId).toBe('codex');
    // …and the built-ins carry none
    for (const b of (await h.options()).templates.filter((x) => x.builtIn)) {
      expect(b).not.toHaveProperty('preferredProviderId');
    }
  });

  it('prepares onto the chosen AI, and the pending dispatch carries it', async () => {
    const h = harness({ providers: two, logins: { codex: 'logged-in' } });
    const answer = await prepared(h, { from: AUTHOR, templateId: REVIEWER_ID, targetProviderId: 'codex' });
    expect(h.registry.peek(answer.dispatchId)?.providerId).toBe('codex');
  });

  it('#1318: keeps the chosen AI’s NAME, so a card can say which AI went missing', async () => {
    // A "Something else" AI removed before the spawn takes its name out of the
    // catalog with it; the pending dispatch is the one place still holding it.
    const custom = [...two, { id: 'custom:local-llama', name: 'Local Llama' }];
    const h = harness({ providers: custom, logins: { 'custom:local-llama': 'logged-in' } });
    const answer = await prepared(h, {
      from: AUTHOR,
      templateId: REVIEWER_ID,
      targetProviderId: 'custom:local-llama',
    });
    expect(h.registry.peek(answer.dispatchId)?.providerName).toBe('Local Llama');
  });

  it('with no target named, runs on the AUTHOR’S own AI', async () => {
    const h = harness({
      providers: [
        { id: 'codex', name: 'Codex' },
        { id: 'claude-code', name: 'Claude Code' },
      ],
    });
    // Codex is FIRST (the "default"); the author is on Claude — the author wins.
    const answer = await prepared(h);
    expect(h.registry.peek(answer.dispatchId)?.providerId).toBe('claude-code');
  });

  it('⚠️ REFUSES a target that is not registered — never the default instead', async () => {
    const h = harness({ providers: two });
    const answer = await h.prepare({ from: AUTHOR, templateId: REVIEWER_ID, targetProviderId: 'gemini' });
    expect(answer.ok).toBe(false);
    expect(answer.ok === false && answer.reasonKey).toBe('dispatch.refusal.aiMissing');
    expect(en.dispatch.refusal.aiMissing).toBeTruthy();
  });

  it('REFUSES a target that is definitely logged out', async () => {
    const h = harness({ providers: two, logins: { codex: 'logged-out' } });
    const answer = await h.prepare({ from: AUTHOR, templateId: REVIEWER_ID, targetProviderId: 'codex' });
    expect(answer.ok === false && answer.reasonKey).toBe('dispatch.refusal.aiLoggedOut');
    expect(en.dispatch.refusal.aiLoggedOut).toBeTruthy();
  });

  it('goes ahead when the login is `unknown`', async () => {
    const h = harness({ providers: two, logins: {} });
    await expect(
      prepared(h, { from: AUTHOR, templateId: REVIEWER_ID, targetProviderId: 'codex' })
    ).resolves.toBeTruthy();
  });

  it('refuses a malformed target id at the door (§5.29)', async () => {
    const h = harness({ providers: two });
    for (const bad of [42, '', 'has space', 'x'.repeat(101)]) {
      const answer = await h.prepare({ from: AUTHOR, templateId: REVIEWER_ID, targetProviderId: bad });
      expect(answer.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a `full` dispatch onto ANOTHER AI is refused (the fork gate reads the real target)', async () => {
    const h = harness({
      providers: two,
      templates: [userTemplate({ contextPolicy: 'full' })],
      fork: true,
      conversationId: '11111111-2222-3333-4444-555555555555',
    });
    const answer = await h.prepare({ from: AUTHOR, templateId: 'mine-1', targetProviderId: 'codex' });
    expect(answer.ok === false && answer.reasonKey).toBe('dispatch.refusal.crossProviderFork');
    // …and onto the SAME AI it goes
    await expect(
      prepared(h, { from: AUTHOR, templateId: 'mine-1', targetProviderId: 'claude-code' })
    ).resolves.toBeTruthy();
  });
});
