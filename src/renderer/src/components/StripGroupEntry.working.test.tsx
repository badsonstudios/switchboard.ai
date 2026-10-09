// @vitest-environment jsdom
// A group on the strip says when a session inside it is working (#1179).
//
// The owner, with the sessions across the top: "I don't know if something's
// running in a group currently if … the group is closed. I have to open the
// group, and then I can see what's running."
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import fs from 'fs';
import path from 'path';
import { initI18nForTests } from '../i18n/test-i18n';
import { StripGroupEntry } from './StripGroupEntry';
import { workingCount } from '../lib/rail-view';
import { RailSession } from '../model/types';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const noop = (): void => {};
// a token, not a hex: this is renderer TSX and the raw-colour lint cannot tell
// data from styling
const COLOUR = 'var(--accent-teal)';

const s = (id: string, status: string): RailSession => ({
  id,
  title: id,
  status: status as RailSession['status'],
  groupId: 'g1',
});

async function mount(members: RailSession[], needing: string[] = []): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <StripGroupEntry
        groupKey="g1"
        kind="group"
        name="Backend"
        color={COLOUR}
        members={members}
        needing={new Set(needing)}
        waiting={new Map()}
        ordinalOf={new Map()}
        open={false}
        listId="list-g1"
        onToggle={noop}
      />
    );
  });
  return host.querySelector<HTMLElement>('[data-strip-group]')!;
}

beforeAll(async () => {
  await initI18nForTests();
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('how many of a group’s sessions are working (issue 1179)', () => {
  it('counts the busy ones, and a session still starting up is one of them', () => {
    const members = [s('a', 'working'), s('b', 'idle'), s('c', 'starting'), s('d', 'done')];
    expect(workingCount(members, new Set())).toBe(2);
  });

  it('never counts a session that is counted as needing you: the two add up', () => {
    const members = [s('a', 'working'), s('b', 'working')];
    expect(workingCount(members, new Set(['a']))).toBe(1);
  });

  it('is zero for a quiet group and for an empty one', () => {
    expect(workingCount([s('a', 'idle')], new Set())).toBe(0);
    expect(workingCount([], new Set())).toBe(0);
  });
});

describe('a closed group with a session working inside it', () => {
  it('⭐ is marked the way a working session is, in the GROUP’s colour', async () => {
    const box = await mount([s('a', 'working'), s('b', 'idle')]);
    // the handle every "working" look hangs off, and the colour it paints in
    expect(box.dataset.sessionStatus).toBe('working');
    expect(box.style.getPropertyValue('--work-accent')).toBe(COLOUR);
    // the spinner (and the bars look 6 swaps it for)
    expect(box.querySelector('.status-ring')).not.toBeNull();
    expect(box.querySelectorAll('.status-bars i')).toHaveLength(4);
  });

  it('says how many, in words, where it used to say "calm"', async () => {
    const box = await mount([s('a', 'working'), s('b', 'working'), s('c', 'idle')]);
    expect(box.querySelector('[data-strip-group-summary]')!.textContent).toBe('2 working');
    expect(box.dataset.stripGroupWorking).toBe('2');
  });

  it('says it out loud too: it is in the name a screen reader is given', async () => {
    const box = await mount([s('a', 'working')]);
    expect(box.querySelector('[data-strip-group-open]')!.getAttribute('aria-label')).toContain(
      '1 working'
    );
  });

  it('a quiet group is unmarked and still says "calm"', async () => {
    const box = await mount([s('a', 'idle'), s('b', 'done')]);
    expect(box.dataset.sessionStatus).toBeUndefined();
    expect(box.querySelector('.status-ring')).toBeNull();
    expect(box.querySelector('[data-strip-group-summary]')!.textContent).toBe('calm');
  });

  it('⚠️ NEEDS-YOU WINS: one working and one waiting for you is a group that needs you', async () => {
    const box = await mount([s('a', 'working'), s('b', 'needs-input')], ['b']);
    expect(box.dataset.needsYou).toBe('true');
    // no working look on it, and no spinner competing with the yellow words
    expect(box.dataset.sessionStatus).toBeUndefined();
    expect(box.querySelector('.status-ring')).toBeNull();
    expect(box.querySelector('[data-strip-group-summary]')!.textContent).toBe('1 need you');
    // the count is still there for anything that wants it
    expect(box.dataset.stripGroupWorking).toBe('1');
  });
});

describe('the stylesheet paints a group with the same rules as a session', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'theme', 'tokens.css'), 'utf8');
  const block = css.slice(css.indexOf('A WORKING SESSION (#718)'));

  it('every rule that paints a row or a pill paints a group too', () => {
    // one list of three, never a second copy of the six looks for groups
    expect(block).not.toContain(':is(.rail-row, [data-strip-pill])[data-session-status');
    const shared = block.split(':is(.rail-row, [data-strip-pill], [data-strip-group])[data-session-status').length - 1;
    expect(shared).toBeGreaterThan(20);
  });

  it('the group’s name and its words are what the default look makes bold and blue', () => {
    expect(block).toContain('[data-strip-group-name]');
    expect(block).toContain('[data-strip-group-summary]');
  });

  it('a session being dragged onto a working group still turns its edge blue', () => {
    expect(block).toMatch(/\[data-strip-group\]\[data-drop-into='true'\][^{]*\{\s*border-color: var\(--status-working-ink\) !important/);
  });
});
