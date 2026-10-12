// A picture of a web page (#1239): the two halves that need no window.
//
// A SECURITY CHECK, like `doc-image.test.ts` next door. The page is something
// an agent wrote, and the window it is drawn in answers `file:` through
// `answerPageAsset` and nothing else, so what that REFUSES is the deliverable:
// a file outside the page's folder, a file outside the read scope, a network
// path, a type that is not a style, a picture or a font. Real files under
// tracked temp directories and the real `ReadScope`.
//
// The window itself (scripts off, nothing from the web, the picture's pixels)
// is `e2e/feed-page-picture.spec.ts`.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createLogger, LogSink } from '../log/logger';
import { tempDir } from '../../test-temp-dirs';
import { docImageUrl } from '../../shared/doc-image';
import { answerDocImage } from './doc-image';
import {
  MAX_PAGE_FILES,
  PAGE_SHOT_CSP,
  PAGE_SHOT_PARTITION,
  answerPageAsset,
  createPageShots,
  electronPageRenderer,
  isPageShotRequestAllowed,
  type PageAssetAnswer,
  type PageBeingDrawn,
  type PageShot,
  type ShotImageLike,
} from './page-snapshot';
import { ReadScope } from './read-scope';

const LOG_DIR = tempDir('sb-pageshot-log-');
const log = createLogger(new LogSink({ dir: LOG_DIR }), 'fs');
const PNG = Buffer.from('not really a png, and it does not have to be');

function fixture(): { root: string; outside: string; scope: ReadScope; page: string; drawing: PageBeingDrawn } {
  // the REAL spelling: the scope answers with real paths, and on macOS a temp
  // directory is behind a symlink
  const root = fs.realpathSync.native(tempDir('sb-pageshot-root-'));
  const outside = fs.realpathSync.native(tempDir('sb-pageshot-out-'));
  fs.mkdirSync(path.join(root, 'mock', 'css'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mock', 'index.html'), '<!doctype html><link rel="stylesheet" href="css/a.css">');
  fs.writeFileSync(path.join(root, 'mock', 'css', 'a.css'), 'body { color: red }');
  fs.writeFileSync(path.join(root, 'mock', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, 'mock', 'app.js'), 'alert(1)');
  fs.writeFileSync(path.join(root, 'mock', 'other.html'), '<!doctype html>');
  fs.writeFileSync(path.join(root, 'secret.css'), 'in the project, above the page');
  fs.writeFileSync(path.join(outside, 'secret.css'), 'outside the project');
  const scope = new ReadScope({ sessionFolders: () => [root], log });
  const page = path.join(root, 'mock', 'index.html');
  return { root, outside, scope, page, drawing: { page, dir: path.dirname(page), asked: new Map() } };
}
const url = (file: string): string => pathToFileURL(file).href;

describe('a file the page being drawn asks for', () => {
  it('the page itself is served as a page', async () => {
    const { scope, page, drawing } = fixture();
    const answer = await answerPageAsset(url(page), drawing, { scope, log });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.isPage).toBe(true);
    expect(answer.mime).toBe('text/html; charset=utf-8');
    expect(answer.body.toString()).toContain('stylesheet');
  });

  it('a stylesheet and a picture inside the page’s folder are served, with the type their name says', async () => {
    const { root, scope, drawing } = fixture();
    const css = await answerPageAsset(url(path.join(root, 'mock', 'css', 'a.css')), drawing, { scope, log });
    expect(css).toMatchObject({ ok: true, mime: 'text/css; charset=utf-8', isPage: false });
    const svg = await answerPageAsset(url(path.join(root, 'mock', 'logo.svg')), drawing, { scope, log });
    expect(svg).toMatchObject({ ok: true, mime: 'image/svg+xml', isPage: false });
    // a cache-buster on the address changes nothing
    const busted = await answerPageAsset(`${url(path.join(root, 'mock', 'css', 'a.css'))}?v=2#x`, drawing, { scope, log });
    expect(busted.ok).toBe(true);
  });

  it('⚠️ refuses a file ABOVE the page’s folder, though the session may read it', async () => {
    const { root, scope, drawing } = fixture();
    expect(await answerPageAsset(url(path.join(root, 'secret.css')), drawing, { scope, log })).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
    // ...and it was never looked at: not remembered as something the page uses
    expect(drawing.asked.size).toBe(0);
  });

  it('⚠️ refuses a file outside everything, and a climb to it with `..`', async () => {
    const { root, outside, scope, drawing } = fixture();
    expect(await answerPageAsset(url(path.join(outside, 'secret.css')), drawing, { scope, log })).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
    const climb = `${url(path.join(root, 'mock'))}/../../${path.basename(outside)}/secret.css`;
    expect(await answerPageAsset(climb, drawing, { scope, log })).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('⚠️ refuses a NETWORK address as a string: the scope is never asked', async () => {
    const { drawing } = fixture();
    let asked = 0;
    const scope = {
      resolve: () => {
        asked += 1;
        return { ok: false as const, reason: 'out-of-scope' as const };
      },
    };
    const answer = await answerPageAsset('file://fileserver/share/a.css', drawing, { scope, log });
    expect(answer.ok).toBe(false);
    expect(asked).toBe(0);
  });

  it('refuses script, another page, and anything else that is not a style, a picture or a font', async () => {
    const { root, scope, drawing } = fixture();
    for (const name of ['app.js', 'other.html']) {
      expect(await answerPageAsset(url(path.join(root, 'mock', name)), drawing, { scope, log })).toEqual({
        ok: false,
        reason: 'not-an-image',
      });
    }
  });

  it('⚠️ checks what the path RESOLVES to: inside the folder by name, outside it by link', async () => {
    // `mock/theme.css` → `<root>/secret.css`. Stood in for by the scope, for
    // `doc-image.test.ts`'s reason: a real symlink needs a privilege a Windows
    // runner does not have.
    const { root, scope, drawing } = fixture();
    const linked = { resolve: () => scope.resolve(path.join(root, 'secret.css')) };
    expect(
      await answerPageAsset(url(path.join(root, 'mock', 'theme.css')), drawing, { scope: linked, log })
    ).toEqual({ ok: false, reason: 'out-of-scope' });
    // ...and a stylesheet's name on a script's bytes
    const lying = { resolve: () => scope.resolve(path.join(root, 'mock', 'app.js')) };
    expect(
      await answerPageAsset(url(path.join(root, 'mock', 'theme.css')), drawing, { scope: lying, log })
    ).toEqual({ ok: false, reason: 'not-an-image' });
  });

  it('refuses a file over the cap before reading it, a missing one, and an address that is not a file', async () => {
    const { root, scope, drawing } = fixture();
    expect(
      await answerPageAsset(url(path.join(root, 'mock', 'css', 'a.css')), drawing, { scope, log, cap: 4 })
    ).toEqual({ ok: false, reason: 'too-large' });
    expect(await answerPageAsset(url(path.join(root, 'mock', 'gone.css')), drawing, { scope, log })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await answerPageAsset('https://example.invalid/a.css', drawing, { scope, log })).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
    expect(await answerPageAsset(undefined, drawing, { scope, log })).toEqual({ ok: false, reason: 'invalid-path' });
  });

  it('remembers every in-folder file the page asked for, served or not', async () => {
    const { root, scope, drawing } = fixture();
    await answerPageAsset(url(path.join(root, 'mock', 'css', 'a.css')), drawing, { scope, log });
    await answerPageAsset(url(path.join(root, 'mock', 'gone.css')), drawing, { scope, log });
    const asked = [...drawing.asked].map(([file, stamp]) => [path.basename(file), stamp === null]).sort();
    // each with what it looked like when it was asked for: there, and not there
    expect(asked).toEqual([
      ['a.css', false],
      ['gone.css', true],
    ]);
  });

  it('a page that names file after file is refused past the limit, and main stops describing them', async () => {
    const { root, scope, drawing } = fixture();
    let described = 0;
    const stamp = (): string => {
      described += 1;
      return 'v1';
    };
    const ask = (n: number): Promise<PageAssetAnswer> =>
      answerPageAsset(url(path.join(root, 'mock', `f${n}.css`)), drawing, { scope, log, stamp });
    for (let n = 0; n < MAX_PAGE_FILES; n += 1) await ask(n);
    expect(drawing.asked.size).toBe(MAX_PAGE_FILES);
    expect(await ask(MAX_PAGE_FILES)).toEqual({ ok: false, reason: 'too-large' });
    expect(drawing.asked.size).toBe(MAX_PAGE_FILES);
    expect(described).toBe(MAX_PAGE_FILES);
    // one it has asked for already is still answered
    expect((await ask(0)).ok).toBe(false); // (not-found: it is not there)
    expect(described).toBe(MAX_PAGE_FILES);
  });

  it.skipIf(process.platform === 'win32')(
    '⚠️ a REAL symlink out of the page’s folder is refused (not on Windows: making one needs a privilege)',
    async () => {
      const { root, scope, drawing } = fixture();
      fs.symlinkSync(path.join(root, 'secret.css'), path.join(root, 'mock', 'theme.css'));
      expect(await answerPageAsset(url(path.join(root, 'mock', 'theme.css')), drawing, { scope, log })).toEqual({
        ok: false,
        reason: 'out-of-scope',
      });
    }
  );

  it('the page’s content policy allows nothing from the web and no script', () => {
    expect(PAGE_SHOT_CSP).toContain("default-src 'none'");
    expect(PAGE_SHOT_CSP).not.toMatch(/https?:|script-src|connect-src|frame-src|[*]/);
  });
});

describe('pictures of pages, kept while they are true', () => {
  /** A renderer that counts, and files whose "stamp" the test controls. */
  function setup(files: ReadonlyArray<readonly [string, string | null]> = []): {
    shots: (page: string) => Promise<Buffer | null>;
    drawn: string[];
    stamps: Map<string, string | null>;
  } {
    const drawn: string[] = [];
    const stamps = new Map<string, string | null>();
    const shots = createPageShots({
      render: (page): Promise<PageShot> => {
        drawn.push(page);
        return Promise.resolve({ png: Buffer.from(`picture ${drawn.length} of ${page}`), files });
      },
      log,
      stamp: (file) => (stamps.has(file) ? (stamps.get(file) ?? null) : 'v1'),
      max: 2,
    });
    return { shots, drawn, stamps };
  }

  it('a page is drawn once and handed out again while nothing has changed', async () => {
    const { shots, drawn } = setup();
    const first = await shots('/p/a.html');
    const second = await shots('/p/a.html');
    expect(first?.toString()).toBe('picture 1 of /p/a.html');
    expect(second).toBe(first);
    expect(drawn).toEqual(['/p/a.html']);
  });

  it('⚠️ a page that CHANGED is drawn again: never an old picture shown as current', async () => {
    const { shots, drawn, stamps } = setup();
    await shots('/p/a.html');
    stamps.set('/p/a.html', 'v2');
    expect((await shots('/p/a.html'))?.toString()).toBe('picture 2 of /p/a.html');
    expect(drawn).toHaveLength(2);
  });

  it('⚠️ ...and so is one whose STYLESHEET changed, or appeared, though the page did not', async () => {
    const { shots, drawn, stamps } = setup([
      ['/p/a.css', 'v1'],
      ['/p/missing.css', null],
    ]);
    stamps.set('/p/missing.css', null);
    await shots('/p/a.html');
    await shots('/p/a.html');
    expect(drawn).toHaveLength(1);
    stamps.set('/p/a.css', 'v2');
    await shots('/p/a.html');
    expect(drawn).toHaveLength(2);
    // the file that was not there is written
    stamps.set('/p/missing.css', 'v1');
    await shots('/p/a.html');
    expect(drawn).toHaveLength(3);
  });

  it('a page rewritten WHILE it was being drawn reads as changed the next time', async () => {
    const drawn: string[] = [];
    let version = 'v1';
    const shots = createPageShots({
      render: (page) => {
        drawn.push(page);
        version = 'v2'; // the agent saves the file while the window is open
        return Promise.resolve({ png: PNG, files: [] });
      },
      log,
      stamp: () => version,
    });
    await shots('/p/a.html');
    await shots('/p/a.html');
    expect(drawn).toHaveLength(2);
  });

  it('pages are drawn ONE AT A TIME, and the same page asked for twice at once is drawn once', async () => {
    let open = 0;
    let most = 0;
    const drawn: string[] = [];
    const shots = createPageShots({
      render: async (page) => {
        open += 1;
        most = Math.max(most, open);
        drawn.push(page);
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
        return { png: PNG, files: [] };
      },
      log,
      stamp: () => 'v1',
    });
    const all = await Promise.all([shots('/a.html'), shots('/b.html'), shots('/a.html'), shots('/c.html')]);
    expect(all.every((png) => png === PNG)).toBe(true);
    expect(most).toBe(1);
    expect(drawn).toEqual(['/a.html', '/b.html', '/c.html']);
  });

  it('never rejects: a page that cannot be drawn, or draws nothing, is null', async () => {
    let mode: 'throw' | 'empty' = 'throw';
    const shots = createPageShots({
      render: () => {
        if (mode === 'throw') return Promise.reject(new Error('the page took too long to draw'));
        return Promise.resolve({ png: Buffer.alloc(0), files: [] });
      },
      log,
      stamp: () => 'v1',
    });
    expect(await shots('/a.html')).toBeNull();
    mode = 'empty';
    expect(await shots('/b.html')).toBeNull();
  });

  it('a page that could NOT be drawn is not tried again on every scroll, only when it changes', async () => {
    let fails = true;
    let version = 'v1';
    let tried = 0;
    const shots = createPageShots({
      render: () => {
        tried += 1;
        return fails ? Promise.reject(new Error('no')) : Promise.resolve({ png: PNG, files: [] });
      },
      log,
      stamp: () => version,
    });
    expect(await shots('/a.html')).toBeNull();
    expect(await shots('/a.html')).toBeNull();
    expect(tried).toBe(1);
    // the agent rewrites the page: it gets another go, and the page behind a failure is not stuck
    fails = false;
    version = 'v2';
    expect(await shots('/a.html')).toBe(PNG);
    expect(tried).toBe(2);
  });

  it('⚠️ a STYLESHEET rewritten while the window was open reads as changed the next time', async () => {
    let tried = 0;
    let css = 'v1';
    const shots = createPageShots({
      render: () => {
        tried += 1;
        const seen = css; // what the stylesheet looked like when the page asked for it
        css = 'v2'; // ...and it is saved again before the picture is taken
        return Promise.resolve({ png: PNG, files: [['/p/a.css', seen]] });
      },
      log,
      stamp: (file) => (file === '/p/a.css' ? css : 'page'),
    });
    await shots('/p/a.html');
    await shots('/p/a.html');
    expect(tried).toBe(2);
  });

  it('keeps only so many: the one used longest ago is dropped', async () => {
    const { shots, drawn } = setup();
    await shots('/a.html');
    await shots('/b.html');
    await shots('/a.html'); // used again: b is now the oldest
    await shots('/c.html'); // over the limit of two
    expect(drawn).toEqual(['/a.html', '/b.html', '/c.html']);
    await shots('/a.html');
    expect(drawn).toHaveLength(3);
    await shots('/b.html');
    expect(drawn).toHaveLength(4);
  });
});

describe('the picture scheme, asked for a page (#1239)', () => {
  it('answers with the picture main drew, as a PNG, for the REAL path of the page', async () => {
    const { scope, page } = fixture();
    const asked: string[] = [];
    const answer = await answerDocImage(docImageUrl(page), {
      scope,
      log,
      page: (real) => {
        asked.push(real);
        return Promise.resolve(PNG);
      },
    });
    expect(answer).toEqual({ ok: true, body: PNG, mime: 'image/png' });
    expect(asked).toEqual([page]);
  });

  it('without a way to draw one, a page is refused like any file that is not a picture', async () => {
    const { scope, page } = fixture();
    expect(await answerDocImage(docImageUrl(page), { scope, log })).toEqual({ ok: false, reason: 'not-an-image' });
  });

  it('⚠️ refuses a page OUTSIDE the scope, and nothing is drawn', async () => {
    const { outside, scope } = fixture();
    fs.writeFileSync(path.join(outside, 'p.html'), '<!doctype html>');
    let drawn = 0;
    const page = (): Promise<Buffer> => {
      drawn += 1;
      return Promise.resolve(PNG);
    };
    expect(await answerDocImage(docImageUrl(path.join(outside, 'p.html')), { scope, log, page })).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
    expect(drawn).toBe(0);
  });

  it('⚠️ the name must be a page’s BOTH ways: asked for, and resolved to', async () => {
    const { root, scope, page } = fixture();
    let drawn = 0;
    const draw = (): Promise<Buffer> => {
      drawn += 1;
      return Promise.resolve(PNG);
    };
    // `mock.html` → a script
    const toScript = { roots: () => scope.roots(), resolve: () => scope.resolve(path.join(root, 'mock', 'app.js')) };
    expect(
      await answerDocImage(docImageUrl(path.join(root, 'mock.html')), { scope: toScript, log, page: draw })
    ).toEqual({ ok: false, reason: 'not-an-image' });
    // `shot.png` → a page: a picture's address never gets a page drawn
    const toPage = { roots: () => scope.roots(), resolve: () => scope.resolve(page) };
    expect(
      await answerDocImage(docImageUrl(path.join(root, 'shot.png')), { scope: toPage, log, page: draw })
    ).toEqual({ ok: false, reason: 'not-an-image' });
    expect(drawn).toBe(0);
  });

  it('a directory with a page’s name, a page that has gone, and one that draws nothing are each refused', async () => {
    const { root, scope, page } = fixture();
    const draw = (): Promise<Buffer | null> => Promise.resolve(null);
    fs.mkdirSync(path.join(root, 'dir.html'));
    expect(await answerDocImage(docImageUrl(path.join(root, 'dir.html')), { scope, log, page: draw })).toEqual({
      ok: false,
      reason: 'not-a-file',
    });
    expect(await answerDocImage(docImageUrl(path.join(root, 'gone.html')), { scope, log, page: draw })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await answerDocImage(docImageUrl(page), { scope, log, page: draw })).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });
});

describe('the hidden window, against stand-ins', () => {
  /** A session and a window that record what was asked of them. */
  function standIns(
    options: { capture?: () => Promise<ShotImageLike>; load?: () => Promise<void>; timeoutMs?: number } = {}
  ) {
    const calls: string[] = [];
    let cancel: ((url: string) => boolean) | undefined;
    const windows: Array<{ options: Record<string, unknown>; destroyed: boolean }> = [];
    const image: ShotImageLike = {
      isEmpty: () => false,
      getSize: () => ({ width: 2560, height: 1600 }),
      resize: (size) => {
        calls.push(`resize ${size.width}x${size.height}`);
        return { ...image, getSize: () => size };
      },
      toPNG: () => PNG,
    };
    const session = {
      protocol: { handle: (scheme: string) => void calls.push(`handle ${scheme}`) },
      webRequest: {
        onBeforeRequest: (listener: (d: { url: string }, cb: (r: { cancel?: boolean }) => void) => void) => {
          cancel = (u) => {
            let out = false;
            listener({ url: u }, (r) => (out = r.cancel === true));
            return out;
          };
        },
      },
      setPermissionRequestHandler: () => void calls.push('permissions refused'),
      setPermissionCheckHandler: () => undefined,
      on: () => undefined,
      setProxy: (config: { proxyRules: string; proxyBypassRules: string }) => {
        calls.push(`proxy ${config.proxyRules} ${config.proxyBypassRules}`);
        return Promise.resolve();
      },
      enableNetworkEmulation: (o: { offline: boolean }) => void calls.push(`offline ${o.offline}`),
    };
    const partitions: string[] = [];
    const render = electronPageRenderer({
      fromPartition: (partition) => {
        partitions.push(partition);
        return session;
      },
      createWindow: (opts) => {
        const win = { options: opts, destroyed: false };
        windows.push(win);
        return {
          loadURL: options.load ?? (() => Promise.resolve()),
          destroy: () => void (win.destroyed = true),
          isDestroyed: () => win.destroyed,
          webContents: {
            setWindowOpenHandler: () => undefined,
            on: () => undefined,
            setAudioMuted: () => undefined,
            capturePage: options.capture ?? (() => Promise.resolve(image)),
          },
        };
      },
      scope: { resolve: () => ({ ok: false as const, reason: 'out-of-scope' as const }) },
      log,
      timeoutMs: options.timeoutMs ?? 5000,
    });
    return { render, calls, windows, partitions, cancel: (u: string) => cancel!(u) };
  }

  it('the session is its own, offline, behind a proxy that is not there, and set up once', async () => {
    const { render, calls, partitions } = standIns();
    await render('/p/a.html');
    await render('/p/b.html');
    expect(partitions).toEqual([PAGE_SHOT_PARTITION]);
    // in memory: a `persist:` partition would write the page's storage to disk
    expect(PAGE_SHOT_PARTITION).not.toMatch(/^persist:/);
    expect(calls).toContain('handle file');
    expect(calls).toContain('offline true');
    // loopback is NOT exempt: a service on this machine is as out of reach as the web
    expect(calls).toContain('proxy http://127.0.0.1:1 <-loopback>');
    expect(calls.filter((c) => c.startsWith('proxy'))).toHaveLength(1);
  });

  it('⚠️ every request but a file of ours or inline bytes is cancelled', () => {
    const { render, cancel } = standIns();
    return render('/p/a.html').then(() => {
      for (const u of ['https://x.example/a.css', 'http://127.0.0.1:8080/', 'ws://x.example/', 'ftp://x/', 'blob:x', 'about:blank', 'chrome://gpu']) {
        expect(cancel(u)).toBe(true);
      }
      expect(cancel('file:///p/a.css')).toBe(false);
      expect(cancel('data:image/png;base64,AAAA')).toBe(false);
      expect(isPageShotRequestAllowed('FILE:///p/a.css')).toBe(true);
      expect(isPageShotRequestAllowed(' https://x.example/')).toBe(false);
    });
  });

  it('the window runs no script, shows nowhere, and is closed when the picture is taken', async () => {
    const { render, windows, calls } = standIns();
    const shot = await render('/p/a.html');
    expect(shot.png).toBe(PNG);
    const [win] = windows;
    expect(win.destroyed).toBe(true);
    expect(win.options).toMatchObject({ show: false, focusable: false, skipTaskbar: true });
    expect(win.options.webPreferences).toMatchObject({
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    });
    // a display at 200% hands back twice the pixels: the picture is the size that was promised
    expect(calls).toContain('resize 1280x800');
  });

  it('⚠️ ONE time limit over the load AND the capture: a capture that never answers closes the window', async () => {
    const stuck = standIns({ capture: () => new Promise<ShotImageLike>(() => undefined), timeoutMs: 300 });
    await expect(stuck.render('/p/a.html')).rejects.toThrow('too long');
    expect(stuck.windows[0].destroyed).toBe(true);
    const loading = standIns({ load: () => new Promise<void>(() => undefined), timeoutMs: 40 });
    await expect(loading.render('/p/a.html')).rejects.toThrow('too long');
    expect(loading.windows[0].destroyed).toBe(true);
  });

  it('a load that fails closes the window too', async () => {
    const { render, windows } = standIns({ load: () => Promise.reject(new Error('ERR_FILE_NOT_FOUND')) });
    await expect(render('/p/a.html')).rejects.toThrow('ERR_FILE_NOT_FOUND');
    expect(windows[0].destroyed).toBe(true);
  });
});
