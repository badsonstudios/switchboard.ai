import { describe, it, expect, beforeAll } from 'vitest';
import i18next from 'i18next';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import {
  AUTONOMIES,
  Autonomy,
  DEFAULT_AUTONOMY,
  allowAllTooltip,
  autonomyLabel,
  autonomyDescription,
  autonomyTooltip,
  isAutonomy,
  PARAGRAPH,
} from './autonomy';

describe('the four modes', () => {
  it('are listed in this order, starting at the default (the mode menu reads it, #1462)', () => {
    expect(AUTONOMIES).toEqual(['ask', 'plan', 'auto-edit', 'full-auto']);
    expect(AUTONOMIES[0]).toBe(DEFAULT_AUTONOMY);
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

  it('gives every mode a description and the shield button its scope line', () => {
    // the tooltip is assembled from two keys; a mode added without copy would
    // otherwise render its own key path at the user
    for (const m of AUTONOMIES) {
      expect(desc(m), `autonomy.desc.${m}`).toBeTruthy();
      expect(desc(m).length).toBeGreaterThan(40);
    }
    expect(en.autonomy.scope.session).toBeTruthy();
    // the title-bar chip's line went with the chip (#1434), and the card
    // header badge's with the badge (#1490)
    expect('workspace' in en.autonomy.scope).toBe(false);
    expect('badge' in en.autonomy.scope).toBe(false);
    expect('howBadge' in en.autonomy.allowAll).toBe(false);
  });

  it("is the mode's description, then what the shield button does with it (#534)", () => {
    const t = i18next.t.bind(i18next);
    for (const m of AUTONOMIES) {
      const tip = autonomyTooltip(t, m);
      expect(tip).toContain(desc(m));
      expect(tip).toContain(en.autonomy.scope.session);
    }
  });

  it('falls back to the default mode rather than rendering a key path', () => {
    const t = i18next.t.bind(i18next);
    expect(autonomyTooltip(t, 'yolo')).toBe(autonomyTooltip(t, 'ask'));
    expect(autonomyTooltip(t, undefined)).toContain(desc('ask'));
  });

  it('separates the two halves with a blank line, which a native title honours', () => {
    const t = i18next.t.bind(i18next);
    expect(autonomyTooltip(t, 'ask').split(PARAGRAPH)).toHaveLength(2);
  });

  it("the menu rows' description is the tooltip's first half, and only that (#1462)", () => {
    const t = i18next.t.bind(i18next);
    for (const m of AUTONOMIES) {
      for (const claude of [false, true]) {
        const d = autonomyDescription(t, m, claude);
        expect(autonomyTooltip(t, m, claude).split(PARAGRAPH)[0]).toBe(d);
        expect(d).not.toContain(en.autonomy.scope.session);
      }
    }
    expect(autonomyDescription(t, 'yolo')).toBe(desc('ask'));
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
  //
  // SINCE #1316 the Claude Code half lives in `autonomy.claude.*` and is added
  // only when the AI is Claude — the mode's own sentence is AI-neutral. The
  // contract is pinned on the tooltip a Claude session actually shows.
  const claudeTip = (m: Autonomy): string => autonomyTooltip(i18next.t.bind(i18next), m, true);

  it('tells the truth about full-auto', () => {
    const d = claudeTip('full-auto');
    expect(d).toContain('bypassPermissions');
    expect(d).toContain('--dangerously-skip-permissions');
    expect(d).toContain('deny rules');
    expect(d).not.toContain('sandboxed');
  });

  /**
   * ⚠️ THIS COPY WAS WRONG FROM THE MOMENT #952 LANDED, AND THIS TEST WAS PINNING
   * IT. Both are corrected here, and the history is the point.
   *
   * `auto-edit` is `acceptEdits`. The old copy promised *"Shell commands, web
   * fetches, and reading anything outside the folder still come to you"*, and
   * that was true — but what held those was OURS, not the CLI's: `acceptEdits`
   * auto-approves `mkdir`, `touch`, `mv`, `cp`, `rm`, `rmdir` and `sed` inside
   * the working directory as well as file edits, and it was the PreToolUse hold
   * policy (`GATED` in the old `hooks/hook-listener.ts`) that brought every shell
   * call to the user at this profile.
   *
   * That policy rode on the PTY transport and went with it. The CLI's own
   * behaviour is now the whole behaviour, so the tooltip must describe
   * `acceptEdits` as it really is — and must NOT keep a promise switchboard can
   * no longer keep, because this is the string a user reads before deciding how
   * much rope to give an agent.
   *
   * The assertions below are the new contract: name the commands that DO get
   * waved through, keep the folder scoping, and point at `ask` for anyone who
   * wanted the old behaviour.
   */
  it('tells the truth about auto-edit', () => {
    const d = claudeTip('auto-edit');
    // it must NOT re-promise the deleted hold policy
    expect(d).not.toMatch(/Shell commands[^.]*still come to you/);
    // it must NAME what acceptEdits really waves through
    expect(d).toContain('mkdir');
    expect(d).toContain('acceptEdits');
    // ...and point at the mode that still stops for everything
    expect(d).toMatch(/use ask/);
    // the promise is scoped to the session's folder, never "your files"
    expect(d).toContain("session's folder");
  });

  /**
   * `ask` lost a clause in the same change, for the same reason: it promised
   * that reading anything OUTSIDE the session's folder came to you, which was
   * `READ_GATED_AUTONOMIES` and is gone.
   *
   * ⚠️ AND "EVERY TOOL CALL STOPS" WAS ITSELF FALSE, which this test used to
   * pin (#1434). Ask is the CLI's `default` permission mode, and that honours the allow rules in the user's Claude Code
   * settings before Switchboard is consulted — on Dan's machine Read, Write
   * and Edit were pre-allowed in switchboard.ai's own project settings, so ask
   * never asked about a file change there. That is correct CLI behaviour and
   * stays (host-don't-reimplement); the copy is what changed.
   */
  it('tells the truth about ask', () => {
    const d = desc('ask');
    expect(d).not.toMatch(/every tool call comes to you/i);
    expect(d).toContain("settings don't already allow");
    expect(d).not.toMatch(/outside the session's folder/);
    // on Claude it names the settings files, and promises not to touch them
    const c = claudeTip('ask');
    expect(c).toContain("everything your Claude Code settings don't already allow");
    expect(c).toContain('.claude/settings.json');
    expect(c).toContain('never changes those files');
  });
});

describe('the Claude Code half is said only to Claude (#1316)', () => {
  beforeAll(async () => {
    await initI18nForTests();
  });

  it('another AI hears the AI-neutral sentence, with no Claude in it', () => {
    const t = i18next.t.bind(i18next);
    for (const m of AUTONOMIES) {
      expect(autonomyTooltip(t, m)).not.toMatch(/claude|anthropic/i);
      expect(autonomyTooltip(t, m, false)).not.toMatch(/claude|anthropic/i);
    }
  });

  it('Claude hears the same sentence, then what Claude Code does with it', () => {
    const t = i18next.t.bind(i18next);
    // every mode since #1434 — ask's Claude half is that the allow rules apply
    for (const m of AUTONOMIES) {
      const tip = autonomyTooltip(t, m, true);
      expect(tip).toContain(en.autonomy.desc[m]);
      expect(tip).toContain(en.autonomy.claude[m]);
    }
  });

  it("says Claude cannot switch mid-flight only to Claude — it is about the chip's click", () => {
    const t = i18next.t.bind(i18next);
    expect(autonomyTooltip(t, 'ask', true)).toContain(en.autonomy.claude.session);
    expect(autonomyTooltip(t, 'ask', false)).not.toContain(en.autonomy.claude.session);
  });
});

describe('allow-all, said on the label (#1434)', () => {
  beforeAll(async () => {
    await initI18nForTests();
  });

  it('a session that will auto-allow everything never reads plain ask', () => {
    const t = i18next.t.bind(i18next);
    expect(autonomyLabel(t, 'ask', false)).toBe(en.autonomy.ask);
    expect(autonomyLabel(t, 'ask', true)).toBe('🛡 ask · allow all');
    expect(autonomyLabel(t, 'plan', true)).toBe('🛡 plan · allow all');
    // full-auto asks nothing anyway; "full-auto · allow all" would be noise
    expect(autonomyLabel(t, 'full-auto', true)).toBe(en.autonomy['full-auto']);
    // an unknown stored value is the default, allow-all or not
    expect(autonomyLabel(t, 'yolo', true)).toBe('🛡 ask · allow all');
  });

  it('the tooltip says since when, that it lasts until restart, and counts the files', () => {
    const t = i18next.t.bind(i18next);
    const at = Date.UTC(2026, 9, 23, 14, 2);
    const tip = allowAllTooltip(t, { allowAllSince: at, files: ['a'] });
    expect(tip).toContain(new Date(at).toLocaleTimeString(i18next.language, { timeStyle: 'short' }));
    expect(tip).toContain('until the session restarts');
    expect(tip).toContain(en.autonomy.allowAll.howSession);
    expect(tip).toContain('1 file is also always allowed');
    // no files: no count at all, not "0 files"
    expect(allowAllTooltip(t, { allowAllSince: at, files: [] })).not.toMatch(/files? (is|are) also/);
    // no time known: says so without inventing one
    expect(allowAllTooltip(t, { files: [] })).toContain(en.autonomy.allowAll.sinceUnknown);
  });
});
