// @vitest-environment jsdom
// The shared compose window (#1008) — the half of a modal that has nothing to
// do with what is in it.
//
// THIS FILE EXISTS BECAUSE THE EXTRACTION MADE ITS ABSENCE DANGEROUS. Before
// #1008 this chrome lived inside `ReportProblemDialog`, whose 21 tests cover
// the form, the credential panel and what a send means — and NONE of focus
// capture, focus restore, the scrim, or the two `stopPropagation` calls. That
// was survivable while one dialog owned it. Now two do, so a change here is a
// change to both, and "nothing noticed" would mean nothing was looking.
//
// `modal-dismiss.ts` argues for its own existence on the grounds that "a second
// copy of focus restoration is how one of them quietly stops doing it". These
// are the assertions that make the argument checkable.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { ComposeDialog } from './ComposeDialog';
import { useModalDismiss } from '../lib/modal-dismiss';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let root: Root | null = null;
let host: HTMLElement;
const onClose = vi.fn();

/** a minimal consumer, wired exactly as the two real dialogs wire it */
function Harness(props: { open: boolean }): React.JSX.Element | null {
  const { dialogRef, close } = useModalDismiss(props.open, onClose);
  if (!props.open) return null;
  return (
    <ComposeDialog
      kind="probe"
      dialogRef={dialogRef}
      onDismiss={close}
      title="t"
      intro="i"
      cancelLabel="c"
      submitLabel="s"
      canSubmit
      message={null}
      onSubmit={() => {}}
    >
      <input data-probe-field />
    </ComposeDialog>
  );
}

const dialog = (): HTMLElement => host.querySelector<HTMLElement>('[role="dialog"]')!;
const scrim = (): HTMLElement => dialog().parentElement!;

async function render(open: boolean): Promise<void> {
  await act(async () => {
    root!.render(<Harness open={open} />);
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  onClose.mockReset();
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

describe('focus', () => {
  it('lands on the dialog when it opens, so the first Tab is inside it', async () => {
    await render(true);
    expect(document.activeElement).toBe(dialog());
  });

  it('goes back where it came from when the dialog closes', async () => {
    // THE ONE `modal-dismiss.ts` was extracted to protect. Without it, closing
    // a modal drops the caret on `document.body` and the keyboard path ends.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await render(true);
    expect(document.activeElement).toBe(dialog());

    // the restore is deferred a frame — the tree it hands focus back to may be
    // mid-render, and focusing something about to be replaced puts the caret
    // somewhere that is gone a millisecond later
    const frame = new Promise<void>((r) => requestAnimationFrame(() => r()));
    await act(async () => {
      dialog().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    await act(async () => frame);
    expect(onClose).toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });
});

describe('dismissal', () => {
  it('a click on the scrim closes it', async () => {
    await render(true);
    await act(async () => {
      scrim().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('a mousedown INSIDE the dialog does not', async () => {
    // Drag-selecting text in the body and releasing over the scrim must not
    // throw away what the user typed.
    await render(true);
    await act(async () => {
      host
        .querySelector('[data-probe-field]')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape closes it, and the key does not reach the app behind', async () => {
    // These render at the root, over a grid whose keys act on a session. A
    // chord that escaped an open modal would act on a card nobody can see.
    const seen: string[] = [];
    const listener = (e: Event): void => void seen.push((e as KeyboardEvent).key);
    document.addEventListener('keydown', listener);
    try {
      await render(true);
      await act(async () => {
        dialog().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
        );
        dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([]);
    } finally {
      document.removeEventListener('keydown', listener);
    }
  });
});

describe('the shape it promises', () => {
  it('is a modal dialog with an accessible name, reachable by script focus', async () => {
    await render(true);
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(dialog().getAttribute('aria-label')).toBe('t');
    expect(dialog().tabIndex).toBe(-1);
  });

  it('names its data hooks after the kind it was given', async () => {
    // The report dialog's e2e spec and unit tests select on `data-report-*`;
    // the prefix is a prop precisely so a shared chrome could not rename them.
    await render(true);
    expect(host.querySelector('[data-probe-dialog]')).not.toBeNull();
    expect(host.querySelector('[data-probe-submit]')).not.toBeNull();
    expect(host.querySelector('[data-probe-cancel]')).not.toBeNull();
  });

  it('mounts the live region empty rather than conjuring it with words in it', async () => {
    // Many screen readers skip a live region that arrives already populated.
    await render(true);
    const region = host.querySelector('[role="status"]')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
    expect(host.querySelector('[data-probe-result]')).toBeNull();
  });
});
