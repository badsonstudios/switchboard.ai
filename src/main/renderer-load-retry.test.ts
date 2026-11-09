// A main window whose page failed to load gets the page again (#1592).
import { describe, it, expect } from 'vitest';
import { ERR_ABORTED, retryFailedRendererLoad, type LoadEvents } from './renderer-load-retry';

type FailListener = (e: unknown, code: number, desc: string, url: string, main: boolean) => void;

/** A fake WebContents that loads whatever the test says the next load does. */
function fakeContents() {
  const fail: FailListener[] = [];
  const finish: Array<() => void> = [];
  let url = '';
  let destroyed = false;
  const contents: LoadEvents = {
    on(event: string, listener: unknown) {
      if (event === 'did-fail-load') fail.push(listener as FailListener);
      if (event === 'did-finish-load') finish.push(listener as () => void);
      return contents;
    },
    isDestroyed: () => destroyed,
    getURL: () => url,
  };
  return {
    contents,
    /**
     * A failed main-frame load: Chromium reports it, then finishes its error
     * page — and at that moment `getURL()` still reads as the page asked for
     * (measured in the real app), so the URL cannot be what tells them apart.
     */
    failLoad(code = -102, main = true) {
      url = 'http://127.0.0.1:5/index.html';
      for (const l of fail) l({}, code, 'ERR_CONNECTION_REFUSED', url, main);
      for (const l of finish) l();
      url = 'chrome-error://chromewebdata/';
    },
    okLoad() {
      url = 'http://127.0.0.1:5/index.html';
      for (const l of finish) l();
    },
    destroy() {
      destroyed = true;
    },
  };
}

function recordingLog() {
  const lines: Array<{ level: string; msg: string; fields?: unknown }> = [];
  const at = (level: string) => (msg: string, fields?: unknown) => void lines.push({ level, msg, fields });
  return { log: { info: at('info'), warn: at('warn'), error: at('error') }, lines };
}

function harness(retries?: number) {
  const c = fakeContents();
  const { log, lines } = recordingLog();
  const queued: Array<{ fn: () => void; ms: number }> = [];
  let loads = 0;
  retryFailedRendererLoad(c.contents, {
    load: () => {
      loads += 1;
      return Promise.resolve();
    },
    log,
    retries,
    schedule: (fn, ms) => void queued.push({ fn, ms }),
  });
  const runQueued = () => {
    for (const q of queued.splice(0)) q.fn();
  };
  return { c, lines, queued, runQueued, loads: () => loads };
}

describe('a window whose page failed to load (#1592)', () => {
  it('logs the failure and loads the page again, then says it recovered', () => {
    const h = harness();
    h.c.failLoad();
    expect(h.lines).toEqual([
      {
        level: 'warn',
        msg: 'the window failed to load its page; loading it again',
        fields: {
          errorCode: -102,
          errorDescription: 'ERR_CONNECTION_REFUSED',
          url: 'http://127.0.0.1:5/index.html',
          attempt: 0,
        },
      },
    ]);
    // the error page finishing is NOT the recovery
    expect(h.lines.some((l) => l.msg.includes('on a retry'))).toBe(false);
    expect(h.queued.map((q) => q.ms)).toEqual([250]);
    h.runQueued();
    expect(h.loads()).toBe(1);
    h.c.okLoad();
    expect(h.lines.at(-1)).toEqual({
      level: 'info',
      msg: 'the window loaded its page on a retry',
      fields: { attempt: 1 },
    });
  });

  it('stops after the retries run out, and says so at error', () => {
    const h = harness(2);
    for (let i = 0; i < 3; i++) {
      h.c.failLoad();
      h.runQueued();
    }
    expect(h.loads()).toBe(2);
    expect(h.lines.map((l) => l.level)).toEqual(['warn', 'warn', 'error']);
    expect(h.lines[2].msg).toBe('the window could not load its page; giving up');
  });

  it('leaves a replaced load (ERR_ABORTED) and a subframe alone', () => {
    const h = harness();
    h.c.failLoad(ERR_ABORTED);
    h.c.failLoad(-102, false);
    expect(h.queued).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  it('does not touch a window that was closed before the retry came round', () => {
    const h = harness();
    h.c.failLoad();
    h.c.destroy();
    h.runQueued();
    expect(h.loads()).toBe(0);
  });

  it('a page that loads first time logs nothing', () => {
    const h = harness();
    h.c.okLoad();
    expect(h.lines).toEqual([]);
  });
});
