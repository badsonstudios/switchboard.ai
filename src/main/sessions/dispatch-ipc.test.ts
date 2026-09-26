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
import { describe, it, expect } from 'vitest';
import { registerDispatchIpc, DISPATCH_TTL_MS, MAX_PENDING_DISPATCHES } from './dispatch-ipc';
import type { DispatchContextDeps } from './dispatch-context';
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import {
  BUILT_IN_TEMPLATES,
  isSaneRoleTemplate,
  type RoleTemplate,
} from '../../shared/dispatch';
import type { DispatchOptions, DispatchPrepared } from '../../shared/dispatch-wire';
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
  } = {}
) {
  const handlers = new Map<string, Handler>();
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
    targetProviderId: () => opts.provider ?? 'claude-code',
  });
  const call = (channel: string, ...args: unknown[]): unknown => {
    const h = handlers.get(channel);
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(null, ...args);
  };
  const options = (id = AUTHOR): DispatchOptions => call('dispatch:options', id) as DispatchOptions;
  const prepare = (req: unknown): Promise<DispatchPrepared> =>
    call('dispatch:prepare', req) as Promise<DispatchPrepared>;
  return { call, options, prepare, registry, logs, handlers };
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
  it('offers the three built-ins first, then the user\u2019s', () => {
    const { options } = harness({ templates: [userTemplate()] });
    const names = options().templates.map((x) => x.name);
    expect(names.slice(0, 3)).toEqual(BUILT_IN_TEMPLATES.map((t) => t.name));
    expect(names[3]).toBe('Security review');
  });

  it('marks which are built-in, and carries each one\u2019s policies', () => {
    const { options } = harness({ templates: [userTemplate()] });
    const rows = options().templates;
    expect(rows.filter((x) => x.builtIn)).toHaveLength(3);
    expect(rows.find((x) => x.id === 'mine-1')?.builtIn).toBe(false);
    const reviewer = rows.find((x) => x.id === REVIEWER_ID)!;
    expect(reviewer.contextPolicy).toBe('clean-room');
    expect(reviewer.autonomy).toBe('plan');
  });

  it('⚠️ never hands out a rolePrompt — a menu row does not need one', () => {
    const { options } = harness({ templates: [userTemplate()] });
    for (const row of options().templates) {
      expect(row).not.toHaveProperty('rolePrompt');
    }
  });

  it('⚠️ DEDUPES BY ID, and says so — a React key cannot collide', () => {
    // Reachable only by hand-editing `workspace.json`: `keepSane` does not dedupe,
    // deliberately and consistently with the other five persisted lists. The cost
    // is at the surface, so the fix is here.
    const { options, logs } = harness({
      templates: [userTemplate({ name: 'First' }), userTemplate({ name: 'Second' })],
    });
    const rows = options().templates;
    expect(rows.filter((x) => x.id === 'mine-1')).toHaveLength(1);
    // FIRST WINS, matching `upsertDispatchTemplate`'s own `findIndex` — so the row
    // the user sees is the row an edit would actually change.
    expect(rows.find((x) => x.id === 'mine-1')?.name).toBe('First');
    expect(logs.some((l) => l.msg.includes('duplicate dispatch template id'))).toBe(true);
  });

  it('greys out a `full` template while the fork flag is off, with a key that exists', () => {
    const { options } = harness({ templates: [userTemplate({ contextPolicy: 'full' })] });
    const row = options().templates.find((x) => x.id === 'mine-1')!;
    expect(row.refusalKey).toBe('dispatch.refusal.fullContext');
    // A KEY, NOT A SENTENCE (§5.21), and one the catalogue actually has — the
    // failure this catches is a renderer printing the key itself on screen.
    expect(en.dispatch.refusal.fullContext).toBeTruthy();
  });

  it('...and stops greying it out when the flag is on', () => {
    const { options } = harness({
      templates: [userTemplate({ contextPolicy: 'full' })],
      fork: true,
    });
    expect(options().templates.find((x) => x.id === 'mine-1')?.refusalKey).toBeUndefined();
  });

  it('refuses a Phase 3 workspace policy with its own reason', () => {
    const { options } = harness({
      templates: [userTemplate({ workspacePolicy: 'fresh-worktree' })],
    });
    expect(options().templates.find((x) => x.id === 'mine-1')?.refusalKey).toBe(
      'dispatch.refusal.freshWorktree'
    );
  });

  it('hands back the author’s opening prompt as the task default', () => {
    // The field the dialog prefills, and the whole reason a dispatch has a task
    // line at all. Read through the SAME query the bundle would have used, so the
    // prefill and the fallback cannot describe different text.
    const { options } = harness({ tasks: { [AUTHOR]: 'do it.' } });
    expect(options().taskStatement).toBe('do it.');
  });

  it('omits a task default that is only whitespace', () => {
    // `''` and `'   '` both mean "nothing was recorded", and an absent field is what
    // leaves the dialog's box empty rather than pre-filled with three spaces the
    // user then has to notice and delete.
    // Built from char codes rather than written as escapes: this file is read back
    // by tooling that treats a literal control byte as a binary file.
    const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
    for (const blank of ['', '   ', CRLF + String.fromCharCode(9)]) {
      const { options } = harness({ tasks: { [AUTHOR]: blank } });
      expect(options().taskStatement, JSON.stringify(blank)).toBeUndefined();
    }
  });

  it('never refuses — a bad session id costs the task default and nothing else', () => {
    // The GUARD is what this pins: with a real `taskStatementOf` behind it, an
    // implementation that passed a non-string straight through would answer the
    // author's task for `null` or `42`. Asserted against a harness that WOULD have
    // answered, which the first version of this test could not claim.
    const { call, options } = harness({ templates: [userTemplate()], tasks: { [AUTHOR]: 'do it.' } });
    expect(options().taskStatement).toBe('do it.'); // it really does answer
    for (const bad of [undefined, null, 42, '']) {
      const answer = call('dispatch:options', bad) as DispatchOptions;
      expect(answer.templates.length, JSON.stringify(bad)).toBe(4);
      expect(answer.taskStatement, JSON.stringify(bad)).toBeUndefined();
    }
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
    const answer = await h.prepare({ from: AUTHOR, templateId: 'mine-1' });
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
