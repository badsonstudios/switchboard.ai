// Role templates — the model (P2-E13-01, §5.15).
//
// Pure data and pure functions, so every case here is a table test. What is
// actually being pinned, in order of how much it would cost to get wrong:
//
//   1. The context policy maps to a context source in ONE place, totally.
//      #947 builds against that record; a second mapping is how `briefed` starts
//      meaning two things.
//   2. A built-in cannot be mutated — not by convention, but because there is no
//      storable value whose id resolves to one.
//   3. An unsupported policy is REFUSED with a reason, never silently degraded.
//      The whole point of #949's scope call.
import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_ID_PREFIX,
  BUILT_IN_TEMPLATES,
  CONTEXT_POLICIES,
  CONTEXT_SOURCE,
  CONTEXT_SOURCES,
  DEFAULT_WORKSPACE_POLICY,
  ROLE_PROMPT_CHAR_CAP,
  RoleTemplate,
  TEMPLATE_ID_CHAR_CAP,
  TEMPLATE_NAME_CHAR_CAP,
  WORKSPACE_POLICIES,
  allTemplates,
  contextPolicyRefusalKey,
  copyOfBuiltIn,
  isBuiltInTemplateId,
  isContextPolicy,
  isSaneRoleTemplate,
  isWorkspacePolicy,
  templateById,
  templateRefusalKey,
  workspacePolicyRefusalKey,
} from './dispatch';
import { AUTONOMY_MODES } from './sessions';
import { ACCENTS } from './accents';
import en from './i18n/locales/en.json';

/**
 * The English behind a catalogue key, read out of `en.json` the way i18next
 * would — so a key that does not resolve reads as an empty string here rather
 * than as a test that quietly asserts nothing.
 */
function sentence(key: string): string {
  const found = key
    .split('.')
    .reduce<unknown>((node, k) => (node as Record<string, unknown>)?.[k], en);
  return typeof found === 'string' ? found : '';
}

/** A minimal valid user template. Each test mutates the one field it is about. */
function userTemplate(over: Partial<RoleTemplate> = {}): RoleTemplate {
  return {
    id: 'u1',
    name: 'My reviewer',
    rolePrompt: 'Review it.',
    autonomy: 'ask',
    contextPolicy: 'clean-room',
    workspacePolicy: 'same-folder',
    ...over,
  };
}

describe('the vocabularies', () => {
  it('offers exactly the three context amounts §5.15 names', () => {
    expect([...CONTEXT_POLICIES]).toEqual(['clean-room', 'briefed', 'full']);
  });

  it('offers exactly the three workspace policies §5.15 names', () => {
    // All three declared even though v1 carries out one — the alternative is
    // changing this type in Phase 3 and re-deciding what a stored template with
    // the missing value meant.
    expect([...WORKSPACE_POLICIES]).toEqual(['same-folder', 'fresh-worktree', 'fresh-clone']);
  });

  it('ships same-folder as the default', () => {
    expect(DEFAULT_WORKSPACE_POLICY).toBe('same-folder');
    expect(workspacePolicyRefusalKey(DEFAULT_WORKSPACE_POLICY)).toBeUndefined();
  });

  it('accepts its own values and nothing else', () => {
    for (const p of CONTEXT_POLICIES) expect(isContextPolicy(p)).toBe(true);
    for (const p of WORKSPACE_POLICIES) expect(isWorkspacePolicy(p)).toBe(true);
    for (const junk of ['', 'Clean-Room', 'cleanroom', 'worktree', 42, null, undefined, {}]) {
      expect(isContextPolicy(junk)).toBe(false);
      expect(isWorkspacePolicy(junk)).toBe(false);
    }
  });
});

describe('a context policy becomes a context source in exactly one place', () => {
  it('maps every policy, with nothing left over', () => {
    // ⚠️ THE DONE-WHEN'S SECOND BULLET. `Record<ContextPolicy, …>` makes the
    // table total at compile time; this pins the VALUES, so a policy quietly
    // repointed at another source fails here rather than in a dispatched
    // session that got the wrong amount of somebody's work.
    expect(CONTEXT_SOURCE).toEqual({
      'clean-room': 'artifact-bundle',
      briefed: 'context-package',
      full: 'fork-adoption',
    });
  });

  it('names a real source for each', () => {
    for (const p of CONTEXT_POLICIES) expect(CONTEXT_SOURCES).toContain(CONTEXT_SOURCE[p]);
  });

  it('gives each policy a source of its own', () => {
    // Three policies, three sources. If two policies ever shared one, the
    // distinction the user is choosing between would not exist in the plumbing.
    const sources = CONTEXT_POLICIES.map((p) => CONTEXT_SOURCE[p]);
    expect(new Set(sources).size).toBe(CONTEXT_POLICIES.length);
  });
});

describe('the three built-ins', () => {
  it('are Code Reviewer, Doc Writer and PR Author, in that order', () => {
    expect(BUILT_IN_TEMPLATES.map((t) => t.name)).toEqual([
      'Code Reviewer',
      'Doc Writer',
      'PR Author',
    ]);
  });

  it('carry §5.15’s context amounts: clean-room for review, briefed for writing', () => {
    const by = (name: string) => BUILT_IN_TEMPLATES.find((t) => t.name === name)!;
    expect(by('Code Reviewer').contextPolicy).toBe('clean-room');
    expect(by('Doc Writer').contextPolicy).toBe('briefed');
    expect(by('PR Author').contextPolicy).toBe('briefed');
  });

  it('are all dispatchable in v1 — no built-in is born refused', () => {
    // A built-in defaulting to `fresh-worktree` because §5.15 prefers it for
    // review would ship three templates the app cannot run.
    for (const t of BUILT_IN_TEMPLATES) expect(templateRefusalKey(t)).toBeUndefined();
  });

  it('use the app’s own autonomy vocabulary, at the quiet end', () => {
    for (const t of BUILT_IN_TEMPLATES) expect(AUTONOMY_MODES).toContain(t.autonomy);
    // The reviewer must not touch the tree, and `plan`'s write block is the
    // CLI's own — the one nothing in-app can Allow past (§5.16's plan-mode rule).
    expect(BUILT_IN_TEMPLATES.find((t) => t.name === 'Code Reviewer')!.autonomy).toBe('plan');
    // Nothing unattended arrives allowed to run commands on its own.
    for (const t of BUILT_IN_TEMPLATES) expect(t.autonomy).not.toBe('full-auto');
  });

  it('paint themselves from the §5.11 palette, not from invented hex', () => {
    const palette = ACCENTS.map((a) => a.value);
    for (const t of BUILT_IN_TEMPLATES) expect(palette).toContain(t.accentColor);
  });

  it('are visually distinct from each other', () => {
    const colours = BUILT_IN_TEMPLATES.map((t) => t.accentColor);
    expect(new Set(colours).size).toBe(BUILT_IN_TEMPLATES.length);
  });

  it('say something — an empty role prompt is legal but not shipped', () => {
    for (const t of BUILT_IN_TEMPLATES) expect(t.rolePrompt.trim().length).toBeGreaterThan(40);
  });

  it('all live in the reserved id namespace', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      expect(t.id.startsWith(BUILT_IN_ID_PREFIX)).toBe(true);
      expect(isBuiltInTemplateId(t.id)).toBe(true);
    }
    expect(new Set(BUILT_IN_TEMPLATES.map((t) => t.id)).size).toBe(BUILT_IN_TEMPLATES.length);
  });

  it('cannot be mutated through the reference every caller is handed', () => {
    // ⚠️ `readonly RoleTemplate[]` freezes the SLOTS, not the objects, and
    // `allTemplates`/`templateById` hand the constants out by reference — so one
    // `templateById(id, user)!.autonomy = 'full-auto'` in a later item would
    // change the built-in for the rest of the process. Frozen, under ESM's strict
    // mode, that throws instead of silently succeeding.
    const built = templateById(BUILT_IN_TEMPLATES[0].id, [])!;
    expect(() => {
      (built as { autonomy: string }).autonomy = 'full-auto';
    }).toThrow(TypeError);
    expect(BUILT_IN_TEMPLATES[0].autonomy).toBe('plan');
    // And the array itself: no pushing a fourth built-in in at runtime.
    expect(() => (BUILT_IN_TEMPLATES as RoleTemplate[]).push(userTemplate())).toThrow(TypeError);
  });

  it('would themselves fail the USER-template predicate, and that is the point', () => {
    // Not a flaw in the predicate — the predicate guards the workspace file, and
    // a built-in has no business being in it. This is the assertion that makes
    // "they are code, not user data" mechanical.
    for (const t of BUILT_IN_TEMPLATES) expect(isSaneRoleTemplate(t)).toBe(false);
  });
});

describe('reading a template out of an untrusted file', () => {
  it('accepts a well-formed user template', () => {
    expect(isSaneRoleTemplate(userTemplate())).toBe(true);
  });

  it('accepts an empty role prompt — a half-written template is storable', () => {
    // The `isSaneRule` precedent: an editor needs to save work in progress.
    expect(isSaneRoleTemplate(userTemplate({ rolePrompt: '' }))).toBe(true);
  });

  it('refuses anything that is not a template-shaped object', () => {
    for (const junk of [null, undefined, 'x', 7, [], [userTemplate()]]) {
      expect(isSaneRoleTemplate(junk)).toBe(false);
    }
  });

  it('refuses a missing or empty id, and a nameless template', () => {
    expect(isSaneRoleTemplate(userTemplate({ id: '' }))).toBe(false);
    expect(isSaneRoleTemplate({ ...userTemplate(), id: undefined })).toBe(false);
    expect(isSaneRoleTemplate(userTemplate({ name: '   ' }))).toBe(false);
    expect(isSaneRoleTemplate({ ...userTemplate(), name: undefined })).toBe(false);
  });

  it('refuses a built-in id — the structural half of "the built-in is not mutated"', () => {
    // ⚠️ There is no storable value whose id resolves to a built-in, so
    // `templateById` can answer from code first and never be shadowed.
    for (const t of BUILT_IN_TEMPLATES) {
      expect(isSaneRoleTemplate({ ...userTemplate(), id: t.id })).toBe(false);
    }
    // The whole NAMESPACE, not just the three that exist — a build shipping a
    // fourth built-in must not find a user template squatting on its id.
    expect(isSaneRoleTemplate(userTemplate({ id: `${BUILT_IN_ID_PREFIX}whatever` }))).toBe(false);
  });

  it('refuses an autonomy this build does not know', () => {
    for (const m of AUTONOMY_MODES) {
      expect(isSaneRoleTemplate(userTemplate({ autonomy: m }))).toBe(true);
    }
    expect(isSaneRoleTemplate({ ...userTemplate(), autonomy: 'yolo' })).toBe(false);
    expect(isSaneRoleTemplate({ ...userTemplate(), autonomy: undefined })).toBe(false);
  });

  it('refuses a policy this build does not know', () => {
    expect(isSaneRoleTemplate({ ...userTemplate(), contextPolicy: 'some-day' })).toBe(false);
    expect(isSaneRoleTemplate({ ...userTemplate(), workspacePolicy: 'fresh-vm' })).toBe(false);
  });

  it('ACCEPTS a policy v1 cannot carry out — storable is not dispatchable', () => {
    // Deliberate: a `fresh-worktree` template loads and round-trips, and the
    // refusal happens at dispatch where there is somewhere to show the reason.
    const t = userTemplate({ workspacePolicy: 'fresh-worktree' });
    expect(isSaneRoleTemplate(t)).toBe(true);
    expect(templateRefusalKey(t)).toBeTruthy();
  });

  it('refuses a prompt, name or id past the sanity bound', () => {
    expect(isSaneRoleTemplate(userTemplate({ rolePrompt: 'x'.repeat(ROLE_PROMPT_CHAR_CAP) }))).toBe(
      true
    );
    expect(
      isSaneRoleTemplate(userTemplate({ rolePrompt: 'x'.repeat(ROLE_PROMPT_CHAR_CAP + 1) }))
    ).toBe(false);
    expect(isSaneRoleTemplate(userTemplate({ name: 'x'.repeat(TEMPLATE_NAME_CHAR_CAP + 1) }))).toBe(
      false
    );
    // The id is the one field no surface shows, so an uncapped one grows
    // workspace.json with nothing on screen to explain it.
    expect(isSaneRoleTemplate(userTemplate({ id: 'x'.repeat(TEMPLATE_ID_CHAR_CAP + 1) }))).toBe(
      false
    );
  });

  it('refuses an accent that is not a colour, but allows none at all', () => {
    // This value is PAINTED — it reaches the rail the way `identity.accentColor`
    // does — and in #948 it arrives over IPC from a template editor. The
    // vocabulary is checked here, not trusted there (§5.29).
    expect(isSaneRoleTemplate(userTemplate({ accentColor: undefined }))).toBe(true);
    for (const c of ACCENTS) expect(isSaneRoleTemplate(userTemplate({ accentColor: c.value }))).toBe(true);
    expect(isSaneRoleTemplate({ ...userTemplate(), accentColor: 0x123456 })).toBe(false);
    for (const junk of ['red', '#ff', '#ffff', 'var(--accent-teal)', '#12345g', '#123456; x']) {
      expect(isSaneRoleTemplate(userTemplate({ accentColor: junk }))).toBe(false);
    }
  });
});

describe('declared and refused, never silently degraded', () => {
  it('refuses both Phase 3 workspace policies, with a reason a user can act on', () => {
    // ⚠️ #949's scope call, and the sharpest reason in the epic: telling a
    // reviewer it has an isolated checkout while it runs tests in the author's
    // live tree is the surprise §5.7's isolation caveat exists to prevent.
    for (const p of ['fresh-worktree', 'fresh-clone'] as const) {
      const key = workspacePolicyRefusalKey(p);
      expect(key).toBeTruthy();
      // Says what to do instead, not just that it cannot.
      expect(sentence(key!).toLowerCase()).toContain('same folder');
    }
  });

  it('refuses the full context amount — it needs forking, which is experimental', () => {
    const key = contextPolicyRefusalKey('full');
    expect(key).toBeTruthy();
    expect(sentence(key!).toLowerCase()).toContain('briefed');
  });

  it('names a catalogue key that resolves, not a hardcoded sentence', () => {
    // ⚠️ §5.21: no hardcoded user-visible strings, ever. i18next returns the KEY
    // when it cannot resolve one, so a typo here ships `dispatch.refusal.foo` to
    // the user — which is exactly the class #471 spent an issue removing.
    for (const key of [
      ...WORKSPACE_POLICIES.map(workspacePolicyRefusalKey),
      ...CONTEXT_POLICIES.map(contextPolicyRefusalKey),
    ]) {
      if (key === undefined) continue;
      expect(key).toMatch(/^dispatch\.refusal\./);
      expect(sentence(key).length, `${key} is not in en.json`).toBeGreaterThan(20);
    }
  });

  it('refuses nothing that v1 actually builds', () => {
    expect(contextPolicyRefusalKey('clean-room')).toBeUndefined();
    expect(contextPolicyRefusalKey('briefed')).toBeUndefined();
    expect(workspacePolicyRefusalKey('same-folder')).toBeUndefined();
  });

  it('reports the context refusal first when a template manages both', () => {
    // One sentence is what a menu row has space for; the second reason is one
    // click away once the first is fixed.
    const t = userTemplate({ contextPolicy: 'full', workspacePolicy: 'fresh-clone' });
    expect(templateRefusalKey(t)).toBe(contextPolicyRefusalKey('full'));
  });

  it('passes a template both policies allow', () => {
    expect(templateRefusalKey(userTemplate())).toBeUndefined();
  });
});

describe('the list on offer', () => {
  it('puts the built-ins first, then the user’s', () => {
    const mine = [userTemplate({ id: 'a' }), userTemplate({ id: 'b' })];
    expect(allTemplates(mine).map((t) => t.id)).toEqual([
      ...BUILT_IN_TEMPLATES.map((t) => t.id),
      'a',
      'b',
    ]);
  });

  it('is the built-in three on a fresh install', () => {
    expect(allTemplates([])).toHaveLength(BUILT_IN_TEMPLATES.length);
  });

  it('finds a template by id from either half', () => {
    const mine = [userTemplate({ id: 'a' })];
    expect(templateById('a', mine)?.id).toBe('a');
    expect(templateById(BUILT_IN_TEMPLATES[0].id, mine)?.name).toBe('Code Reviewer');
    expect(templateById('nope', mine)).toBeUndefined();
  });
});

describe('editing a built-in gives you a copy', () => {
  it('copies every field, under a new id and name', () => {
    const src = BUILT_IN_TEMPLATES[0];
    const copy = copyOfBuiltIn(src.id, { id: 'mine', name: 'My reviewer' })!;
    expect(copy).toEqual({ ...src, id: 'mine', name: 'My reviewer' });
    // And the copy is storable, which is the only reason to make one.
    expect(isSaneRoleTemplate(copy)).toBe(true);
  });

  it('leaves the built-in alone', () => {
    // ⚠️ THE DONE-WHEN'S FIRST BULLET. The built-in is a constant, so there is
    // nothing to mutate — but a copy that shared a reference would make that
    // untrue the first time somebody edited a field in place.
    const before = JSON.stringify(BUILT_IN_TEMPLATES[0]);
    const copy = copyOfBuiltIn(BUILT_IN_TEMPLATES[0].id, { id: 'mine', name: 'Mine' })!;
    copy.rolePrompt = 'something else';
    copy.autonomy = 'full-auto';
    expect(JSON.stringify(BUILT_IN_TEMPLATES[0])).toBe(before);
  });

  it('refuses an id that is not a built-in', () => {
    // So a caller cannot deep-copy a user template into a second user template
    // and call it a fork of a built-in.
    expect(copyOfBuiltIn('u1', { id: 'x', name: 'x' })).toBeUndefined();
    expect(copyOfBuiltIn(`${BUILT_IN_ID_PREFIX}nope`, { id: 'x', name: 'x' })).toBeUndefined();
  });
});
