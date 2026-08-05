// #182 - every `check:*` script must have a DECISION: it either runs in CI, or
// it is recorded here and in ci.yml as local-only, with the reason.
//
// This exists because of #164. `check:fake-stream` sat in package.json with no
// CI job for weeks and rotted TWICE - once when #153 made the fake honour the
// requested transport, once when #163 put a thinking block ahead of the text
// one - and neither rot ever produced a red build, because nothing anywhere
// ran the file. The three remaining checks had the identical exposure.
//
// A comment alone would not have prevented that, so this is the enforcement:
// add a check script and you must either wire it into ci.yml or say here why
// you cannot. The one thing you cannot do is nothing.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');

const CI_WORKFLOW = '.github/workflows/ci.yml';

/**
 * Checks that CANNOT run on a GitHub runner, and why. Every one of these drives
 * the real `claude` CLI through a real model turn, so running it in CI would
 * need a subscription login the runner does not have - and the only ways to
 * give it one (an API key, or spending Dan's tokens per PR) are both hard
 * constraints in .claude/CLAUDE.md.
 *
 * The bar for adding an entry here is high on purpose: "needs a real model
 * turn" or "needs interactive login" - never "it is slow" or "it is flaky".
 */
const LOCAL_ONLY: Record<string, string> = {
  'check:adapter':
    'two headless `claude -p` turns (plant a marker, read it back via --resume) - real tokens',
  'check:hooks':
    'a real interactive `claude` session in a PTY, through to a real Write tool call - real tokens',
  'check:transcripts':
    'a real `claude -p` turn, then parses the transcript the CLI wrote - real tokens',
};

/** a `- run: npm run <name>` step, not merely a mention in a comment */
function hasCiStep(workflow: string, script: string): boolean {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*-\\s+run:\\s+npm run ${escaped}\\s*$`, 'm').test(workflow);
}

describe('check:* scripts are all accounted for (#182)', () => {
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  const checks = Object.keys(scripts).filter((s) => s.startsWith('check:'));
  const workflow = read(CI_WORKFLOW);

  it('finds the check scripts at all (guards against the guard silently passing)', () => {
    // If package.json ever stops using the `check:` prefix this whole file
    // would go green over an empty list, which is the failure mode it exists
    // to prevent. Assert the floor: the two that run in CI plus the three that
    // cannot.
    expect(checks.length).toBeGreaterThanOrEqual(5);
  });

  it.each(
    Object.keys(LOCAL_ONLY).map((s) => [s] as const)
  )('%s is declared local-only, so it must NOT have a CI step', (script) => {
    expect(hasCiStep(workflow, script), `${script} runs in CI - drop it from LOCAL_ONLY`).toBe(
      false
    );
  });

  it('every check script either runs in CI or is a documented local-only one', () => {
    const undecided = checks.filter((c) => !hasCiStep(workflow, c) && !(c in LOCAL_ONLY));
    expect(
      undecided,
      `these check scripts run nowhere and have no recorded reason - wire them into ${CI_WORKFLOW} ` +
        'or add them to LOCAL_ONLY with why (#182)'
    ).toEqual([]);
  });

  it('every check script runs its bundle through scripts/run-electron-node.js (#298)', () => {
    // That runner is where the stale-bundle guard lives, and it is the ONLY
    // place it lives - deliberately, because five package.json wirings are five
    // chances to forget and the forgotten one is the one that rots (this file's
    // whole reason for existing). A check that shells out to `electron` itself,
    // or to plain `node`, would silently run an unguarded bundle.
    const bypassing = checks.filter(
      (c) => !/\bnode scripts\/run-electron-node\.js\s+out\//.test(scripts[c])
    );
    expect(
      bypassing,
      'these run an out/ bundle without the #298 guard - route them through ' +
        'scripts/run-electron-node.js, or move the guard first'
    ).toEqual([]);
  });

  it('LOCAL_ONLY has no STALE entries', () => {
    // The other direction, as in broker.test.ts: an exemption left behind after
    // the script it excused was deleted or renamed reads like a decision and is
    // not one.
    const stale = Object.keys(LOCAL_ONLY).filter((s) => !checks.includes(s));
    expect(stale, 'exempted but no longer a script').toEqual([]);
  });

  it('the local-only decision is written in the workflow too, not just here', () => {
    // The issue asks for the reason to be visible where someone edits CI, so a
    // future reader wondering "why is check:hooks not here?" finds the answer
    // without grepping the test suite.
    const missing = Object.keys(LOCAL_ONLY).filter((s) => !workflow.includes(s));
    expect(missing, `not explained in ${CI_WORKFLOW}`).toEqual([]);
  });

  it('every local-only entry carries an actual reason', () => {
    const empty = Object.entries(LOCAL_ONLY)
      .filter(([, why]) => why.trim().length < 20)
      .map(([s]) => s);
    expect(empty, 'local-only needs a real justification, not a placeholder').toEqual([]);
  });
});
