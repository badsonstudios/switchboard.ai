// @vitest-environment jsdom
// P2-E10-09: the composer's clipboard WIRING.
//
// `lib/composer-attachments.test.ts` pins the rules and
// `sessions/submit-prompt.test.ts` pins the wire shape. Neither would notice
// the defect this file exists for: a paste handler that is never attached, a
// chip that is never rendered, or a submit that drops the attachments on the
// floor — the same reason `FeedView.composer.test.tsx` renders the real panel
// instead of testing `composerSize` in isolation.
//
// So this mounts the actual contribution and drives it through real events.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import { sessionPanels } from '../extensibility/panels';
import { PanelContext } from '../extensibility/contributions';
import { loadUiState } from '../lib/ui-state';
import {
  attachmentDraftKey,
  resetAttachmentDrafts,
} from '../lib/composer-attachment-draft';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** what main was asked to send, in order */
let submitted: Array<{ text: string; attachments?: Array<Record<string, unknown>> }>;
/** what main answers — false is "no typed-message transport / refused" */
let mainTakes = true;

const roots: Root[] = [];

function stubBridge(initialUi: Record<string, unknown> = {}): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    transcripts: {
      blocks: () => Promise.resolve([]),
      onBlock: () => () => {},
      onReset: () => () => {},
    },
    pty: { input: () => {} },
    // The composer SAVES its draft now (#485), into a module-level cache every
    // test in this file shares — and they all mount the same `card-1`. Without
    // an empty blob per test, the "keeps the draft AND the image when main
    // refuses" case (which ends on purpose with the draft UNCLEARED) leaves its
    // text in every composer mounted after it.
    workspace: { getUi: () => Promise.resolve(initialUi), setUi: () => {} },
    sessions: {
      slashCommands: () => Promise.resolve([]),
      submitPrompt: (
        _id: string,
        text: string,
        attachments?: Array<Record<string, unknown>>
      ) => {
        if (mainTakes) submitted.push({ text, attachments });
        return Promise.resolve(mainTakes);
      },
    },
  };
}

const feedPanel = sessionPanels.find((p) => p.id === 'feed')!;

async function mount(transport: 'pty' | 'stream' = 'stream'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const ctx: PanelContext = {
    sessionId: 'live-1',
    cardId: 'card-1',
    title: 'acme-web',
    visible: true,
    dockEpoch: 0,
    theme: 'nordic',
    colorScheme: 'dark',
    changed: 0,
    transport,
    setView: () => {},
  };
  await act(async () => {
    root.render(feedPanel.render(ctx));
  });
  return host;
}

const boxOf = (host: HTMLElement): HTMLTextAreaElement => host.querySelector('textarea')!;
const chips = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('[data-composer-attachment]')].map(
    (el) => el.getAttribute('data-composer-attachment')!
  );
const notice = (host: HTMLElement): string =>
  host.querySelector('[data-composer-attach-notice]')?.textContent ?? '';

/** a PNG of `n` bytes — the content is never decoded, only counted and encoded */
const png = (n = 4, name = 'image.png', type = 'image/png'): File =>
  new File([new Uint8Array(n)], name, { type });

/**
 * Paste, the way a browser does it.
 *
 * jsdom's `DataTransfer` cannot be built with files in it, so the clipboard is
 * a plain object hung off the event — which is exactly the surface React reads
 * (`'clipboardData' in event ? event.clipboardData : window.clipboardData`)
 * and exactly the surface the handler consumes.
 */
async function paste(
  host: HTMLElement,
  { files = [] as File[], text = '' }: { files?: File[]; text?: string }
): Promise<Event> {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { files, getData: (t: string) => (t === 'text/plain' ? text : '') },
  });
  await act(async () => {
    boxOf(host).dispatchEvent(ev);
  });
  // the read is async (File -> ArrayBuffer -> base64); let it settle
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return ev;
}

/** a text file of real bytes — the content IS decoded on this path */
const textFile = (body: string, name = 'notes.md', type = ''): File =>
  new File([body], name, { type });

/** the composer's root, which is the drop target */
const zone = (host: HTMLElement): HTMLElement =>
  host.querySelector('[data-composer-dropzone]') as HTMLElement;

const dropHint = (host: HTMLElement): boolean =>
  host.querySelector('[data-composer-drop-hint]') !== null;

/**
 * Build the `dataTransfer` the drop handlers actually read.
 *
 * jsdom's `DataTransfer` cannot hold files and has no `webkitGetAsEntry`, so —
 * exactly as `paste` does above — this is a plain object hung off the event.
 * `items` is the interesting half: it is what `filesFromDrop` interrogates to
 * tell a FOLDER from a file, so a fake that omitted it would silently exercise
 * the fallback path instead of the real one.
 */
function transferOf(files: File[], directories: string[] = []): unknown {
  const items = [
    ...directories.map((name) => ({
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, name }),
      getAsFile: () => null,
    })),
    ...files.map((file) => ({
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: false, isFile: true, name: file.name }),
      getAsFile: () => file,
    })),
  ];
  return { types: ['Files'], files, items, dropEffect: 'none' };
}

/** fire one drag event at the composer root with a files-carrying transfer */
async function fire(
  host: HTMLElement,
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  dataTransfer: unknown
): Promise<Event> {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
  await act(async () => {
    zone(host).dispatchEvent(ev);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return ev;
}

/** the whole gesture: enter, over, drop */
async function drop(
  host: HTMLElement,
  files: File[],
  directories: string[] = []
): Promise<Event> {
  const dt = transferOf(files, directories);
  await fire(host, 'dragenter', dt);
  await fire(host, 'dragover', dt);
  return fire(host, 'drop', dt);
}

/** type into the CONTROLLED textarea, through the setter React's tracker patched */
async function type(host: HTMLElement, text: string): Promise<void> {
  const box = boxOf(host);
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function send(host: HTMLElement): Promise<void> {
  await act(async () => {
    boxOf(host).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  submitted = [];
  mainTakes = true;
  // jsdom has no ResizeObserver, and both the scroll anchor and the composer's
  // re-measure-on-narrower install one (`FeedView.composer.test.tsx` does the
  // same for the same reason)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  );
  await initI18nForTests();
  stubBridge();
  await loadUiState(); // see stubBridge: an empty draft blob per test
  // ...and the same for #546's attachment stash, which is a module-level Map
  // that OUTLIVES a React root by design — exactly what makes it survive a
  // remount, and exactly what would carry one test's screenshot into the next.
  resetAttachmentDrafts();
});

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await act(async () => r.unmount());
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('pasting a bitmap', () => {
  it('shows a removable chip for it', async () => {
    const host = await mount();
    expect(chips(host)).toEqual([]);

    await paste(host, { files: [png()] });

    expect(chips(host)).toHaveLength(1);
    expect(chips(host)[0]).toMatch(/^pasted-\d{8}-\d{6}\.png$/);

    const remove = host.querySelector<HTMLButtonElement>(
      '[data-composer-attachment] button'
    )!;
    await act(async () => remove.click());
    expect(chips(host)).toEqual([]);
  });

  it('suppresses the default paste when there is nothing to insert', async () => {
    const host = await mount();
    const ev = await paste(host, { files: [png()] });
    expect(ev.defaultPrevented).toBe(true);
  });

  // The clause the item is explicit about: a clipboard with BOTH keeps both.
  it('lets the text paste run when the clipboard also carries text', async () => {
    const host = await mount();
    const ev = await paste(host, { files: [png()], text: 'from a spreadsheet' });

    expect(ev.defaultPrevented).toBe(false); // the browser inserts the text itself
    expect(chips(host)).toHaveLength(1); // ...and the image still attached
  });

  it('an image with nothing typed still enables the send button', async () => {
    const host = await mount();
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.title === 'Send to the session'
    )!;
    expect(button.disabled).toBe(true);

    await paste(host, { files: [png()] });

    expect(button.disabled).toBe(false);
  });
});

// THE REGRESSION THAT WOULD BE INVISIBLE: this feature's whole risk is that it
// breaks the paste that already worked, for everyone, every day.
describe('pasting plain text is completely unaffected', () => {
  it('does not preventDefault, attach anything, or say anything', async () => {
    const host = await mount();

    const ev = await paste(host, { text: 'just some words' });

    expect(ev.defaultPrevented).toBe(false);
    expect(chips(host)).toEqual([]);
    expect(notice(host)).toBe('');
    expect(host.querySelector('[role="group"]')).toBeNull(); // no strip at all
  });
});

describe('submitting', () => {
  it('sends the attachment blocks alongside the text, then clears', async () => {
    const host = await mount();
    await paste(host, { files: [png()] });
    await type(host, 'what is this?');

    await send(host);

    expect(submitted).toHaveLength(1);
    expect(submitted[0].text).toBe('what is this?');
    expect(submitted[0].attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', data: 'AAAAAA==' },
    ]);
    expect(chips(host)).toEqual([]);
    expect(boxOf(host).value).toBe('');
  });

  // A refused send must not eat the draft: a pasted screenshot cannot be got
  // back from the clipboard a minute later.
  it('keeps the draft AND the image when main refuses', async () => {
    mainTakes = false;
    const host = await mount();
    await paste(host, { files: [png()] });
    await type(host, 'what is this?');

    await send(host);

    expect(chips(host)).toHaveLength(1);
    expect(boxOf(host).value).toBe('what is this?');
    expect(notice(host)).toContain("wasn't sent");
  });
});

describe('a Terminal-mode session says so instead of pretending', () => {
  it('refuses the attachment and explains why', async () => {
    const host = await mount('pty');

    const ev = await paste(host, { files: [png()] });

    expect(ev.defaultPrevented).toBe(true);
    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('Direct mode');
  });

  it('still leaves a plain-text paste alone', async () => {
    const host = await mount('pty');
    const ev = await paste(host, { text: 'words' });
    expect(ev.defaultPrevented).toBe(false);
    expect(notice(host)).toBe('');
  });

  // The image is the part this session cannot take. The WORDS on the same
  // clipboard are still the user's, and swallowing them too would make a
  // Terminal-mode session worse at ordinary pasting than it was before.
  it('still lets the text half of a text+image clipboard through', async () => {
    const host = await mount('pty');

    const ev = await paste(host, { files: [png()], text: 'from a spreadsheet' });

    expect(ev.defaultPrevented).toBe(false);
    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('Direct mode');
  });
});

describe('a paste that produces nothing says why', () => {
  it('names the escape hatch for an unsupported type', async () => {
    const host = await mount();

    await paste(host, { files: [png(8, 'scan.tiff', 'image/tiff')] });

    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('full file path');
  });
});

// P2-E10-10 — DRAG & DROP. Same intake, second entry point.
//
// What these prove that the rule tests cannot: that the handlers are attached
// to the composer's ROOT (not the textarea, which is a smaller target than
// anyone aims at), that `dragover` is prevented so the drop is allowed at all,
// and that a drop is swallowed rather than left to bubble to `App.tsx`'s
// window listener — which would otherwise ALSO try to open the drop as a
// session.
describe('dropping files onto the composer (P2-E10-10)', () => {
  it('attaches a dropped markdown file as a removable chip', async () => {
    const host = await mount();

    await drop(host, [textFile('# hello\n', 'notes.md')]);

    expect(chips(host)).toEqual(['notes.md']);
    expect(notice(host)).toBe('');
  });

  // The whole point of the item: NOT just images.
  it('attaches text, source, image and PDF from ONE drop, in order', async () => {
    const host = await mount();

    await drop(host, [
      textFile('# doc\n', 'README.md'),
      textFile('const a = 1\n', 'main.ts'),
      png(4, 'diagram.png'),
      new File([new Uint8Array([1, 2, 3, 4])], 'spec.pdf', { type: 'application/pdf' }),
    ]);

    expect(chips(host)).toEqual(['README.md', 'main.ts', 'diagram.png', 'spec.pdf']);
  });

  // The per-type wire shape, end to end through the real component.
  it('sends each type as the block its type calls for', async () => {
    const host = await mount();
    await drop(host, [textFile('# hi\n', 'a.md'), png(4, 'b.png')]);

    await send(host);

    expect(submitted[0].attachments).toEqual([
      { kind: 'text', title: 'a.md', text: '# hi\n' },
      { kind: 'image', mediaType: 'image/png', data: 'AAAAAA==' },
    ]);
  });

  // A source file with NO MIME type — the ordinary case on Windows, and the one
  // the extension's filename fallback exists for.
  it('recognises a source file the OS gave no MIME type', async () => {
    const host = await mount();

    await drop(host, [textFile('fn main() {}\n', 'main.rs', '')]);

    expect(chips(host)).toEqual(['main.rs']);
  });

  it('shows a drop hint while a file is over the composer, and clears it after', async () => {
    const host = await mount();
    const dt = transferOf([textFile('x\n', 'a.md')]);

    await fire(host, 'dragenter', dt);
    expect(dropHint(host)).toBe(true);

    await fire(host, 'drop', dt);
    expect(dropHint(host)).toBe(false);
  });

  // Without preventDefault on dragover the browser refuses the drop outright,
  // which is the "nothing happens and nothing is said" failure.
  it('prevents dragover so the drop is allowed at all', async () => {
    const host = await mount();
    const ev = await fire(host, 'dragover', transferOf([textFile('x\n', 'a.md')]));
    expect(ev.defaultPrevented).toBe(true);
  });

  // `App.tsx` listens on the WINDOW for a dropped folder and opens it as a
  // session. A drop on the composer must not reach it.
  it('swallows the drop instead of letting the window open it as a session', async () => {
    const host = await mount();
    const seen: Event[] = [];
    const onWindowDrop = (e: Event): void => void seen.push(e);
    window.addEventListener('drop', onWindowDrop);

    await drop(host, [textFile('x\n', 'a.md')]);

    window.removeEventListener('drop', onWindowDrop);
    expect(seen).toEqual([]);
  });

  // A drag that carries no files at all — selecting text and dragging it — is
  // none of our business, and claiming it would break ordinary text dragging.
  it('ignores a drag that carries no files', async () => {
    const host = await mount();
    const ev = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { types: ['text/plain'] } });
    await act(async () => {
      zone(host).dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    expect(dropHint(host)).toBe(false);
  });
});

describe('a drop that cannot be used says why (P2-E10-10)', () => {
  it('refuses a folder and names the alternative', async () => {
    const host = await mount();

    await drop(host, [], ['src']);

    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('Folders cannot be attached');
  });

  // A mixed drop keeps what it can and reports what it could not.
  it('attaches the files from a drop that also contained a folder', async () => {
    const host = await mount();

    await drop(host, [textFile('x\n', 'a.md')], ['src']);

    expect(chips(host)).toEqual(['a.md']);
    expect(notice(host)).toContain('Folders cannot be attached');
  });

  it('refuses a binary the model cannot read, naming the path escape hatch', async () => {
    const host = await mount();

    await drop(host, [new File([new Uint8Array(8)], 'app.exe', { type: '' })]);

    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('full file path');
  });

  it('refuses an empty file rather than sending a hollow block', async () => {
    const host = await mount();

    await drop(host, [textFile('', 'empty.md')]);

    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('empty');
  });

  // Terminal mode has no typed-message transport, so it cannot carry any of
  // this — and must say so rather than dropping the file silently.
  it('refuses a drop in Terminal mode and explains why', async () => {
    const host = await mount('pty');

    await drop(host, [textFile('x\n', 'a.md')]);

    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('Direct mode');
  });
});

describe('the drop overlay cannot outlive its drag (P2-E10-10)', () => {
  it('clears on dragleave, not only on drop', async () => {
    const host = await mount();
    const dt = transferOf([textFile('x\n', 'a.md')]);

    await fire(host, 'dragenter', dt);
    expect(dropHint(host)).toBe(true);

    await fire(host, 'dragleave', dt);
    expect(dropHint(host)).toBe(false);
  });

  // dragenter/dragleave fire for every descendant the pointer crosses, so the
  // counter has to survive moving from the composer's padding onto the box.
  it('survives a nested enter/leave pair without flickering', async () => {
    const host = await mount();
    const dt = transferOf([textFile('x\n', 'a.md')]);

    await fire(host, 'dragenter', dt);
    await fire(host, 'dragenter', dt);
    await fire(host, 'dragleave', dt);
    expect(dropHint(host)).toBe(true);

    await fire(host, 'dragleave', dt);
    expect(dropHint(host)).toBe(false);
  });

  // A drag cancelled with Esc, or dropped on another window, never sends us a
  // leave. Without the window-level reset the overlay would sit there for ever.
  it('clears when the drag ends anywhere at all', async () => {
    const host = await mount();

    await fire(host, 'dragenter', transferOf([textFile('x\n', 'a.md')]));
    expect(dropHint(host)).toBe(true);

    await act(async () => {
      window.dispatchEvent(new Event('dragend'));
    });
    expect(dropHint(host)).toBe(false);
  });

  // A drop that carries no files still ENDS the drag.
  it('clears on a drop it does not claim', async () => {
    const host = await mount();
    await fire(host, 'dragenter', transferOf([textFile('x\n', 'a.md')]));

    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: { types: ['text/plain'] } });
    await act(async () => {
      zone(host).dispatchEvent(ev);
    });

    expect(dropHint(host)).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('a transfer that yields nothing still says something', () => {
  // Outlook, archive tools and virtual-file providers advertise `Files` and
  // then hand over items whose `getAsFile()` is null. "Nothing appeared and
  // nothing was said" is the #163 failure.
  it('reports a drop whose items produced no file at all', async () => {
    const host = await mount();
    const dt = {
      types: ['Files'],
      files: [],
      items: [{ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => null }],
    };

    await fire(host, 'drop', dt);

    expect(chips(host)).toEqual([]);
    expect(notice(host)).not.toBe('');
  });
});

describe('paste and drop differ ONLY where they must', () => {
  // Chromium names every pasted bitmap `image.png`, so a paste gets a generated
  // name — but a DROPPED file called `image.png` is an ordinary file whose real
  // name must survive.
  it('keeps a dropped file’s real name even when it is image.png', async () => {
    const host = await mount();

    await drop(host, [png(4, 'image.png')]);

    expect(chips(host)).toEqual(['image.png']);
  });

  it('still renames an anonymous PASTED bitmap', async () => {
    const host = await mount();

    await paste(host, { files: [png(4, 'image.png')] });

    expect(chips(host)[0]).toMatch(/^pasted-\d{8}-\d{6}\.png$/);
  });

  // The documented precedence: a drop of "one folder and one unusable file"
  // leads with the reason the FILE was refused, not with the folder.
  it('leads with the file’s reason when both a folder and a bad file were dropped', async () => {
    const host = await mount();

    await drop(host, [new File([new Uint8Array(8)], 'clip.mp4', { type: 'video/mp4' })], ['src']);

    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('full file path');
  });

  // ...but a folder ON ITS OWN is reported as a folder even in Terminal mode,
  // where "use the Terminal tab instead" would be nonsense advice.
  it('reports a folder as a folder even in Terminal mode', async () => {
    const host = await mount('pty');

    await drop(host, [], ['src']);

    expect(notice(host)).toContain('Folders cannot be attached');
  });
});

describe('the chips outlive the composer (#546)', () => {
  /** tear the whole tree down, the way a view-tab switch does */
  async function unmountAll(): Promise<void> {
    while (roots.length) {
      const r = roots.pop()!;
      await act(async () => r.unmount());
    }
    document.body.innerHTML = '';
  }

  it('an IMAGE-ONLY prompt survives a remount — the exact case #546 names', async () => {
    let host = await mount();
    await paste(host, { files: [png(4, 'image.png')] });
    expect(chips(host)).toHaveLength(1);
    // nothing typed: the whole prompt IS the picture, which is why losing it
    // loses everything
    expect(boxOf(host).value).toBe('');

    await unmountAll();
    host = await mount();

    expect(chips(host)).toHaveLength(1);
    expect(notice(host)).toBe(''); // nothing was lost, so nothing is announced
    // and it is still a real attachment, not a husk of one
    await send(host);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].attachments).toEqual([
      { kind: 'image', mediaType: 'image/png', data: 'AAAAAA==' },
    ]);
  });

  it('text and chips come back together', async () => {
    let host = await mount();
    await paste(host, { files: [png(4, 'shot.png')] });
    await type(host, 'what is this?');

    await unmountAll();
    host = await mount();

    expect(chips(host)).toEqual(['shot.png']);
    expect(boxOf(host).value).toBe('what is this?');
  });

  it('sending forgets them, so a remount does not resurrect a sent prompt', async () => {
    let host = await mount();
    await paste(host, { files: [png()] });
    await send(host);
    expect(submitted).toHaveLength(1);

    await unmountAll();
    host = await mount();

    expect(chips(host)).toEqual([]);
    expect(notice(host)).toBe('');
  });

  it('a REFUSED send keeps them across a remount too', async () => {
    mainTakes = false;
    let host = await mount();
    await paste(host, { files: [png(4, 'shot.png')] });
    await send(host);

    await unmountAll();
    host = await mount();

    expect(chips(host)).toEqual(['shot.png']);
  });

  it('removing the last chip leaves nothing to come back', async () => {
    let host = await mount();
    await paste(host, { files: [png()] });
    const remove = host.querySelector<HTMLButtonElement>(
      '[data-composer-attachment] button'
    )!;
    await act(async () => remove.click());
    expect(chips(host)).toEqual([]);

    await unmountAll();
    host = await mount();
    expect(chips(host)).toEqual([]);
    expect(notice(host)).toBe('');
  });

  it('a RELAUNCH announces the loss by name instead of dropping it silently', async () => {
    // what the next launch actually sees: the names are in the workspace blob,
    // the bytes are not anywhere — no process holds them, by design
    stubBridge({ [attachmentDraftKey('card-1')]: ['diagram.png', 'server.log'] });
    await loadUiState();
    resetAttachmentDrafts();

    let host = await mount();

    expect(chips(host)).toEqual([]);
    expect(notice(host)).toContain('diagram.png');
    expect(notice(host)).toContain('server.log');
    expect(notice(host)).toContain('Not restored');

    // ...ONCE. The record is consumed on mount, so the next remount is a clean
    // composer rather than a card that nags about a restart for ever.
    await unmountAll();
    host = await mount();
    expect(notice(host)).toBe('');
  });
});
