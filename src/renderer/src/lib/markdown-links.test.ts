// @vitest-environment jsdom
// Clicking a link in a reply (#527).
//
// THE INPUT IS REAL, not hand-built HTML: every case renders its markdown
// through `renderMarkdown` — the app's actual `marked` + DOMPurify pipeline —
// and clicks the anchor that comes out. That is the only way this proves
// anything about hostile input: a test that writes `<a href="javascript:…">`
// into a div by hand is testing a string the app can never produce, and would
// stay green if the sanitizer's URI policy changed underneath it.
//
// The two halves are deliberately tested apart: what the SANITIZER leaves in
// the DOM (some hostile hrefs never survive it) and what the HANDLER does with
// whatever is there (which must not depend on the sanitizer having helped).
import { describe, it, expect, vi } from 'vitest';
import { renderMarkdown } from './markdown';
import { handleMarkdownLinkClick, type LinkClickVerdict } from './markdown-links';
import { ipcRefusal } from '../../../shared/ipc/refusal';

/** Render markdown for real, then click the nth anchor in it. */
async function clickLink(
  markdown: string,
  opts: { open?: (url: string) => Promise<unknown>; nth?: number } = {}
): Promise<{ verdict: LinkClickVerdict; prevented: boolean; warned: string[]; opened: string[] }> {
  const host = document.createElement('div');
  host.innerHTML = renderMarkdown(markdown);
  const anchor = host.querySelectorAll('a')[opts.nth ?? 0];
  if (!anchor) throw new Error(`no anchor in: ${host.innerHTML}`);
  const opened: string[] = [];
  const warned: string[] = [];
  let prevented = false;
  const verdict = await handleMarkdownLinkClick(
    { target: anchor, preventDefault: () => (prevented = true) },
    {
      openExternal: async (url) => {
        opened.push(url);
        return opts.open ? opts.open(url) : true;
      },
      warn: (m) => warned.push(m),
    }
  );
  return { verdict, prevented, warned, opened };
}

describe('a link in a reply reaches the browser', () => {
  it('an https link is handed to main, and never navigates this window', async () => {
    const r = await clickLink('See [the docs](https://example.test/a?b=1#c).');
    expect(r.verdict).toBe('opened');
    expect(r.opened).toEqual(['https://example.test/a?b=1#c']);
    // The whole bug: the default action is what main silently swallowed.
    expect(r.prevented).toBe(true);
    expect(r.warned).toEqual([]);
  });

  it('http and mailto go too — the same list main will accept', async () => {
    expect((await clickLink('[x](http://plain.test/)')).opened).toEqual(['http://plain.test/']);
    expect((await clickLink('[mail](mailto:dan@example.test)')).opened).toEqual([
      'mailto:dan@example.test',
    ]);
  });

  it('a bare autolink counts — GFM turns it into an anchor with no syntax at all', async () => {
    const r = await clickLink('read https://auto.test/page for more');
    expect(r.verdict).toBe('opened');
    expect(r.opened).toEqual(['https://auto.test/page']);
  });

  it('the click can land on something INSIDE the link and still work', async () => {
    // `closest('a')`, not `target.href`: the click target is the <code>.
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('[`npm test`](https://inner.test/x)');
    const inner = host.querySelector('code')!;
    const opened: string[] = [];
    const verdict = await handleMarkdownLinkClick(
      { target: inner, preventDefault: () => {} },
      { openExternal: async (u) => (opened.push(u), true), warn: () => {} }
    );
    expect(verdict).toBe('opened');
    expect(opened).toEqual(['https://inner.test/x']);
  });

  it('a click on ordinary prose is not a link click, and says so', async () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('just some words');
    const open = vi.fn();
    const prevent = vi.fn();
    const verdict = await handleMarkdownLinkClick(
      { target: host.querySelector('p'), preventDefault: prevent },
      { openExternal: open }
    );
    // 'ignored' AND no preventDefault: the surface's other handlers — the copy
    // button, the expanders — must still get their turn.
    expect(verdict).toBe('ignored');
    expect(prevent).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('hostile hrefs are inert — the real payloads, through the real pipeline', () => {
  // Each of these is a string an agent could be talked into emitting. The
  // markdown form and the raw-HTML form both, because they take different
  // routes through `marked` and the raw one is the input §5.30 distrusts.
  const hostile: ReadonlyArray<readonly [string, string]> = [
    ['a javascript: link', '[click me](javascript:globalThis.__pwned=1)'],
    ['a javascript: link in raw HTML', '<a href="javascript:globalThis.__pwned=1">click me</a>'],
    ['javascript: with a newline inside the scheme', '<a href="java\nscript:alert(1)">x</a>'],
    ['a data: URL that is a whole HTML document', '<a href="data:text/html,<script>1</script>">x</a>'],
    ['a file: URL pointing at a real executable', '[open](file:///C:/Windows/System32/calc.exe)'],
    ['a UNC path as a file URL', '<a href="file://attacker.test/share/x.exe">x</a>'],
    ['vbscript:', '<a href="vbscript:msgbox(1)">x</a>'],
    ['a scheme nobody has thought of yet', '<a href="ms-settings:windowsupdate">x</a>'],
    ['an app-protocol deep link', '<a href="steam://run/1">x</a>'],
  ];

  for (const [what, markdown] of hostile) {
    it(`${what} never reaches openExternal`, async () => {
      const host = document.createElement('div');
      host.innerHTML = renderMarkdown(markdown);
      const anchor = host.querySelector('a');
      // Two legitimate outcomes, and the test accepts either: the sanitizer
      // may have removed the href already, or it survived and the handler must
      // refuse it. What is NOT acceptable is a call to openExternal, or a
      // default action left un-prevented on a live hostile href.
      const opened: string[] = [];
      let prevented = false;
      const verdict = await handleMarkdownLinkClick(
        { target: anchor, preventDefault: () => (prevented = true) },
        { openExternal: async (u) => (opened.push(u), true), warn: () => {} }
      );
      expect(opened).toEqual([]);
      if (anchor?.hasAttribute('href')) {
        expect(verdict).toBe('blocked');
        expect(prevented).toBe(true);
      } else {
        // Nothing to click through to: DOMPurify dropped the attribute, so
        // this is not a link click at all. `.feed-md a:not([href])` in
        // `tokens.css` takes the link PAINT off it for the same reason — an
        // affordance with no destination behind it is the complaint #527 was
        // filed over.
        expect(verdict).toBe('ignored');
      }
    });
  }

  it('MEASURED, so nobody reads the block above as more than it is', async () => {
    // Every one of the payloads loses its href in the pipeline TODAY
    // (DOMPurify's URI regexp admits ftp/http(s)/mailto/tel/callto/sms/cid/
    // xmpp and nothing else with a scheme). Recorded as an assertion rather
    // than a comment: if a DOMPurify bump ever lets one through, this line
    // goes red and points at the tests below, which are the layer that
    // actually holds.
    for (const [what, markdown] of hostile) {
      const host = document.createElement('div');
      host.innerHTML = renderMarkdown(markdown);
      expect(host.querySelector('a')?.getAttribute('href') ?? null, what).toBeNull();
    }
  });
});

describe('the handler refuses them ON ITS OWN, without the sanitizer', () => {
  // The layer that must not depend on the layer above it (#465's lesson, and
  // `decoration-guard.test.ts`'s shape): the hrefs are FORCED onto the anchor,
  // exactly as they would arrive if DOMPurify's URI policy changed, if a
  // surface built its HTML some other way, or if a future decoration pass put
  // an href back. The handler is the last thing between these and the OS.
  const forced = [
    'javascript:globalThis.__pwned=1',
    // The classic bypasses, byte for byte: a leading newline, a tab inside the
    // scheme, and mixed case. `new URL` normalises all three to `javascript:`.
    '\njavascript:alert(1)',
    'java\tscript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'file:///C:/Windows/System32/calc.exe',
    'vbscript:msgbox(1)',
    'ms-settings:windowsupdate',
    'steam://run/1',
    'chrome://settings',
    // `mailto` is allowed, `mailto2` must not ride in on a prefix match.
    'mailto2:dan@example.test',
    // Neither may an allowlisted scheme appearing somewhere other than the front.
    'notascheme:https://example.test/',
  ];

  for (const href of forced) {
    it(`refuses ${JSON.stringify(href.slice(0, 40))} and prevents the navigation`, async () => {
      const a = document.createElement('a');
      a.setAttribute('href', href);
      a.textContent = 'click me';
      const opened: string[] = [];
      const warned: string[] = [];
      let prevented = false;
      const verdict = await handleMarkdownLinkClick(
        { target: a, preventDefault: () => (prevented = true) },
        { openExternal: async (u) => (opened.push(u), true), warn: (m) => warned.push(m) }
      );
      expect(verdict).toBe('blocked');
      expect(opened).toEqual([]);
      // The important one: nothing navigates, whatever the scheme was.
      expect(prevented).toBe(true);
      expect(warned.join(' ')).toContain('refused');
    });
  }

  // Belt to the sanitizer's braces: none of the payloads above — rendered or
  // forced — ran while any of this was built.
  it('nothing executed on the way through', () => {
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('an empty or whitespace href is a link to nowhere, not a call', async () => {
    const host = document.createElement('div');
    host.innerHTML = '<a href="   ">blank</a>';
    const opened: string[] = [];
    const verdict = await handleMarkdownLinkClick(
      { target: host.querySelector('a'), preventDefault: () => {} },
      { openExternal: async (u) => (opened.push(u), true), warn: () => {} }
    );
    expect(verdict).toBe('blocked');
    expect(opened).toEqual([]);
  });

  it('a RELATIVE link in a reply is not a file the conversation can open', async () => {
    // The viewer navigates these; the feed has no document to be relative TO,
    // and `./x.md` is not something to hand a browser either.
    const r = await clickLink('[the plan](./docs/plans/00-process.md)');
    expect(r.verdict).toBe('blocked');
    expect(r.opened).toEqual([]);
    expect(r.prevented).toBe(true);
  });
});

describe('an in-document #fragment', () => {
  it('is prevented and dropped — a conversation is not a document', async () => {
    const r = await clickLink('[jump](#somewhere)');
    expect(r.verdict).toBe('fragment');
    expect(r.opened).toEqual([]);
    // Prevented, because the alternative is the window navigating to
    // `app://…/#somewhere`, which main would swallow anyway — and because the
    // feed's own ids are its decoration protocol, not headings to scroll to.
    expect(r.prevented).toBe(true);
    expect(r.warned).toEqual([]);
  });
});

describe('a refusal is not a success (#440)', () => {
  it('an IpcRefusal OBJECT is refused, not read as "opened" for being truthy', async () => {
    const r = await clickLink('[x](https://example.test/)', {
      open: async () => ipcRefusal('fs:openExternal', 'capability-not-held'),
    });
    expect(r.verdict).toBe('refused');
    expect(r.warned.join(' ')).toContain('capability-not-held');
  });

  it('a plain false from main is refused too', async () => {
    const r = await clickLink('[x](https://example.test/)', { open: async () => false });
    expect(r.verdict).toBe('refused');
    expect(r.warned.join(' ')).toContain('did not open');
  });

  it('a window with NO bridge at all does nothing and says so', async () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown('[x](https://example.test/)');
    const warned: string[] = [];
    let prevented = false;
    const verdict = await handleMarkdownLinkClick(
      { target: host.querySelector('a'), preventDefault: () => (prevented = true) },
      { warn: (m) => warned.push(m) }
    );
    expect(verdict).toBe('refused');
    expect(prevented).toBe(true);
    expect(warned).toHaveLength(1);
  });
});
