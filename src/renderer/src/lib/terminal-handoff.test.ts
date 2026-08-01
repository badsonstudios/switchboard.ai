// #125: what the Session tab says when the CLI keeps a decision for itself.
//
// The rule lives in a pure function so it can be asserted directly — the bug
// this replaces was never that the logic was wrong, it was that the correct
// output was rendered somewhere nobody looks.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { terminalHandoff, toneToken, HandoffTone } from './terminal-handoff';

const inputs = (over: Partial<Parameters<typeof terminalHandoff>[0]> = {}) => ({
  status: undefined,
  hasApproval: false,
  startingLong: false,
  recentlyDecided: false,
  ...over,
});

describe('terminalHandoff', () => {
  it('says nothing when the session is not waiting on us', () => {
    expect(terminalHandoff(inputs({ status: 'working' }))).toBeNull();
    expect(terminalHandoff(inputs({ status: 'idle' }))).toBeNull();
    expect(terminalHandoff(inputs({ status: 'done' }))).toBeNull();
    expect(terminalHandoff(inputs())).toBeNull();
  });

  it('a HELD approval always wins — never send the user away from the answer', () => {
    // The approval bar is already rendering that decision, because the CLI
    // DELEGATED it to us (P7). A "go to the Terminal" bar beside it would push
    // the user away from the very control that answers the question.
    expect(terminalHandoff(inputs({ status: 'needs-permission', hasApproval: true }))).toBeNull();
    expect(terminalHandoff(inputs({ status: 'needs-input', hasApproval: true }))).toBeNull();
    expect(
      terminalHandoff(inputs({ status: 'needs-permission', hasApproval: true, startingLong: true }))
    ).toBeNull();
  });

  it('a permission the CLI KEPT gets the permission bar — the live 2026-07-31 case', () => {
    const h = terminalHandoff(inputs({ status: 'needs-permission' }))!;
    expect(h.tone).toBe('permission');
    expect(h.title).toBe('handoff.permissionTitle');
    expect(h.body).toBe('handoff.permissionBody');
  });

  it('a question the CLI is waiting on gets the input bar', () => {
    const h = terminalHandoff(inputs({ status: 'needs-input' }))!;
    expect(h.tone).toBe('input');
    expect(h.title).toBe('handoff.inputTitle');
  });

  it('a session stuck starting gets the start-up dialog bar', () => {
    const h = terminalHandoff(inputs({ status: 'starting', startingLong: true }))!;
    expect(h.title).toBe('handoff.startingTitle');
  });

  it('an actual question outranks "still starting"', () => {
    // Both can be true at once. "It is asking you something" is the more
    // actionable of the two, and the startup message would send the user
    // looking for a dialog that is no longer the thing on screen.
    const h = terminalHandoff(inputs({ status: 'needs-input', startingLong: true }))!;
    expect(h.title).toBe('handoff.inputTitle');
  });

  it('gives the three cases three distinct headlines', () => {
    const titles = [
      terminalHandoff(inputs({ status: 'needs-permission' }))!.title,
      terminalHandoff(inputs({ status: 'needs-input' }))!.title,
      terminalHandoff(inputs({ status: 'starting', startingLong: true }))!.title,
    ];
    expect(new Set(titles).size).toBe(3);
  });

  it('suppresses itself while an answer is in flight', () => {
    // The queue pops synchronously; `permission-resolved` needs a full IPC
    // round trip. Without this the user sees "switchboard can't answer it for
    // you" in the exact spot they just clicked Allow.
    expect(terminalHandoff(inputs({ status: 'needs-permission', recentlyDecided: true }))).toBeNull();
    expect(terminalHandoff(inputs({ status: 'needs-input', recentlyDecided: true }))).toBeNull();
  });

  it('every tone names theme tokens that ACTUALLY EXIST in every shipped theme', () => {
    // An unresolvable custom property fails silently — the bar would simply
    // lose its colour and nobody would notice until a screenshot (the
    // `--group-lift: none` incident, #102). Assert the real names against the
    // real stylesheet rather than against the TypeScript union, which proves
    // nothing.
    const tokensCss = fs.readFileSync(
      path.join(__dirname, '..', 'theme', 'tokens.css'),
      'utf8'
    );
    const themeDir = path.join(__dirname, '..', 'theme', 'themes');
    const overlays = fs
      .readdirSync(themeDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(themeDir, f), 'utf8')));

    for (const tone of ['permission', 'input'] as HandoffTone[]) {
      const name = toneToken(tone);
      expect(name, `${tone} names a token`).toMatch(/^--status-/);
      // defined in the base presets…
      expect(tokensCss, `${name} missing from tokens.css`).toContain(`${name}:`);
      // …and every overlay that touches status hues must carry it too, or the
      // bar loses its colour on that theme alone
      for (const overlay of overlays) {
        const map = overlay.tokens ?? overlay;
        const touchesStatus = Object.keys(map).some((k) => k.startsWith('--status-'));
        if (touchesStatus) {
          expect(Object.keys(map), `${name} missing from ${overlay.name ?? 'an overlay'}`).toContain(
            name
          );
        }
      }
    }
  });
});
