// @vitest-environment jsdom
// What an empty workspace says (#1166): one line and one button that starts a
// session. WHEN it shows is the dock's decision (it is the dock's watermark),
// and is covered in the real app by e2e/empty-workspace.spec.ts.
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { EmptyWorkspace, EmptyWorkspaceActions } from './EmptyWorkspace';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;

async function mount(onNewSession?: () => void): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      onNewSession ? (
        <EmptyWorkspaceActions.Provider value={{ onNewSession }}>
          <EmptyWorkspace />
        </EmptyWorkspaceActions.Provider>
      ) : (
        <EmptyWorkspace />
      )
    );
  });
}

const button = (): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('[data-testid="empty-workspace-new-session"]');

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

describe('the empty workspace (issue 1166)', () => {
  it('says there is nothing open, and how to start, in words', async () => {
    await mount(() => undefined);
    expect(host.textContent).toContain('No sessions open');
    expect(host.textContent).toContain('Start a session to begin');
  });

  it('its one button starts a session: the handler it was given, once per click', async () => {
    const onNewSession = vi.fn();
    await mount(onNewSession);
    expect(button()!.textContent).toBe('Start a session');
    act(() => button()!.click());
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it('the button is NOT called "+ session": the list has one of those already', async () => {
    // two buttons with one name is "which one?" to a screen reader, and to
    // every real-app test that asks for the button called "+ session"
    await mount(() => undefined);
    expect(button()!.textContent).not.toContain(en.rail.addSession);
  });

  it('with nothing to start a session with, there is no button rather than a dead one', async () => {
    await mount();
    expect(button()).toBeNull();
    expect(host.textContent).toContain('No sessions open'); // the line is still true
  });
});
