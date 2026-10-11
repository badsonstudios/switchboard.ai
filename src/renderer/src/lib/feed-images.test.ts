// @vitest-environment jsdom
// Pictures in the conversation (#1235): what a reply's `<img>` becomes.
//
// The pass runs on SANITIZED html, through `decorateFeedMarkdown`, which is
// the only way production reaches it, so that is how it is tested: the guard
// that takes both namespaces back is part of what is being claimed.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { decorateFeedMarkdown } from './feed-markdown';
import {
  capFeedImage,
  chipForFailedFeedImage,
  FEED_IMAGE_MAX_HEIGHT,
  FEED_OPEN_PATH_ATTR,
  type FeedImageLabels,
} from './feed-images';
import { FEED_STOP_SELECTOR } from './feed-keys';
import { forgetImageSizes, rememberImageSize } from './document-render';
import { docImagePath } from '../../../shared/doc-image';

const CODE = { copy: 'Copy', copied: 'Copied', copyCode: 'Copy code' };
const LABELS: FeedImageLabels = {
  copy: 'Copy',
  image: 'Image',
  openInBrowser: 'Open in browser',
  mediaOmitted: 'Media not shown',
  openPicture: (name) => `Open ${name} at full size`,
  openPage: 'Open in browser',
  notShown: 'Not shown.',
};
const FOLDER = 'C:\\work\\app';

function pass(html: string, opts: { folder?: string; streaming?: boolean } = { folder: FOLDER }): HTMLElement {
  const out = decorateFeedMarkdown(html, CODE, {
    streaming: opts.streaming,
    images: { labels: LABELS, folder: opts.folder },
  });
  const host = document.createElement('div');
  host.innerHTML = out;
  return host;
}
const shown = (host: HTMLElement): HTMLImageElement[] => [...host.querySelectorAll<HTMLImageElement>('img')];
const chips = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.doc-image-chip')];

describe('a picture in a reply (#1235)', () => {
  it('a path relative to the session’s folder is SHOWN, through the one scheme main answers', () => {
    const host = pass('<p><img src="mocks/settings.svg" alt="the settings mock-up"></p>');
    const [img] = shown(host);
    expect(img.className).toBe('doc-image');
    expect(docImagePath(img.getAttribute('src'))).toBe('C:\\work\\app\\mocks\\settings.svg');
    expect(img.getAttribute('alt')).toBe('the settings mock-up');
    expect(chips(host)).toHaveLength(0);
  });

  it('an absolute path is shown as it is; `./` and `..` are collapsed', () => {
    expect(docImagePath(shown(pass('<img src="D:/scratch/a.png">'))[0].getAttribute('src'))).toBe('D:\\scratch\\a.png');
    expect(docImagePath(shown(pass('<img src="./b.png">'))[0].getAttribute('src'))).toBe('C:\\work\\app\\b.png');
    expect(docImagePath(shown(pass('<img src="../c.png">'))[0].getAttribute('src'))).toBe('C:\\work\\c.png');
  });

  it('every shown picture is the content of a NAMED BUTTON that opens the file', () => {
    const host = pass('<img src="a.png" alt="A chart"><img src="charts/b.png">');
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button.feed-image-open')];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute('aria-label')).toBe('Open A chart at full size');
    expect(buttons[0].getAttribute(FEED_OPEN_PATH_ATTR)).toBe('C:\\work\\app\\a.png');
    expect(buttons[0].querySelector('img')).not.toBeNull();
    // no alt text: the file's name, never an empty name
    expect(buttons[1].getAttribute('aria-label')).toBe('Open b.png at full size');
  });

  it('⚠️ a REMOTE picture is a chip and never an <img>: fetching it is a beacon', () => {
    for (const src of ['https://evil.example/pixel.png', 'http://x.example/a.gif', '//x.example/a.png']) {
      const host = pass(`<img src="${src}" alt="badge">`);
      expect(shown(host), src).toHaveLength(0);
      expect(chips(host), src).toHaveLength(1);
    }
    // an http(s) one offers the browser
    const chip = chips(pass('<img src="https://x.example/a.png" alt="badge">'))[0];
    expect(chip.querySelector('[data-doc-external]')!.getAttribute('data-doc-external')).toBe(
      'https://x.example/a.png'
    );
  });

  it('⚠️ no other scheme becomes a picture either: data:, file:, blob:, and our own', () => {
    for (const src of [
      'data:image/png;base64,AAAA',
      'file:///C:/Windows/win.ini',
      'blob:https://x/1',
      'sb-doc-image://local/?path=C%3A%5Csecret.png',
    ]) {
      expect(shown(pass(`<img src="${src}">`)), src).toHaveLength(0);
    }
  });

  it('a file that is not a picture by name is a chip, whatever the syntax said', () => {
    const host = pass('<img src="notes.txt"><img src="archive.zip">');
    expect(shown(host)).toHaveLength(0);
    expect(chips(host)).toHaveLength(2);
  });

  it('with no folder, and while a reply is still arriving, every picture is a chip', () => {
    expect(shown(pass('<img src="a.png">', {}))).toHaveLength(0);
    expect(chips(pass('<img src="a.png">', {}))).toHaveLength(1);
    // streaming: the tail is re-rendered per chunk, and a picture there would be re-fetched each time
    const arriving = pass('<img src="a.png">', { folder: FOLDER, streaming: true });
    expect(shown(arriving)).toHaveLength(0);
    expect(chips(arriving)).toHaveLength(1);
  });

  it('⚠️ a reply cannot FORGE one of ours: both namespaces are taken back first', () => {
    // a remote <img> dressed as a picture we offered, and a link carrying a path to open
    const host = pass(
      '<img class="doc-image" src="https://evil.example/p.png">' +
        '<a href="https://ok.example" class="feed-image-open">x</a>' +
        '<span class="doc-image-chip">fake</span>'
    );
    expect(shown(host)).toHaveLength(0);
    expect(host.querySelector('a')!.className).toBe('');
    // the only chip is the one this pass made for the remote picture
    expect(chips(host)).toHaveLength(1);
    expect(host.querySelector(`[${FEED_OPEN_PATH_ATTR}]`)).toBeNull();
  });

  it('nothing the reply wrote on its <img> survives but the alt and a plain pixel width', () => {
    const host = pass('<img src="a.png" alt="x" width="200" height="4000" id="i" title="t" style="position:fixed">');
    const [img] = shown(host);
    expect(img.getAttribute('width')).toBe('200');
    expect(img.hasAttribute('height')).toBe(false);
    expect(img.hasAttribute('id')).toBe(false);
    expect(img.hasAttribute('style')).toBe(false);
    expect(img.hasAttribute('title')).toBe(false);
  });
});

describe('the conversation stays ONE tab stop (#1235)', () => {
  it('every control this pass adds is reached by the arrow keys and takes no Tab stop', () => {
    const host = pass(
      '<img src="a.png"> <img src="https://x.example/b.png"> <img src="page.html">'
    );
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons).toHaveLength(3);
    for (const b of buttons) {
      expect(b.getAttribute('tabindex')).toBe('-1');
      expect(b.matches(FEED_STOP_SELECTOR)).toBe(true);
    }
  });
});

describe('room for a picture, under the height cap (#1235)', () => {
  it('a picture seen before reserves its room at the size it will be DRAWN, shape kept', () => {
    forgetImageSizes();
    // first sight: nothing known, nothing reserved
    const first = shown(pass('<img src="tall.png">'))[0];
    expect(first.hasAttribute('height')).toBe(false);
    // it loads, 800 x 2100
    Object.defineProperty(first, 'naturalWidth', { value: 800 });
    Object.defineProperty(first, 'naturalHeight', { value: 2100 });
    expect(rememberImageSize(first)).toBe(true);
    capFeedImage(first);
    expect(first.getAttribute('height')).toBe(String(FEED_IMAGE_MAX_HEIGHT));
    expect(first.getAttribute('width')).toBe('160');
    // the NEXT render of the same reply has the room before the bytes
    const again = shown(pass('<img src="tall.png">'))[0];
    expect(again.getAttribute('width')).toBe('160');
    expect(again.getAttribute('height')).toBe(String(FEED_IMAGE_MAX_HEIGHT));
    forgetImageSizes();
  });

  it('a picture already under the cap is left at its own size; one of unknown size is left alone', () => {
    const img = document.createElement('img');
    img.setAttribute('width', '320');
    img.setAttribute('height', '120');
    capFeedImage(img);
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['320', '120']);
    const unknown = document.createElement('img');
    capFeedImage(unknown);
    expect(unknown.hasAttribute('width')).toBe(false);
    capFeedImage(null);
  });

  it('the stylesheet’s backstop is the same number, and does not switch the width attribute off', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'src', 'theme', 'tokens.css'), 'utf8');
    const rule = css.slice(css.indexOf('.feed-md .doc-image {'));
    const body = rule.slice(0, rule.indexOf('}')).replace(/[/][*][^]*?[*][/]/g, '');
    expect(body).toContain(`max-block-size: ${FEED_IMAGE_MAX_HEIGHT}px`);
    expect(body).not.toMatch(/(^|[^-])inline-size:/);
  });
});

describe('an HTML mock-up (#1235)', () => {
  it('however the name is spelled: a query, a fragment and capitals are a page; a disguise is not', () => {
    const open = (href: string): string | null =>
      pass(`<a href="${href}">x</a>`).querySelector('a')!.getAttribute(FEED_OPEN_PATH_ATTR);
    expect(open('page.html?x=1')).toBe('C:\\work\\app\\page.html');
    expect(open('page.html#top')).toBe('C:\\work\\app\\page.html');
    expect(open('PAGE.HTML')).toBe('C:\\work\\app\\PAGE.HTML');
    // decoded before it is judged: this is `evil.exe`, and it is not a page
    expect(open('evil%2Eexe')).toBeNull();
    expect(open('page.html.exe')).toBeNull();
    // a network address, spelled plainly or percent-encoded, is never a local page
    expect(open('//host/share/a.html')).toBeNull();
    expect(open('%5C%5Chost%5Cshare%5Ca.html') ?? '').not.toMatch(/^[\\/]{2}/);
  });

  it('a link to a local .html file is marked openable; other links are untouched', () => {
    const host = pass(
      '<a href="mock/index.html">the mock</a> <a href="https://x.example/a.html">web</a> <a href="notes.md">notes</a>'
    );
    const [local, web, notes] = [...host.querySelectorAll('a')];
    expect(local.getAttribute(FEED_OPEN_PATH_ATTR)).toBe('C:\\work\\app\\mock\\index.html');
    expect(web.hasAttribute(FEED_OPEN_PATH_ATTR)).toBe(false);
    expect(notes.hasAttribute(FEED_OPEN_PATH_ATTR)).toBe(false);
  });

  it('written with picture syntax it is a chip with "Open in browser", never a frame', () => {
    const host = pass('<img src="mock.html" alt="the page">');
    expect(shown(host)).toHaveLength(0);
    expect(host.querySelector('iframe')).toBeNull();
    const open = chips(host)[0].querySelector<HTMLButtonElement>(`button[${FEED_OPEN_PATH_ATTR}]`)!;
    expect(open.textContent).toBe('Open in browser');
    expect(open.getAttribute(FEED_OPEN_PATH_ATTR)).toBe('C:\\work\\app\\mock.html');
  });

  it('without a folder nothing is openable', () => {
    const host = pass('<a href="mock.html">m</a><img src="mock.html">', {});
    expect(host.querySelector(`[${FEED_OPEN_PATH_ATTR}]`)).toBeNull();
  });
});

describe('a picture that would not load (#1235)', () => {
  it('its BUTTON is swapped for a chip that names it and says why', () => {
    const host = pass('<p>before <img src="gone.png" alt="old chart"> after</p>');
    document.body.appendChild(host);
    const img = shown(host)[0];
    expect(chipForFailedFeedImage(img, LABELS)).toBe(true);
    expect(shown(host)).toHaveLength(0);
    // the button went with it: it would have opened a file that did not load
    expect(host.querySelector('button.feed-image-open')).toBeNull();
    const [chip] = chips(host);
    expect(chip.textContent).toContain('old chart');
    expect(chip.textContent).toContain('Not shown.');
    expect(host.textContent).toContain('before');
    expect(host.textContent).toContain('after');
    host.remove();
  });

  it('answers false for anything that is not a picture this pass offered', () => {
    const stray = document.createElement('img');
    expect(chipForFailedFeedImage(stray, LABELS)).toBe(false);
    expect(chipForFailedFeedImage(document.createElement('div'), LABELS)).toBe(false);
    expect(chipForFailedFeedImage(null, LABELS)).toBe(false);
  });
});

describe('a caller with no words for pictures', () => {
  it('leaves the pictures exactly as the sanitizer left them (the update notes, the approval preview)', () => {
    const out = decorateFeedMarkdown('<img src="a.png">', CODE);
    expect(out).toContain('<img src="a.png">');
  });
});
