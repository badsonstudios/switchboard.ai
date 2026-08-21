import { describe, it, expect, beforeAll } from 'vitest';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import {
  AUTONOMIES,
  Autonomy,
  DEFAULT_AUTONOMY,
  autonomyTooltip,
  isAutonomy,
  nextAutonomy,
} from './autonomy';

describe('the autonomy cycle', () => {
  it('wraps through all four in order', () => {
    expect(AUTONOMIES).toEqual(['ask', 'plan', 'auto-edit', 'full-auto']);
    const walk: string[] = [];
    let cur: string = DEFAULT_AUTONOMY;
    for (let i = 0; i < AUTONOMIES.length; i++) {
      cur = nextAutonomy(cur);
      walk.push(cur);
    }
    expect(walk).toEqual(['plan', 'auto-edit', 'full-auto', 'ask']);
  });

  it('starts the walk from the default for a value it does not recognise', () => {
    // a workspace blob outlives the code that wrote it: a mode we retired must
    // not strand the chip on a value no click can leave
    expect(nextAutonomy('yolo')).toBe('plan');
    expect(nextAutonomy(undefined)).toBe('plan');
  });

  it('recognises exactly the four', () => {
    for (const m of AUTONOMIES) expect(isAutonomy(m)).toBe(true);
    for (const junk of ['', 'Ask', 'bypassPermissions', null, 7]) expect(isAutonomy(junk)).toBe(false);
  });
});

describe('the hover copy', () => {
  beforeAll(async () => {
    await initI18nForTests();
  });

  const desc = (m: Autonomy): string => en.autonomy.desc[m];

  it('gives every mode a description and every surface a scope line', () => {
    // the tooltip is assembled from two keys; a mode added without copy would
    // otherwise render its own key path at the user
    for (const m of AUTONOMIES) {
      expect(desc(m), `autonomy.desc.${m}`).toBeTruthy();
      expect(desc(m).length).toBeGreaterThan(40);
    }
    for (const s of ['workspace', 'session', 'badge'] as const) {
      expect(en.autonomy.scope[s], `autonomy.scope.${s}`).toBeTruthy();
    }
  });

  it('is the SAME description on every surface — one source of truth (#534)', () => {
    const t = i18next.t.bind(i18next);
    for (const m of AUTONOMIES) {
      const tips = (['workspace', 'session', 'badge'] as const).map((s) => autonomyTooltip(t, m, s));
      for (const tip of tips) expect(tip).toContain(desc(m));
      // ...and each surface still says what IT does with the mode
      expect(tips[0]).toContain(en.autonomy.scope.workspace);
      expect(tips[1]).toContain(en.autonomy.scope.session);
      expect(tips[2]).toContain(en.autonomy.scope.badge);
      // three distinct tooltips, not one repeated
      expect(new Set(tips).size).toBe(3);
    }
  });

  it('falls back to the default mode rather than rendering a key path', () => {
    const t = i18next.t.bind(i18next);
    expect(autonomyTooltip(t, 'yolo', 'session')).toBe(autonomyTooltip(t, 'ask', 'session'));
    expect(autonomyTooltip(t, undefined, 'session')).toContain(desc('ask'));
  });

  it('separates the two halves with a blank line, which a native title honours', () => {
    const t = i18next.t.bind(i18next);
    expect(autonomyTooltip(t, 'ask', 'workspace').split('\n\n')).toHaveLength(2);
  });

  /**
   * THE CONTRACT ASSERTIONS. These are not style checks — they pin the two
   * claims about the real CLI that #534's suggested copy got wrong, so that a
   * later edit cannot quietly restore a comfortable falsehood.
   *
   * `full-auto` is `--permission-mode bypassPermissions`
   * (`main/providers/claude.ts`), and Anthropic's permission-mode reference
   * says of it: "`bypassPermissions` mode disables permission prompts and
   * safety checks so tool calls execute immediately" and "The
   * `--dangerously-skip-permissions` flag is equivalent." The issue's draft
   * copy said the opposite — that full-auto keeps guardrails and is "not the
   * same as --dangerously-skip-permissions" — which describes the CLI's
   * separate `auto` mode, which we do not use.
   */
  it('tells the truth about full-auto', () => {
    const d = desc('full-auto');
    expect(d).toContain('bypassPermissions');
    expect(d).toContain('--dangerously-skip-permissions');
    expect(d).toContain('deny rules');
    expect(d).not.toContain('sandboxed');
  });

  /**
   * `auto-edit` is `acceptEdits`. What holds the shell line there is OURS, not
   * the CLI's: `acceptEdits` auto-approves `mkdir`, `touch`, `mv`, `cp`, `rm`,
   * `rmdir` and `sed` inside the working directory as well as file edits, and
   * it is the PreToolUse hold policy (`main/hooks/hook-listener.ts`, GATED) that
   * brings every shell call to the user at this profile. So the copy may say
   * commands still come to you — but it must keep saying WHICH things do, and
   * it must not widen that promise to the whole filesystem: reads outside the
   * folder are held here and the sentence that says so is the one users check.
   */
  it('tells the truth about auto-edit', () => {
    const d = desc('auto-edit');
    expect(d).toMatch(/Shell commands/);
    expect(d).toMatch(/outside the folder/);
    // the promise is scoped to the session's folder, never "your files"
    expect(d).toContain("session's folder");
  });
});
