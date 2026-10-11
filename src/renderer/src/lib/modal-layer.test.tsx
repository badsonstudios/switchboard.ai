// @vitest-environment jsdom
// Only the top modal is modal (#1020).
//
// Three things are pinned here. The stack's own rules. That a real pair of the
// app's dialogs, stacked, leaves exactly one of them `aria-modal` and makes
// the other inert. And, by reading the source, that every component which
// writes `aria-modal` takes its answer from the stack: the rule is only worth
// having if the next dialog somebody adds cannot skip it.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import {
  isModalOpen,
  isTopModalLayer,
  MODAL_LIFT_STEP,
  modalDepth,
  modalLift,
  pushModalLayer,
  resetModalLayersForTest,
  useModalLayer,
} from './modal-layer';
import { initI18nForTests } from '../i18n/test-i18n';
import { AboutPanel } from '../components/AboutPanel';
import { PerfSummaryPanel } from '../components/PerfSummaryPanel';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

beforeEach(() => {
  resetModalLayersForTest();
});

describe('the stack', () => {
  it('one modal is the top one; a second takes the top; closing it gives the top back', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    expect(isModalOpen()).toBe(false);
    const closeA = pushModalLayer(a, document);
    expect(isTopModalLayer(a)).toBe(true);
    const closeB = pushModalLayer(b, document);
    expect(isTopModalLayer(a)).toBe(false);
    expect(isTopModalLayer(b)).toBe(true);
    expect(modalDepth()).toBe(2);
    closeB();
    expect(isTopModalLayer(a)).toBe(true);
    closeA();
    expect(isModalOpen()).toBe(false);
  });

  it('the one BENEATH can close first, and the top stays the top', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    const closeA = pushModalLayer(a, document);
    const closeB = pushModalLayer(b, document);
    closeA();
    expect(isTopModalLayer(b)).toBe(true);
    expect(modalDepth()).toBe(1);
    // closing twice is harmless
    closeA();
    closeB();
    closeB();
    expect(modalDepth()).toBe(0);
  });

  it('⚠️ PER DOCUMENT: a dialog in a popped-out window is not beneath one in the main window', () => {
    const popout = document.implementation.createHTMLDocument('popout');
    const main = Symbol('main');
    const there = Symbol('there');
    pushModalLayer(main, document);
    pushModalLayer(there, popout);
    // each is the top of its own window
    expect(isTopModalLayer(main)).toBe(true);
    expect(isTopModalLayer(there)).toBe(true);
    expect(isModalOpen(document)).toBe(true);
    expect(isModalOpen(popout)).toBe(true);
    expect(modalDepth(popout)).toBe(1);
  });

  it('a modal that has not registered yet reads as the top: it is the newest thing on screen', () => {
    pushModalLayer(Symbol('older'), document);
    expect(isTopModalLayer(Symbol('not registered yet'))).toBe(true);
  });

  it('⚠️ PAINT ORDER FOLLOWS THE STACK: each modal is lifted above every one open before it', () => {
    // The dialogs carry fixed layer numbers (50, 51, 60). Left to those, the
    // one DRAWN on top and the one that is MODAL could be different dialogs,
    // and the visible one was then inert: dead, and dismissed by one click.
    const first = Symbol('first');
    const second = Symbol('second');
    const third = Symbol('third');
    pushModalLayer(first, document);
    const closeSecond = pushModalLayer(second, document);
    pushModalLayer(third, document);
    expect([first, second, third].map((id) => modalLift(id))).toEqual([0, MODAL_LIFT_STEP, 2 * MODAL_LIFT_STEP]);
    // one step is more than the whole spread of the dialogs' own numbers
    expect(MODAL_LIFT_STEP).toBeGreaterThan(60 - 50);
    // the one in the middle closes: the top comes down a step, and stays above the first
    closeSecond();
    expect(modalLift(third)).toBe(MODAL_LIFT_STEP);
    // about to open: above everything that is already there
    expect(modalLift(Symbol('opening'))).toBe(2 * MODAL_LIFT_STEP);
    // a popped-out window's dialogs do not lift this window's
    const popout = document.implementation.createHTMLDocument('popout');
    pushModalLayer(Symbol('there'), popout);
    expect(modalLift(Symbol('opening here'))).toBe(2 * MODAL_LIFT_STEP);
    expect(modalLift(Symbol('opening there'), popout)).toBe(MODAL_LIFT_STEP);
  });
});

describe('two of the app’s dialogs, stacked', () => {
  let root: Root;
  let host: HTMLElement;
  beforeAll(async () => {
    await initI18nForTests();
  });
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  function Probe(props: { name: string; open: boolean }): React.JSX.Element | null {
    const { top, lift } = useModalLayer(props.open);
    if (!props.open) return null;
    return (
      <div
        role="dialog"
        data-probe={props.name}
        data-lift={lift}
        aria-modal={top ? 'true' : undefined}
        inert={!top}
      />
    );
  }
  const modalOnes = (): Element[] => [...host.querySelectorAll('[aria-modal="true"]')];
  const probe = (name: string): HTMLElement => host.querySelector<HTMLElement>(`[data-probe="${name}"]`)!;

  it('exactly ONE is aria-modal, and the one beneath is inert until it is on top again', async () => {
    const render = async (lower: boolean, upper: boolean): Promise<void> => {
      await act(async () => {
        root.render(
          <>
            <Probe name="lower" open={lower} />
            <Probe name="upper" open={upper} />
          </>
        );
      });
    };
    await render(true, false);
    expect(modalOnes()).toEqual([probe('lower')]);
    expect(probe('lower').hasAttribute('inert')).toBe(false);

    await render(true, true);
    expect(modalOnes()).toEqual([probe('upper')]);
    expect(probe('lower').hasAttribute('inert')).toBe(true);
    expect(probe('lower').hasAttribute('aria-modal')).toBe(false);
    // ...and the one that is modal is the one drawn on top
    expect(Number(probe('upper').dataset.lift)).toBeGreaterThan(Number(probe('lower').dataset.lift));

    await render(true, false);
    expect(modalOnes()).toEqual([probe('lower')]);
    expect(probe('lower').hasAttribute('inert')).toBe(false);
    expect(modalDepth()).toBe(1);

    await render(false, false);
    expect(isModalOpen()).toBe(false);
  });

  it('the real ones: About under the performance summary, a pair that used a hand-kept list', async () => {
    // `dialogAbove` used to be passed to each from a list of the OTHER dialogs'
    // flags, kept by hand in two places that had already drifted apart
    await act(async () => {
      root.render(
        <>
          <AboutPanel
            open
            onClose={() => undefined}
            version="0.0.0"
            identity={{ sha: 'abc1234', branch: 'main', dirty: false, builtAt: '2026-10-11T00:00:00Z' } as never}
            platform="win32"
          />
          <PerfSummaryPanel open onClose={() => undefined} summary={null} />
        </>
      );
    });
    const dialogs = [...host.querySelectorAll<HTMLElement>('[role="dialog"]')];
    expect(dialogs).toHaveLength(2);
    expect(modalOnes()).toHaveLength(1);
    // the later one is on top; the earlier one is out of reach beneath it
    expect(dialogs[1].getAttribute('aria-modal')).toBe('true');
    expect(dialogs[0].hasAttribute('inert')).toBe(true);
    expect(dialogs[1].hasAttribute('inert')).toBe(false);
  });
});

describe('every dialog takes its answer from the stack', () => {
  const SRC = path.join(__dirname, '..');
  const NL = String.fromCharCode(10);

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) sources(full, out);
      else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) out.push(full);
    }
    return out;
  }
  /** the file's CODE: comment lines are prose about these words, not uses of them */
  const code = (file: string): string =>
    fs
      .readFileSync(file, 'utf8')
      .split(NL)
      .filter((line) => !/^\s*(?:[/][/]|[*]|[/][*]|[{][/][*])/.test(line))
      .join(NL);

  it('a component with a DIALOG ROLE uses the stack for all three answers', () => {
    // Keyed on the ROLE, not on `aria-modal`: a new dialog that simply left
    // the attribute off would be invisible to a scan for it, and invisible to
    // the keyboard guard as well. The attribute is matched anywhere on a line
    // and in its quoted-key spelling, so a spread cannot carry one past this.
    const offenders: string[] = [];
    let dialogs = 0;
    for (const file of sources(SRC)) {
      const text = code(file);
      if (!/role=["'](?:alert)?dialog["']|role:\s*["'](?:alert)?dialog["']/.test(text)) continue;
      dialogs += 1;
      const name = path.relative(SRC, file).split(path.sep).join('/');
      if (!/const [{] top, lift [}] = useModalLayer[(]/.test(text)) offenders.push(`${name}: no useModalLayer`);
      if (!text.includes('inert={!top}')) offenders.push(`${name}: the dialog is not inert when it is not on top`);
      if (!/zIndex: \d+ [+] lift/.test(text)) offenders.push(`${name}: its backdrop is not lifted with the stack`);
      const claims = text.match(/['"]?aria-modal['"]?\s*[=:]\s*[^\n]*/g) ?? [];
      if (claims.length === 0) offenders.push(`${name}: a dialog that never says it is modal`);
      for (const claim of claims) {
        if (!/^aria-modal=[{]top\b/.test(claim)) offenders.push(`${name}: ${claim.trim().slice(0, 60)}`);
      }
    }
    expect(
      offenders,
      'Two aria-modal dialogs at once tell a screen reader that two things own the window. Take ' +
        '`{ top, lift }` from useModalLayer; write aria-modal={top ? "true" : undefined} and ' +
        'inert={!top} on the dialog, and `zIndex: <n> + lift` on its backdrop.'
    ).toEqual([]);
    // the scan is looking at something: there are eleven dialogs today
    expect(dialogs).toBeGreaterThanOrEqual(11);
  });

  it('the app’s keyboard guard asks the stack, by ONE question for both routes a command arrives by', () => {
    const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');
    // the keydown route and the claimed-chord / native-menu route
    expect(app.match(/if [(]modalBlocks[(]/g)?.length ?? 0).toBe(2);
    expect(app).toMatch(/modalOpenRef[.]current [|][|] isModalOpen[(]document[)]/);
    // and the two lists it used to keep by hand are gone
    expect(app).not.toContain('dialogAbove');
  });
});
