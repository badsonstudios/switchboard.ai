// @vitest-environment jsdom
// The viewer panel's done-when, asserted against the real render pipeline
// (P2-E16-02, §5.30).
//
// Monaco is stubbed. It is 4 MB of editor whose behaviour ("read-only",
// "highlighted") is Monaco's own and is asserted in e2e against the real thing;
// what this file owns is that the viewer CHOOSES the source body, hands it the
// right language and text, and gives it back the scroll position it left.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import type { FileReadResult, FileWatchNotice } from '../../../shared/ipc/fs';
import { ipcRefusal } from '../../../shared/ipc/refusal';

const sourceProps: Array<Record<string, unknown>> = [];
vi.mock('./DocumentSource', () => ({
  default: (props: Record<string, unknown>) => {
    sourceProps.push(props);
    return null;
  },
}));

import { DocumentViewer, documentReopened, formatBytes } from './DocumentViewer';
import {
  findSurfaceFor,
  findSurfaceKey,
  resetFindSurfaces,
  type DocumentFindSurface,
} from '../lib/find-surfaces';
import { openFindBar, resetFindBarState, setFindTerm } from '../lib/find-bar-state';
import { setDocumentOutline } from '../lib/document-outline';
import { sessionStore } from '../store/session-store';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let host: HTMLElement;
let root: Root | null = null;
let reads: string[] = [];
let calls: Array<{ what: string; arg: string }> = [];
let answer: (p: string) => FileReadResult;
/** what main says to `fs:watch` (#506); yes unless a test says otherwise */
let watchAnswer: (p: string) => unknown;
/** Every `files.watch` this mount asked for (P2-E16-04), and whether it was
 *  released. The teardown assertion the done-when names lives on `stopped`. */
let watches: Array<{
  path: string;
  notify: (n: FileWatchNotice) => void;
  stopped: boolean;
}> = [];

function ok(text: string, extra: Partial<FileReadResult> = {}): FileReadResult {
  return {
    ok: true,
    path: 'x',
    text,
    size: text.length,
    truncated: false,
    encoding: 'utf-8',
    ...extra,
  } as FileReadResult;
}

/** The slice of the preload bridge this panel reaches for. */
function stubBridge(): void {
  (window as unknown as { switchboard: unknown }).switchboard = {
    files: {
      read: (p: string) => {
        reads.push(p);
        return Promise.resolve(answer(p));
      },
      openPath: (p: string) => {
        calls.push({ what: 'openPath', arg: p });
        return Promise.resolve(true);
      },
      reveal: (p: string) => {
        calls.push({ what: 'reveal', arg: p });
        return Promise.resolve(true);
      },
      openExternal: (u: string) => {
        calls.push({ what: 'openExternal', arg: u });
        return Promise.resolve(true);
      },
      watch: (p: string, notify: (n: FileWatchNotice) => void, onAnswer?: (a: unknown) => void) => {
        const entry = { path: p, notify, stopped: false };
        watches.push(entry);
        // main's reply to the ask, a tick later like the IPC it stands in for
        const reply = watchAnswer(p);
        void Promise.resolve().then(() => onAnswer?.(reply));
        return () => {
          entry.stopped = true;
        };
      },
    },
  };
}

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  reads = [];
  calls = [];
  watches = [];
  sourceProps.length = 0;
  answer = () => ok('');
  watchAnswer = (p) => ({ ok: true, path: p });
  stubBridge();
  // BEFORE anything mounts, both of them: each drops SUBSCRIBERS as well as
  // state, so calling one with a component already up leaves a live
  // `useSyncExternalStore` deaf to every later change.
  resetFindSurfaces();
  resetFindBarState();
  await initI18nForTests();
});

afterEach(async () => {
  if (root) {
    const r = root;
    root = null;
    await act(async () => r.unmount());
  }
});

async function mount(
  path: string,
  colorScheme: 'light' | 'dark' = 'dark',
  extra: Partial<React.ComponentProps<typeof DocumentViewer>> = {}
): Promise<void> {
  await act(async () => {
    root!.render(<DocumentViewer path={path} colorScheme={colorScheme} {...extra} />);
  });
  // let the read's promise settle and the decoration effect run
  await act(async () => {});
}

const q = (sel: string): HTMLElement | null => host.querySelector(sel);
const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const click = async (el: Element | null | undefined): Promise<void> => {
  await act(async () => {
    (el as HTMLElement)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('a markdown file opens RENDERED by default', () => {
  it('renders the markdown, not its source', async () => {
    answer = () => ok('# Title\n\nSome **prose**.\n');
    await mount('/p/PROGRESS.md');
    expect(reads).toEqual(['/p/PROGRESS.md']);
    const body = q('[data-testid="doc-rendered"]');
    expect(body?.querySelector('h1')?.textContent).toBe('Title');
    expect(body?.querySelector('strong')?.textContent).toBe('prose');
    expect(q('[data-testid="doc-source"]')).toBeNull();
  });

  it('the header carries the name and the full path on hover', async () => {
    answer = () => ok('# T\n');
    await mount('/home/dan/sb/PROGRESS.md');
    const name = q('[data-testid="doc-name"]');
    expect(name?.textContent).toBe('PROGRESS.md');
    expect(name?.getAttribute('title')).toBe('/home/dan/sb/PROGRESS.md');
  });

  it('there is NO pin control (#530)', async () => {
    // The owner removed the pin outright, and with it the peek slot it existed
    // to escape from: every file opens its own tab, so there is nothing to
    // protect a document from. Asserted rather than assumed, because "the
    // button is gone" is the whole user-visible half of that change — and
    // because a stale param cannot bring it back if there is no code to draw it.
    answer = () => ok('# T\n');
    await mount('/p/PROGRESS.md');
    expect(q('.doc-pin')).toBeNull();
    expect(q('[data-testid="doc-pin"]')).toBeNull();
    expect(host.textContent).not.toMatch(/📌|📍/);
  });

  it('the pop-out control is a labelled toggle, and only exists when wired', async () => {
    answer = () => ok('# T\n');
    await mount('/p/PROGRESS.md');
    expect(q('[data-testid="doc-popout"]')).toBeNull();

    let toggles = 0;
    await mount('/p/PROGRESS.md', 'dark', { onPopoutToggle: () => (toggles += 1) });
    const out = q('[data-testid="doc-popout"]');
    expect(out?.getAttribute('aria-pressed')).toBe('false');
    expect(out?.getAttribute('aria-label')).toBe('Open this document in its own window');
    await click(out);
    expect(toggles).toBe(1);

    // ...and once it IS in its own window, the same control docks it back
    await mount('/p/PROGRESS.md', 'dark', { onPopoutToggle: () => {}, poppedOut: true });
    const back = q('[data-testid="doc-popout"]');
    expect(back?.getAttribute('aria-pressed')).toBe('true');
    expect(back?.getAttribute('aria-label')).toBe('Put this document back in the main window');
  });

  it('a viewer opened from a card wears that session’s tint and names it (§5.24)', async () => {
    answer = () => ok('# T\n');
    await mount('/p/PROGRESS.md');
    // no session, no chip and no tint: a viewer needs no session at all
    expect(q('[data-testid="doc-attribution"]')).toBeNull();
    expect(q('[data-testid="document-viewer"]')?.className).not.toContain('doc-attributed');

    await mount('/p/PROGRESS.md', 'dark', { session: { name: 'api-work', accent: 'var(--accent-indigo)' } });
    const chip = q('[data-testid="doc-attribution"]');
    expect(chip?.textContent).toContain('api-work');
    expect(chip?.textContent).toContain('↳');
    // the rune is decorative; the chip carries its own accessible name
    expect(chip?.getAttribute('role')).toBe('note');
    expect(chip?.getAttribute('aria-label')).toBe('Opened from the session api-work');
    expect(chip?.querySelector('[aria-hidden="true"]')?.textContent).toBe('↳');
    const viewer = q('[data-testid="document-viewer"]');
    expect(viewer?.className).toContain('doc-attributed');
    expect(viewer?.style.getPropertyValue('--doc-accent')).toBe('var(--accent-indigo)');
  });

  it('Open externally and Reveal in folder go through the bridge', async () => {
    answer = () => ok('# T\n');
    await mount('/p/PROGRESS.md');
    await click(buttonByText('Open externally'));
    await click(buttonByText('Reveal in folder'));
    expect(calls).toEqual([
      { what: 'openPath', arg: '/p/PROGRESS.md' },
      { what: 'reveal', arg: '/p/PROGRESS.md' },
    ]);
  });
});

describe('the Rendered | Source toggle', () => {
  it('round-trips to source and back, keeping each mode’s scroll position', async () => {
    answer = () => ok('# Title\n\nbody\n');
    await mount('/p/PROGRESS.md');
    const body = q('[data-testid="doc-scroll"]')!;
    body.scrollTop = 420;

    await click(buttonByText('Source'));
    expect(q('[data-testid="doc-source"]')).not.toBeNull();
    expect(q('[data-testid="doc-rendered"]')).toBeNull();
    expect(sourceProps.at(-1)).toMatchObject({ text: '# Title\n\nbody\n', language: 'markdown' });

    await click(buttonByText('Rendered'));
    expect(q('[data-testid="doc-scroll"]')!.scrollTop).toBe(420);
    expect(q('[data-testid="doc-rendered"]')!.querySelector('h1')?.textContent).toBe('Title');
  });

  it('is greyed, not hidden, for a file that has no rendered form', async () => {
    answer = () => ok('export const a = 1;\n');
    await mount('/p/src/index.ts');
    expect(q('[data-testid="doc-source"]')).not.toBeNull();
    const rendered = buttonByText('Rendered')!;
    expect(rendered.disabled).toBe(true);
    expect(rendered.getAttribute('title')).toBe('Only Markdown files have a rendered view');
  });

  it('a .ts opens in source with its own language', async () => {
    answer = () => ok('export const a = 1;\n');
    await mount('/p/src/index.ts');
    expect(sourceProps.at(-1)).toMatchObject({
      language: 'typescript',
      text: 'export const a = 1;\n',
    });
  });
});

describe('files that are not shown', () => {
  it('a PDF gets the card, without pretending to render it', async () => {
    answer = () => ok('', { binary: true, size: 148_000, encoding: undefined });
    await mount('/p/spec.pdf');
    const card = q('[data-testid="doc-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('spec.pdf');
    expect(card?.textContent).toContain('PDF');
    expect(card?.textContent).toContain('145 KB');
    expect(q('[data-testid="doc-rendered"]')).toBeNull();
    expect(q('[data-testid="doc-source"]')).toBeNull();
  });

  it('a binary file the extension did not warn about gets the card too', async () => {
    // main sniffed the bytes; the extension said "text"
    answer = () => ok('', { binary: true, size: 900, encoding: undefined });
    await mount('/p/notes.txt');
    expect(q('[data-testid="doc-card"]')).not.toBeNull();
    expect(buttonByText('Open externally')).toBeDefined();
  });

  it('every refusal says something a human can act on', async () => {
    for (const [reason, copy] of [
      ['out-of-scope', 'only opens files inside'],
      ['not-found', "isn't there any more"],
      ['not-a-file', "That's a folder"],
      ['unreadable', "couldn't be read"],
    ] as const) {
      answer = () => ({ ok: false, reason });
      await mount(`/p/${reason}.md`);
      expect(q('[data-testid="doc-refusal"]')?.textContent).toContain(copy);
    }
  });

  it('a BROKER refusal reads as "unreadable", not as a raw i18n key (#650)', async () => {
    // `files.read` is reached through the `files()` accessor, so
    // `scripts/refusal-truthiness.js` cannot see this call site — this test is
    // the net for it. Without `answered`, the brand goes into `result`
    // unchanged (`applyRead` sees no `.ok` and, with `keep` false, stores it),
    // and the strip renders `t('document.refusal.' + undefined)` — the literal
    // string `document.refusal.undefined` on screen. The whole point of the
    // #650 sweep is that a refusal degrades to something already designed.
    answer = () => ipcRefusal('fs:read', 'capability-not-held') as unknown as FileReadResult;
    await mount('/p/refused.md');
    const strip = q('[data-testid="doc-refusal"]');
    expect(strip?.textContent).toContain("couldn't be read");
    expect(strip?.textContent).not.toContain('document.refusal');
  });

  it('a truncated read says how much of the file it is showing', async () => {
    answer = () => ok('x'.repeat(2048), { size: 5_000_000, truncated: true });
    await mount('/p/huge.md');
    const notice = q('[data-testid="doc-truncated"]');
    expect(notice?.textContent).toContain('4.8 MB');
    expect(notice?.textContent).toContain('Open it externally');
  });

  it('a UTF-16 file says so rather than leaving the reader to guess', async () => {
    answer = () => ok('# hi\n', { encoding: 'utf-16le' });
    await mount('/p/notes.md');
    expect(q('[data-testid="doc-encoding"]')?.textContent).toContain('utf-16le');
  });
});

describe('links inside a rendered document', () => {
  it('a relative link navigates IN the viewer, and Back returns', async () => {
    answer = (p) =>
      p.endsWith('PROGRESS.md')
        ? ok('[the plan](docs/plans/00-process.md)\n')
        : ok('# The plan\n');
    await mount('/home/dan/sb/PROGRESS.md');
    await click(q('[data-doc-link="relative"]'));
    await act(async () => {});
    expect(reads).toEqual([
      '/home/dan/sb/PROGRESS.md',
      '/home/dan/sb/docs/plans/00-process.md',
    ]);
    expect(q('[data-testid="doc-name"]')?.textContent).toBe('00-process.md');

    await click(host.querySelector('.doc-nav button'));
    await act(async () => {});
    expect(reads.at(-1)).toBe('/home/dan/sb/PROGRESS.md');
  });

  it('an http link goes to the OS browser and never navigates this window', async () => {
    answer = () => ok('[docs](https://example.test/a)\n');
    await mount('/p/PROGRESS.md');
    await click(q('[data-doc-link="external"]'));
    expect(calls).toEqual([{ what: 'openExternal', arg: 'https://example.test/a' }]);
  });

  it('a same-document #fragment SCROLLS — it does not go to the browser (#527)', async () => {
    // The decision, pinned: the viewer and the conversation answer a bare
    // `#fragment` differently ON PURPOSE. A document has headings with ids to
    // land on, so this scrolls; a reply has none, so `markdown-links.ts` drops
    // it. Neither hands it to a browser, which is what a live href would do.
    answer = () => ok('[jump](#the-plan)\n\n## The plan\n\nbody\n');
    await mount('/p/PROGRESS.md');
    const heading = q('[data-testid="doc-rendered"]')?.querySelector('h2');
    const scrolled = vi.fn();
    (heading as unknown as { scrollIntoView: unknown }).scrollIntoView = scrolled;
    await click(q('[data-doc-link="anchor"]'));
    expect(scrolled).toHaveBeenCalled();
    // and nothing left the app: no browser, no second read
    expect(calls).toEqual([]);
    expect(reads).toEqual(['/p/PROGRESS.md']);
  });

  it('a link whose fragment is not a slug is ignored, not thrown on', async () => {
    // `#a%0Ab` decodes to a raw newline, which is a CSS parse error inside an
    // attribute selector — and the lookup happens in an EFFECT, where a throw
    // unmounts the tree and takes every session pane in the window with it.
    answer = (p) => (p.endsWith('a.md') ? ok('[go](./b.md#a%0Ab)\n') : ok('# B\n'));
    await mount('/p/a.md');
    await click(q('[data-doc-link="relative"]'));
    await act(async () => {});
    expect(q('[data-testid="doc-name"]')?.textContent).toBe('b.md');
    expect(q('[data-testid="doc-rendered"]')?.querySelector('h1')?.textContent).toBe('B');
  });

  it('a javascript: link does NOTHING AT ALL', async () => {
    answer = () => ok('[click me](javascript:alert(1))\n\n<a href="javascript:alert(2)">or me</a>\n');
    await mount('/p/PROGRESS.md');
    const blocked = [...host.querySelectorAll('[data-doc-link="blocked"]')];
    expect(blocked.length).toBeGreaterThan(0);
    for (const el of blocked) await click(el);
    expect(calls).toEqual([]);
    expect(reads).toEqual(['/p/PROGRESS.md']);
  });

  it('a remote image is a chip whose only action is the browser', async () => {
    answer = () => ok('![pixel](https://tracker.test/p.gif)\n');
    await mount('/p/PROGRESS.md');
    expect(host.querySelectorAll('img')).toHaveLength(0);
    await click(q('.doc-image-open'));
    expect(calls).toEqual([{ what: 'openExternal', arg: 'https://tracker.test/p.gif' }]);
  });
});

describe('the Copy button on a code block (#508)', () => {
  // jsdom ships no clipboard, and the rest of this file relies on that being
  // true: take ours away again rather than leave it for whoever runs next.
  afterEach(() => {
    delete (window.navigator as unknown as { clipboard?: unknown }).clipboard;
  });

  const FENCED = ['# Build', '', '```bash', 'npm run build', '```', ''].join(String.fromCharCode(10));

  /** a clipboard on one window's navigator, and what was written to it */
  function clipboardOn(win: Window): ReturnType<typeof vi.fn> {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(win.navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  }

  it('copies the code, exactly, and says so', async () => {
    const writeText = clipboardOn(window);
    answer = () => ok(FENCED);
    await mount('/home/dan/sb/BUILD.md');
    const button = q('[data-doc-copy]');
    expect(button).not.toBeNull();
    await click(button);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0][0]).trim()).toBe('npm run build');
    expect(button?.textContent).toBe('Copied');
  });

  it('in a POPPED-OUT viewer it uses THAT window’s clipboard, not the main one’s', async () => {
    // What dockview does to a popped-out panel, reproduced: the DOM moves into
    // another window's document and the JavaScript stays where it was. The
    // main window's document is then not the focused one, and the browser
    // refuses a clipboard write from an unfocused document — so reaching for
    // the module's own `navigator` flashed "Copied" over a clipboard nobody
    // had written to.
    const main = clipboardOn(window);
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const popout = frame.contentWindow as Window;
    popout.document.write('<!doctype html><html><body></body></html>');
    popout.document.close();
    const theirs = clipboardOn(popout);

    answer = () => ok(FENCED);
    await mount('/home/dan/sb/BUILD.md');
    await act(async () => {
      popout.document.body.appendChild(popout.document.adoptNode(host));
    });
    const button = host.querySelector('[data-doc-copy]');
    expect(button?.ownerDocument).toBe(popout.document);
    await click(button);

    expect(theirs).toHaveBeenCalledTimes(1);
    expect(String(theirs.mock.calls[0][0]).trim()).toBe('npm run build');
    expect(main).not.toHaveBeenCalled();
  });
});

describe('the rest of the v1 markdown scope', () => {
  it('shows an outline once a document has enough headings to need one', async () => {
    answer = () => ok('# A\n\n## B\n\n## C\n\ntext\n');
    await mount('/p/DESIGN.md');
    const links = [...host.querySelectorAll('.doc-outline-link')].map((b) => b.textContent);
    expect(links).toEqual(['A', 'B', 'C']);
  });

  it('shows front matter as a chip, collapsed, and not as a rule and a heading', async () => {
    answer = () => ok('---\ntitle: Hi\n---\n# Body\n');
    await mount('/p/post.md');
    const chip = q('.doc-front-chip')!;
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(q('.doc-front-body')).toBeNull();
    expect(q('[data-testid="doc-rendered"]')?.textContent).not.toContain('title: Hi');
    await click(chip);
    expect(q('.doc-front-body')?.textContent).toBe('title: Hi');
  });

  // --- find, now that the viewer only PUBLISHES it (#533) -------------------
  //
  // The private bar is gone: the viewer hands the shared §5.31 bar a
  // `FindSurface` and that bar drives it. So what is left to prove here is the
  // viewer's half of the contract — the surface exists, it says which body is
  // on screen, and it marks / steps / clears the rendered one. The bar's own
  // behaviour is `FindBar.test.tsx`'s, and the keystroke that opens it is
  // `find.spec.ts`'s.

  const surface = (): DocumentFindSurface | null =>
    findSurfaceFor(findSurfaceKey('doc-9', 'document')) as DocumentFindSurface | null;

  it('publishes a find surface named by its PANEL, and withdraws it on unmount', async () => {
    answer = () => ok('# Feed\n\nthe feed feeds the feed\n');
    await mount('/p/PROGRESS.md', 'dark', { panelId: 'doc-9' });
    expect(surface()?.kind).toBe('document');
    expect(surface()?.view()).toBe('rendered');
    const r = root!;
    root = null;
    await act(async () => r.unmount());
    expect(surface()).toBeNull();
  });

  it('publishes NOTHING for a viewer nobody can name', async () => {
    // The key is what makes "a search cannot reach another panel" structural,
    // so a viewer with no panel id has no way to be named and does not publish.
    answer = () => ok('# Feed\n');
    await mount('/p/PROGRESS.md');
    expect(surface()).toBeNull();
  });

  it('marks, steps and clears the rendered body through the surface', async () => {
    answer = () => ok('# Feed\n\nthe feed feeds the feed\n');
    await mount('/p/PROGRESS.md', 'dark', { panelId: 'doc-9' });
    const s = surface()!;

    await act(async () => {
      expect(s.search({ term: 'feed' }).matches).toHaveLength(4);
    });
    expect(host.querySelectorAll('mark[data-doc-match]')).toHaveLength(4);

    // stepping marks exactly one as current — #520's lesson: a jump with no
    // visible mark reads as broken
    await act(async () => {
      expect(s.reveal(1)).toBe(true);
    });
    const current = [...host.querySelectorAll('mark[data-doc-match-current]')];
    expect(current).toHaveLength(1);
    expect([...host.querySelectorAll('mark[data-doc-match]')].indexOf(current[0])).toBe(1);

    // closing the bar clears — the marks are real nodes, and leaving them
    // behind would make the next search match inside its own highlights
    await act(async () => s.clear());
    expect(host.querySelectorAll('mark[data-doc-match]')).toHaveLength(0);
  });

  it('re-marks the NEW document after a link, so the highlights are never stale', async () => {
    answer = (p) =>
      p.endsWith('a.md')
        ? ok('# feed\n\nfeed feed feed\n\n[go](./b.md)\n')
        : ok('# feed once\n');
    await mount('/p/a.md', 'dark', { panelId: 'doc-9' });
    openFindBar('doc-9');
    setFindTerm('feed');
    await act(async () => {
      expect(surface()!.search({ term: 'feed' }).matches).toHaveLength(4);
    });

    // `replaceChildren` destroys every mark; without the re-mark the bar would
    // sit over a document with nothing highlighted in it
    await click(q('[data-doc-link="relative"]'));
    await act(async () => {});
    expect(q('[data-testid="doc-name"]')?.textContent).toBe('b.md');
    expect(host.querySelectorAll('mark[data-doc-match]')).toHaveLength(1);
  });

  it('searches EXPANDED front matter — it is on screen, so a 0 over it would lie', async () => {
    answer = () => ok('---\ntitle: the needle\n---\n\n# Body\n');
    await mount('/p/PROGRESS.md', 'dark', { panelId: 'doc-9' });
    const s = surface()!;
    // collapsed: the block is not in the DOM at all, so not searching it is
    // honest rather than a gap
    await act(async () => {
      expect(s.search({ term: 'needle' }).matches).toHaveLength(0);
    });
    await click(buttonByText('Front matter'));
    await act(async () => {
      expect(s.search({ term: 'needle' }).matches).toHaveLength(1);
    });
    expect(host.querySelectorAll('.doc-front-body mark[data-doc-match]')).toHaveLength(1);
    // ...and the chip that opens it is OUR chrome, never a match
    await act(async () => {
      expect(s.search({ term: 'Front matter' }).matches).toHaveLength(0);
    });
  });

  it('says which body is on screen — the source one is Monaco’s to search', async () => {
    // `modeFor` reads this: rendered markdown is ours to mark, and the source
    // body is a Monaco editor §5.31 says not to reimplement a find over. The
    // editor is stubbed in jsdom, so `none` is the honest answer here — what is
    // being pinned is that it STOPS saying `rendered` the moment the toggle
    // moves, which is what keeps the bar from marking a body that is not there.
    answer = () => ok('# Feed\n');
    await mount('/p/PROGRESS.md', 'dark', { panelId: 'doc-9' });
    expect(surface()!.view()).toBe('rendered');
    await click(buttonByText('Source'));
    expect(surface()!.view()).not.toBe('rendered');
  });
});

// --- the outline's off switch (#1010) --------------------------------------
//
// The PREFERENCE itself — parsing, persistence, the subscribe — is
// `lib/document-outline.test.ts`. What this owns is the viewer's half: the chip
// is where the owner asked for it, it is honest about when it can do nothing,
// and turning it off takes the nav out of the tree rather than merely hiding
// it (which is what hands the width back, and what takes the tab stops away).
describe('hiding the outline (#1010)', () => {
  const HEADINGS = '# A\n\n## B\n\n## C\n\ntext\n';
  const toggle = (): HTMLButtonElement => q('[data-testid="doc-outline-toggle"]') as HTMLButtonElement;

  beforeEach(() => {
    // Module state, shared by every test in this file: leave it as the app
    // would find it on a workspace nobody has told.
    setDocumentOutline(true);
  });

  it('puts the chip in the toolbar beside Rendered and Source', async () => {
    answer = () => ok(HEADINGS);
    await mount('/p/DESIGN.md');
    const chips = [...host.querySelectorAll('.doc-header button')].map((b) => b.textContent?.trim());
    expect(chips).toContain('Outline');
    // between the mode pair and "Open externally", which is the cluster the
    // owner named
    expect(chips.indexOf('Outline')).toBe(chips.indexOf('Source') + 1);
    expect(chips.indexOf('Open externally')).toBe(chips.indexOf('Outline') + 1);
  });

  it('starts pressed, and hiding takes the nav out of the tree', async () => {
    answer = () => ok(HEADINGS);
    await mount('/p/DESIGN.md');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().getAttribute('title')).toBe('Hide outline');
    expect(q('.doc-outline')).not.toBeNull();

    await click(toggle());
    // REMOVED, not hidden: `.doc-outline` is a flex item beside a `flex: 1`
    // body, so its absence is what gives the document the width — and a nav
    // that is still in the DOM would still be a tab stop.
    expect(q('.doc-outline')).toBeNull();
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().getAttribute('title')).toBe('Show outline');
  });

  it('brings it back', async () => {
    answer = () => ok(HEADINGS);
    await mount('/p/DESIGN.md');
    await click(toggle());
    await click(toggle());
    expect([...host.querySelectorAll('.doc-outline-link')].map((b) => b.textContent)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('is greyed when the document is too short to have an outline', async () => {
    // The same threshold the outline has always used: under three headings
    // there is nothing to navigate, so there is nothing to hide either.
    answer = () => ok('# A\n\n## B\n\ntext\n');
    await mount('/p/short.md');
    expect(q('.doc-outline')).toBeNull();
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute('title')).toBe('This view has no outline to show');
  });

  it('is greyed over a source view, which has no outline either', async () => {
    answer = () => ok(HEADINGS);
    await mount('/p/DESIGN.md');
    expect(toggle().disabled).toBe(false);
    await click(buttonByText('Source'));
    // `outline` still holds the last rendered document's headings; the chip
    // must not offer to hide something that is not on screen.
    expect(toggle().disabled).toBe(true);
    await click(buttonByText('Rendered'));
    expect(toggle().disabled).toBe(false);
  });

  it('is greyed for a file that is only ever a card', async () => {
    answer = () => ok('', { binary: true, size: 148_000, encoding: undefined });
    await mount('/p/spec.pdf');
    expect(toggle().disabled).toBe(true);
  });

  it('opens a document with the outline already off when that is what was stored', async () => {
    setDocumentOutline(false);
    answer = () => ok(HEADINGS);
    await mount('/p/DESIGN.md');
    expect(q('.doc-outline')).toBeNull();
    // ...and still says so, rather than looking like a document with no
    // headings: the chip is live, not greyed.
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('is one answer for every open viewer, which is the point of a global', async () => {
    answer = () => ok(HEADINGS);
    await act(async () => {
      root!.render(
        <>
          <DocumentViewer path="/p/DESIGN.md" colorScheme="dark" />
          <DocumentViewer path="/p/PROGRESS.md" colorScheme="dark" />
        </>
      );
    });
    await act(async () => {});
    expect(host.querySelectorAll('.doc-outline')).toHaveLength(2);
    await click(host.querySelector('[data-testid="doc-outline-toggle"]'));
    expect(host.querySelectorAll('.doc-outline')).toHaveLength(0);
  });

  it('never strands focus inside the pane it just removed', async () => {
    answer = () => ok(HEADINGS);
    await mount('/p/DESIGN.md');
    const link = q('.doc-outline-link') as HTMLButtonElement;
    link.focus();
    expect(document.activeElement).toBe(link);
    // A CLICK does not move focus in jsdom, which is exactly the shape of the
    // case this guard is for: the flip arriving while a heading link holds
    // focus. Without the rescue, `activeElement` falls to <body>.
    await click(toggle());
    expect(document.activeElement).toBe(toggle());
  });
});

describe('following the file it has open (P2-E16-04)', () => {
  /** Main says the file moved; the viewer answers by reading it again. */
  const change = async (at = -1): Promise<void> => {
    await act(async () => {
      watches.at(at)!.notify({ token: 't', state: 'changed' });
    });
    await act(async () => {});
  };
  /** …and the reader's place in the document, as a scroll they really did. */
  const scrollTo = async (top: number): Promise<void> => {
    const body = q('[data-testid="doc-scroll"]')!;
    body.scrollTop = top;
    await act(async () => {
      body.dispatchEvent(new Event('scroll'));
    });
  };

  it('re-reads and re-renders when the file changes underneath it', async () => {
    let text = '# Before\n\nold body\n';
    answer = () => ok(text);
    await mount('/p/PROGRESS.md');
    expect(watches.map((w) => w.path)).toEqual(['/p/PROGRESS.md']);
    expect(q('[data-testid="doc-rendered"]')!.querySelector('h1')?.textContent).toBe('Before');

    text = '# After\n\nnew body\n';
    await change();
    expect(q('[data-testid="doc-rendered"]')!.querySelector('h1')?.textContent).toBe('After');
    expect(q('[data-testid="doc-rendered"]')!.textContent).toContain('new body');
  });

  it('keeps the reader where they were — the whole point of it', async () => {
    let text = '# Doc\n\nline\n';
    answer = () => ok(text);
    await mount('/p/PROGRESS.md');
    await scrollTo(360);

    text = '# Doc\n\nline\n\nand another paragraph\n';
    await change();
    expect(q('[data-testid="doc-scroll"]')!.scrollTop).toBe(360);
    expect(q('[data-testid="doc-rendered"]')!.textContent).toContain('another paragraph');
  });

  it('a change that lands while the FIRST read is in flight still renders', async () => {
    // The flagship scenario, at its most awkward: the file is already being
    // rewritten when the panel opens, so the notice retires the open read's
    // stamp. If only that read cleared "Opening…", the viewer would sit on the
    // loading message for the rest of its life with a perfectly good document
    // rendered behind it — the blank pane, arrived at from the other direction.
    let release: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    (window as unknown as { switchboard: { files: Record<string, unknown> } }).switchboard.files
      .read = async (p: string): Promise<FileReadResult> => {
      reads.push(p);
      if (first) {
        first = false;
        await held;
        return ok('# Opened\n\nthe version we started reading\n');
      }
      return ok('# Rewritten\n\nthe version that landed while we read\n');
    };

    await act(async () => {
      root!.render(<DocumentViewer path="/p/PROGRESS.md" colorScheme="dark" />);
    });
    expect(watches).toHaveLength(1);
    await change();
    await act(async () => {
      release?.();
    });
    await act(async () => {});

    expect(q('[data-testid="doc-rendered"]')!.querySelector('h1')?.textContent).toBe('Rewritten');
    expect(host.textContent).not.toContain('Opening…');
  });

  it('never flashes "Opening…" over a document that is already on screen', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    // the re-read is in flight for exactly as long as the promise takes; what
    // must not happen is the body being replaced by the loading message
    await act(async () => {
      watches.at(-1)!.notify({ token: 't', state: 'changed' });
    });
    expect(q('[data-testid="doc-rendered"]')).not.toBeNull();
    await act(async () => {});
    expect(q('[data-testid="doc-rendered"]')).not.toBeNull();
  });

  it('a deleted file is a STRIP over what you were reading, not a blank pane', async () => {
    answer = () => ok('# Doc\n\nthe last thing it said\n');
    await mount('/p/PROGRESS.md');
    await act(async () => {
      watches.at(-1)!.notify({ token: 't', state: 'gone' });
    });
    expect(q('[data-testid="doc-gone"]')?.textContent).toContain('deleted or moved');
    // …and the document is still there, still readable
    expect(q('[data-testid="doc-rendered"]')!.textContent).toContain('the last thing it said');
    expect(q('[data-testid="doc-refusal"]')).toBeNull();
  });

  it('a read that answers not-found on a RELOAD raises the strip, not a refusal', async () => {
    // The delete racing the change notice: main saw a write, the file was gone
    // by the time we read it.
    let gone = false;
    answer = () => (gone ? { ok: false, reason: 'not-found' } : ok('# Doc\n\nbody\n'));
    await mount('/p/PROGRESS.md');
    gone = true;
    await change();
    expect(q('[data-testid="doc-gone"]')).not.toBeNull();
    expect(q('[data-testid="doc-rendered"]')!.textContent).toContain('body');
  });

  it('a refusal that is NOT a deletion leaves the document alone entirely', async () => {
    // The session card this file came from was closed: the scope narrowed, the
    // document stopped updating. It did not stop existing, and it must not
    // vanish from under the reader.
    let narrowed = false;
    answer = () => (narrowed ? { ok: false, reason: 'out-of-scope' } : ok('# Doc\n\nbody\n'));
    await mount('/p/PROGRESS.md');
    narrowed = true;
    await change();
    expect(q('[data-testid="doc-gone"]')).toBeNull();
    expect(q('[data-testid="doc-refusal"]')).toBeNull();
    expect(q('[data-testid="doc-rendered"]')!.textContent).toContain('body');
  });

  it('the strip clears when the file comes back', async () => {
    let text = '# Doc\n\nbody\n';
    answer = () => ok(text);
    await mount('/p/PROGRESS.md');
    await act(async () => {
      watches.at(-1)!.notify({ token: 't', state: 'gone' });
    });
    expect(q('[data-testid="doc-gone"]')).not.toBeNull();
    text = '# Doc\n\nwritten again\n';
    await change();
    expect(q('[data-testid="doc-gone"]')).toBeNull();
    expect(q('[data-testid="doc-rendered"]')!.textContent).toContain('written again');
  });

  it('the watch FOLLOWS a relative link, and the one it left is released', async () => {
    answer = (p) => (p.endsWith('a.md') ? ok('# A\n\n[go](./b.md)\n') : ok('# B\n'));
    await mount('/p/a.md');
    await click(q('[data-doc-link="relative"]'));
    await act(async () => {});
    expect(watches.map((w) => w.path)).toEqual(['/p/a.md', '/p/b.md']);
    expect(watches[0].stopped).toBe(true);
    expect(watches[1].stopped).toBe(false);
  });

  it('closing the panel tears the watch down — no leaked watcher per file', async () => {
    answer = () => ok('# Doc\n');
    await mount('/p/PROGRESS.md');
    expect(watches).toHaveLength(1);
    const r = root!;
    root = null;
    await act(async () => r.unmount());
    expect(watches[0].stopped).toBe(true);
  });

  it('an older preload with no watch is simply not live, and still opens files', async () => {
    (window as unknown as { switchboard: { files: Record<string, unknown> } }).switchboard.files
      .watch = undefined;
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    expect(watches).toHaveLength(0);
    expect(q('[data-testid="doc-rendered"]')!.textContent).toContain('body');
  });

  it('a source-mode document follows the file too', async () => {
    let text = 'export const a = 1;\n';
    answer = () => ok(text);
    await mount('/p/src/index.ts');
    expect(watches).toHaveLength(1);
    text = 'export const a = 2;\n';
    await change();
    // Monaco keeps its own scroll across a model swap (`DocumentSource`); what
    // this owns is that the new text reached it at all.
    expect(sourceProps.at(-1)).toMatchObject({ text: 'export const a = 2;\n' });
  });
});

describe('saying so when main stops following the file (#506)', () => {
  const NO = { ok: false, reason: 'out-of-scope' };
  const strip = (): HTMLElement | null => q('[data-testid="doc-unfollowed"]');
  const again = (): HTMLButtonElement | null =>
    q('[data-testid="doc-follow-again"]') as HTMLButtonElement | null;
  const page = (): string => q('[data-testid="doc-rendered"]')?.textContent ?? '';
  const settle = async (): Promise<void> => {
    await act(async () => {});
    await act(async () => {});
  };
  /** Main let the watch go: the last session over this folder closed. */
  const unfollow = async (): Promise<void> => {
    await act(async () => {
      watches.at(-1)!.notify({ token: 't', state: 'unfollowed' });
    });
    await settle();
  };
  /** The rail's list as the store holds it; only the folders matter here. */
  const openSessions = async (...folders: string[]): Promise<void> => {
    await act(async () => {
      sessionStore.setSessions(
        folders.map((folder, i) => ({ id: `s${i}`, title: `s${i}`, folder }))
      );
    });
    await settle();
  };

  beforeEach(() => {
    sessionStore.setSessions([]);
  });
  afterEach(() => {
    sessionStore.setSessions([]);
  });

  it('says it stopped and why, over the document it still shows', async () => {
    answer = () => ok('# Doc\n\nthe last thing we read\n');
    await mount('/p/PROGRESS.md');
    expect(strip()).toBeNull();

    const before = reads.length;
    await unfollow();
    expect(strip()?.textContent).toContain('No longer following this file');
    expect(strip()?.textContent).toContain('No open session works in its folder');
    // the page is still there: this is a strip, not a replacement
    expect(page()).toContain('the last thing we read');
    // ...and nothing was re-read on the way, because that read would be refused
    expect(reads.length).toBe(before);
  });

  it('announces the sentence, and not the button with it', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    await unfollow();
    const live = strip()!.querySelector('[role="status"]')!;
    expect(live.textContent).toContain('No longer following this file');
    expect(live.contains(again())).toBe(false);
    expect(strip()!.getAttribute('role')).toBeNull();
  });

  it('Follow again asks main afresh, picks up what was missed, and clears the strip', async () => {
    let text = '# Doc\n\nold\n';
    answer = () => ok(text);
    await mount('/p/PROGRESS.md');
    await unfollow();

    text = '# Doc\n\nwritten while nobody was following\n';
    await click(again());
    await settle();
    // a NEW watch, and the old one released: main dropped the first token
    expect(watches).toHaveLength(2);
    expect(watches[0].stopped).toBe(true);
    expect(watches[1]).toMatchObject({ path: '/p/PROGRESS.md', stopped: false });
    expect(strip()).toBeNull();
    expect(page()).toContain('written while nobody was following');

    // and it is live again on the new watch
    text = '# Doc\n\nand again\n';
    await act(async () => {
      watches[1].notify({ token: 't', state: 'changed' });
    });
    await settle();
    expect(page()).toContain('and again');
  });

  it('Follow again that main still refuses says what would change the answer, and keeps the page', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    await unfollow();

    watchAnswer = () => NO;
    const before = reads.length;
    await click(again());
    await settle();
    expect(strip()?.textContent).toContain('Still not following this file');
    expect(strip()?.textContent).toContain('Open a session in its folder');
    expect(strip()?.textContent).not.toContain('No longer following');
    expect(again()).not.toBeNull(); // and can be asked again
    expect(page()).toContain('body');
    // a refusal is not a deletion, and no read was spent finding that out
    expect(q('[data-testid="doc-gone"]')).toBeNull();
    expect(reads.length).toBe(before);
  });

  // WHY it was a no decides what may be said: only `out-of-scope` is about
  // sessions, and advice that cannot help is worse than none.
  it.each([
    ['a call that was rejected', () => null],
    ['a broker refusal', () => ipcRefusal('fs:watch', 'capability-not-held')],
    ['a file somebody is holding', () => ({ ok: false, reason: 'unreadable' })],
    ['a path that is not a file', () => ({ ok: false, reason: 'not-a-file' })],
  ])('%s is a no that promises nothing about sessions', async (_what, reply) => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    await unfollow();
    watchAnswer = reply;
    await click(again());
    await settle();
    expect(strip()?.textContent).toContain("Couldn't follow this file just now");
    expect(strip()?.textContent).not.toContain('Open a session');
    expect(again()).not.toBeNull();
    expect(page()).toContain('body');
  });

  it('an ask that finds the file GONE says deleted, and keeps the button', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    await unfollow();
    watchAnswer = () => ({ ok: false, reason: 'not-found' });
    // quietly, too: a session opening is how most people will find out
    await openSessions('/p');
    expect(q('[data-testid="doc-gone"]')?.textContent).toContain('deleted or moved');
    // one strip, not two sentences about one file
    expect(strip()).toBeNull();
    // nothing is watching for the file to come back, so there is still a way
    // to ask, on the strip that is up
    expect(q('[data-testid="doc-gone"]')!.contains(again())).toBe(true);
    expect(q('[data-testid="doc-gone"] [role="status"]')?.contains(again())).toBe(false);

    // it comes back, and the reader asks
    watchAnswer = (p) => ({ ok: true, path: p });
    await click(again());
    await settle();
    expect(q('[data-testid="doc-gone"]')).toBeNull();
    expect(strip()).toBeNull();
  });

  it('a press that a link overtook is not answered on the NEXT file', async () => {
    answer = (p) => (p.endsWith('other.md') ? ok('# Other\n\nbody\n') : ok('# Doc\n\n[go](other.md)\n'));
    await mount('/p/PROGRESS.md');
    await unfollow();
    // main never answers this press...
    const files = (window as unknown as { switchboard: { files: Record<string, unknown> } }).switchboard.files;
    const real = files.watch;
    files.watch = (p: string, notify: (n: FileWatchNotice) => void) => {
      const entry = { path: p, notify, stopped: false };
      watches.push(entry);
      return () => {
        entry.stopped = true;
      };
    };
    await click(again());
    // ...and the reader follows a link instead of waiting
    await click(q('[data-testid="doc-rendered"] a'));
    await settle();
    files.watch = real;
    expect(q('[data-testid="doc-rendered"]')!.querySelector('h1')?.textContent).toBe('Other');

    await unfollow(); // the new file stops too
    watchAnswer = () => NO;
    await openSessions('/elsewhere'); // a QUIET try, refused
    // nobody asked about THIS file, so the words are the notice's
    expect(strip()?.textContent).toContain('No longer following this file');
    expect(strip()?.textContent).not.toContain('Still not following');
  });

  // The strip is decided by the WATCH. The first cut inferred it from a read,
  // and review found both directions wrong.
  it('a watch main granted clears the strip even when the catch-up read fails', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    await unfollow();
    // a writer is holding the file: readable in a moment, not now
    answer = () => ({ ok: false, reason: 'unreadable' });
    await click(again());
    await settle();
    expect(strip()).toBeNull(); // we ARE following; the next change will show
    expect(page()).toContain('body'); // and the page was kept
  });

  it('a read that would succeed does not clear a strip main has not lifted', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    await unfollow();
    watchAnswer = () => NO; // the scope moved between the two messages
    await click(again());
    await settle();
    expect(strip()).not.toBeNull();
  });

  it('a change arriving on the watch we hold clears the strip by itself', async () => {
    let text = '# Doc\n\nold\n';
    answer = () => ok(text);
    await mount('/p/PROGRESS.md');
    await unfollow();
    // a quiet try that main granted, whose own answer is slow to arrive...
    let late: ((a: unknown) => void) | undefined;
    const files = (window as unknown as { switchboard: { files: Record<string, unknown> } }).switchboard.files;
    files.watch = (p: string, notify: (n: FileWatchNotice) => void, onAnswer?: (a: unknown) => void) => {
      const entry = { path: p, notify, stopped: false };
      watches.push(entry);
      late = onAnswer;
      return () => {
        entry.stopped = true;
      };
    };
    await openSessions('/p');
    expect(strip()).not.toBeNull(); // no answer yet
    // ...and the file changes first
    text = '# Doc\n\nnew\n';
    await act(async () => {
      watches.at(-1)!.notify({ token: 't', state: 'changed' });
    });
    await settle();
    expect(strip()).toBeNull();
    expect(page()).toContain('new');
    await act(async () => late?.({ ok: true, path: '/p/PROGRESS.md' }));
    await settle();
    expect(strip()).toBeNull();
  });

  it('resumes by itself when a session opens, with nothing pressed', async () => {
    let text = '# Doc\n\nold\n';
    answer = () => ok(text);
    await openSessions('/p');
    await mount('/p/PROGRESS.md');
    await openSessions(); // the card closed...
    await unfollow(); // ...and main let go
    expect(strip()).not.toBeNull();

    text = '# Doc\n\nnew\n';
    await openSessions('/p'); // a session over that folder opens again
    expect(strip()).toBeNull();
    expect(watches).toHaveLength(2);
    expect(page()).toContain('new');
  });

  it('a quiet try that is refused changes NOTHING on screen', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    await unfollow();
    watchAnswer = () => NO;
    await openSessions('/somewhere/else'); // a session opened, but not over this file
    expect(strip()?.textContent).toContain('No longer following this file');
    // the other wording is for someone who ASKED
    expect(strip()?.textContent).not.toContain('Still not following');
    expect(page()).toContain('body');
  });

  it('a quiet try that overtakes a press does not swallow the answer the reader is owed', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    await unfollow();
    // main answers when THIS TEST says so, so the order is not left to luck
    const owed: Array<(a: unknown) => void> = [];
    const files = (window as unknown as { switchboard: { files: Record<string, unknown> } }).switchboard.files;
    files.watch = (p: string, notify: (n: FileWatchNotice) => void, onAnswer?: (a: unknown) => void) => {
      const entry = { path: p, notify, stopped: false };
      watches.push(entry);
      if (onAnswer) owed.push(onAnswer);
      return () => {
        entry.stopped = true;
      };
    };
    await click(again()); // pressed...
    await openSessions('/elsewhere'); // ...and before main answers, a session opens somewhere else
    // two asks after the first watch, and neither answered yet
    expect(watches).toHaveLength(3);
    expect(owed).toHaveLength(2);
    expect(strip()?.textContent).toContain('No longer following this file');

    // the press's own answer arrives for a watch we no longer hold: dropped
    await act(async () => owed[0](NO));
    await settle();
    expect(strip()?.textContent).toContain('No longer following this file');
    // the quiet try's answer is the one that lands, and the reader is still owed
    await act(async () => owed[1](NO));
    await settle();
    expect(strip()?.textContent).toContain('Still not following this file');

    // ...and owed ONCE: the next quiet refusal is quiet
    await act(async () => {
      again()!.click();
    });
    await settle();
    await act(async () => owed[2]({ ok: true, path: '/p/PROGRESS.md' }));
    await settle();
    expect(strip()).toBeNull();
  });

  it('does not try on store writes that leave the open folders alone', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await openSessions('/a');
    await mount('/p/PROGRESS.md');
    await unfollow();
    const watched = watches.length;
    const read = reads.length;
    // the same folders again, as a session working writes the store many times
    await openSessions('/a');
    await openSessions('/a');
    expect(watches.length).toBe(watched);
    expect(reads.length).toBe(read);
  });

  it('never tries while it IS being followed, however the sessions change', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    const watched = watches.length;
    const read = reads.length;
    await openSessions('/a');
    await openSessions('/a', '/b');
    await openSessions();
    expect(watches.length).toBe(watched);
    expect(reads.length).toBe(read);
  });

  it('opening the same file again is the reader asking for it back', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await act(async () => {
      root!.render(<DocumentViewer path="/p/PROGRESS.md" panelId="doc-7" colorScheme="dark" />);
    });
    await settle();
    // while it is being followed, a re-open is just a focus: nothing is asked
    await act(async () => documentReopened('doc-7', '/p/PROGRESS.md'));
    await settle();
    expect(watches).toHaveLength(1);

    await unfollow();
    watchAnswer = () => NO;
    await act(async () => documentReopened('doc-7', '/p/PROGRESS.md'));
    await settle();
    // it counts as a press: a refusal is said
    expect(strip()?.textContent).toContain('Still not following this file');

    watchAnswer = (p) => ({ ok: true, path: p }); // Open File… granted it
    await act(async () => documentReopened('doc-7', '/p/PROGRESS.md'));
    await settle();
    expect(strip()).toBeNull();
    // somebody else's panel is not ours to poke
    await act(async () => documentReopened('doc-8', '/p/PROGRESS.md'));
  });

  it('re-opening the file a panel was OPENED on is no request about the one it shows now', async () => {
    // The panel is found by the path it was opened on, and a viewer follows
    // links. Picking A grants A; it says nothing about B.
    answer = (p) => (p.endsWith('other.md') ? ok('# Other\n\nbody\n') : ok('# Doc\n\n[go](other.md)\n'));
    await act(async () => {
      root!.render(<DocumentViewer path="/p/PROGRESS.md" panelId="doc-7" colorScheme="dark" />);
    });
    await settle();
    await click(q('[data-testid="doc-rendered"] a'));
    await settle();
    await unfollow(); // other.md stops being followed
    watchAnswer = () => NO;
    await act(async () => documentReopened('doc-7', '/p/PROGRESS.md'));
    await settle();
    // tried, quietly: a refusal is not "an answer" to a question about B
    expect(watches.at(-1)!.path).toBe('/p/other.md');
    expect(strip()?.textContent).toContain('No longer following this file');
    expect(strip()?.textContent).not.toContain('Still not following');
  });

  it('hands the keyboard to a control that stays when the button goes', async () => {
    // NO headings to speak of, so the outline toggle is DISABLED: the first
    // cut focused that toggle by name, which does nothing on a disabled
    // button, and most documents are this one.
    answer = () => ok('just a paragraph\n');
    await mount('/p/notes.md');
    expect((q('[data-testid="doc-outline-toggle"]') as HTMLButtonElement).disabled).toBe(true);
    await unfollow();
    again()!.focus();
    expect(document.activeElement).toBe(again());
    await click(again());
    await settle();
    expect(strip()).toBeNull();
    const now = document.activeElement as HTMLElement;
    expect(now.tagName).toBe('BUTTON');
    expect((now as HTMLButtonElement).disabled).toBe(false);
    expect(q('[data-testid="document-viewer"]')!.contains(now)).toBe(true);
  });

  it('leaves the keyboard alone when it was somewhere else', async () => {
    answer = () => ok('just a paragraph\n');
    await mount('/p/notes.md');
    await unfollow();
    const elsewhere = document.createElement('input');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    await openSessions('/p'); // resumes with nothing pressed
    expect(strip()).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });

  it('a deleted file that comes back out of reach swaps "deleted" for the truth', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await mount('/p/PROGRESS.md');
    await act(async () => {
      watches.at(-1)!.notify({ token: 't', state: 'gone' });
    });
    expect(q('[data-testid="doc-gone"]')).not.toBeNull();
    // main only says `unfollowed` about a file that is THERE, so over the
    // deleted strip it means the file returned where we may no longer read it
    await unfollow();
    expect(q('[data-testid="doc-gone"]')).toBeNull();
    expect(strip()).not.toBeNull();
    expect(again()).not.toBeNull(); // and there is a way out
  });

  it('says nothing about a "last version" when there is no document on screen', async () => {
    answer = () => ({ ok: false, reason: 'out-of-scope' });
    await mount('/p/PROGRESS.md');
    await unfollow();
    expect(strip()).toBeNull();
  });

  it('following a link out of a stopped document starts clean', async () => {
    answer = (p) => (p.endsWith('other.md') ? ok('# Other\n\nbody\n') : ok('# Doc\n\n[go](other.md)\n'));
    await mount('/p/PROGRESS.md');
    await unfollow();
    expect(strip()).not.toBeNull();
    await click(q('[data-testid="doc-rendered"] a'));
    await settle();
    expect(q('[data-testid="doc-rendered"]')!.querySelector('h1')?.textContent).toBe('Other');
    // the strip was about the file that is no longer on screen
    expect(strip()).toBeNull();
    // and the link was not mistaken for a "follow again": one watch per path
    expect(watches.map((w) => w.path)).toEqual(['/p/PROGRESS.md', '/p/other.md']);
  });

  it('two viewers of one file: only the one that asked is answered', async () => {
    answer = () => ok('# Doc\n\nbody\n');
    await act(async () => {
      root!.render(
        <>
          <DocumentViewer path="/p/PROGRESS.md" colorScheme="dark" />
          <DocumentViewer path="/p/PROGRESS.md" colorScheme="dark" />
        </>
      );
    });
    await settle();
    await act(async () => {
      for (const w of watches) w.notify({ token: 't', state: 'unfollowed' });
    });
    await settle();
    expect(host.querySelectorAll('[data-testid="doc-unfollowed"]')).toHaveLength(2);
    await click(host.querySelector('[data-testid="doc-follow-again"]'));
    await settle();
    expect(host.querySelectorAll('[data-testid="doc-unfollowed"]')).toHaveLength(1);
  });
});

describe('formatBytes', () => {
  it('says sizes the way a human does', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(148_000)).toBe('145 KB');
    expect(formatBytes(9_000)).toBe('8.8 KB');
    expect(formatBytes(5_000_000)).toBe('4.8 MB');
    expect(formatBytes(-1)).toBe('—');
  });
});
