// A conversation's picture, on its two ways out of main (#1240).
//
// What these REFUSE is the deliverable, as it is for the picture handler next
// door: a handle is the only thing the page can name, and a handle that is
// malformed, never minted, or let go must be answered with nothing.
import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createLogger, LogSink } from '../log/logger';
import { tempDir } from '../../test-temp-dirs';
import { feedPictureUrl } from '../../shared/feed-picture';
import { docImageUrl } from '../../shared/doc-image';
import { registerDocImageProtocol } from '../fs/doc-image';
import { ReadScope } from '../fs/read-scope';
import { FeedPictureStore } from './pictures';
import {
  MAX_FEED_PICTURE_PIXELS,
  MAX_RAW_FEED_PICTURE_BYTES,
  createFeedPictureAnswer,
  emptyFeedPictureDir,
  openFeedPicture,
} from './picture-serve';

const log = createLogger(new LogSink({ dir: tempDir('sb-feedpic-log-') }), 'fs');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4zwAE/wEHAAH/4iOeWQAAAABJRU5ErkJggg==';
const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

/** bytes whose header says this kind and size, padded to `length` */
function fake(kind: 'gif' | 'webp' | 'jpeg' | 'png', length = 64, side = 320): string {
  const head: Record<string, number[]> = {
    gif: [...Buffer.from('GIF89a'), side & 255, side >> 8, side & 255, side >> 8],
    webp: [
      ...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8X'), 10, 0, 0, 0, 0, 0, 0, 0,
      (side - 1) & 255, (side - 1) >> 8, 0, (side - 1) & 255, (side - 1) >> 8, 0,
    ],
    jpeg: [0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, side >> 8, side & 255, side >> 8, side & 255],
    png: [
      0x89, ...Buffer.from('PNG'), 13, 10, 26, 10, 0, 0, 0, 13, ...Buffer.from('IHDR'),
      0, 0, side >> 8, side & 255, 0, 0, side >> 8, side & 255, 8, 2, 0, 0, 0,
    ],
  };
  const out = Buffer.alloc(Math.max(length, head[kind].length + 1), 1);
  Buffer.from(head[kind]).copy(out);
  return out.toString('base64');
}

function kept(type = 'image/png', data = PNG): FeedPictureStore {
  const store = new FeedPictureStore(64 * 1024 * 1024, () => ID);
  store.keep({}, [{ type, data }]);
  return store;
}

describe('the thumbnail, by handle', () => {
  it('answers with what was drawn, and draws each picture once', () => {
    const draw = vi.fn(() => ({ body: Buffer.from('small'), mime: 'image/png' }));
    const answer = createFeedPictureAnswer({ store: kept(), draw, log });
    const first = answer(feedPictureUrl(ID));
    expect(first).toEqual({ ok: true, body: Buffer.from('small'), mime: 'image/png' });
    answer(feedPictureUrl(ID));
    expect(draw).toHaveBeenCalledTimes(1);
    // ...and it was handed the picture's own bytes and type
    expect(draw).toHaveBeenCalledWith(Buffer.from(PNG, 'base64'), 'image/png');
  });

  it('stops answering a thumbnail it drew once the picture itself has been let go', () => {
    // the thumbnail is a BUTTON: offering one whose picture cannot be opened
    // is a press that does nothing
    const store = kept();
    const answer = createFeedPictureAnswer({
      store,
      draw: () => ({ body: Buffer.from('small'), mime: 'image/png' }),
      log,
    });
    expect(answer(feedPictureUrl(ID)).ok).toBe(true);
    store.drop([ID]);
    expect(answer(feedPictureUrl(ID))).toEqual({ ok: false, reason: 'not-found' });
  });

  it('never hands a decoder a picture whose header declares too many pixels', () => {
    // 27 bytes that say 60000 x 60000. Decoding would allocate 14 GB.
    const draw = vi.fn(() => null);
    const answer = createFeedPictureAnswer({ store: kept('image/png', fake('png', 40, 60000)), draw, log });
    expect(answer(feedPictureUrl(ID))).toEqual({ ok: false, reason: 'too-large' });
    expect(MAX_FEED_PICTURE_PIXELS).toBeLessThan(60000 * 60000);
    expect(draw).not.toHaveBeenCalled();
    // ...and it is not decoded from base64 again on the next ask
    answer(feedPictureUrl(ID));
    expect(draw).not.toHaveBeenCalled();
  });

  it('refuses bytes that are not the kind of picture the message called them', () => {
    const draw = vi.fn(() => null);
    for (const [type, data] of [
      ['image/jpeg', PNG], // a real PNG, labelled JPEG
      ['image/png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')],
      ['image/png', Buffer.from('MZ this is a program').toString('base64')],
      ['image/gif', 'AAAA'],
    ] as const) {
      const answer = createFeedPictureAnswer({ store: kept(type, data), draw, log });
      expect(answer(feedPictureUrl(ID)), type).toEqual({ ok: false, reason: 'not-an-image' });
    }
    expect(draw).not.toHaveBeenCalled();
  });

  it('refuses a handle that names nothing: never minted, or gone', () => {
    const answer = createFeedPictureAnswer({ store: kept(), draw: () => null, log });
    expect(answer(feedPictureUrl(OTHER))).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses anything that is not a handle, and never reads it as a path', () => {
    const draw = vi.fn(() => null);
    const answer = createFeedPictureAnswer({ store: kept(), draw, log });
    for (const url of [
      'sb-doc-image://feed/?id=..%2F..%2Fsecret.png',
      'sb-doc-image://feed/?id=',
      'sb-doc-image://feed/?path=C%3A%5Csecret.png',
      `sb-doc-image://feed/?id=${ID}x`,
      docImageUrl('C:\\secret.png'),
      'not a url',
      42,
    ]) {
      expect(answer(url), String(url)).toEqual({ ok: false, reason: 'invalid-path' });
    }
    expect(draw).not.toHaveBeenCalled();
  });

  it('serves a picture main cannot draw as it is, when it is small', () => {
    const webp = fake('webp');
    const answer = createFeedPictureAnswer({ store: kept('image/webp', webp), draw: () => null, log });
    const got = answer(feedPictureUrl(ID));
    expect(got).toEqual({ ok: true, body: Buffer.from(webp, 'base64'), mime: 'image/webp' });
  });

  it('refuses one it cannot draw that is large: that is what a thumbnail is for', () => {
    const big = fake('gif', MAX_RAW_FEED_PICTURE_BYTES + 1);
    const answer = createFeedPictureAnswer({ store: kept('image/gif', big), draw: () => null, log });
    expect(answer(feedPictureUrl(ID))).toEqual({ ok: false, reason: 'too-large' });
  });

  it('a drawing that throws is a refusal, not a throw', () => {
    const answer = createFeedPictureAnswer({
      store: kept(),
      draw: () => {
        throw new Error('decoder fell over');
      },
      log,
    });
    expect(answer(feedPictureUrl(ID))).toEqual({ ok: false, reason: 'unreadable' });
  });
});

describe('the picture scheme, asked for a conversation’s picture', () => {
  function registered(deps: Parameters<typeof registerDocImageProtocol>[1]): (url: string) => Promise<Response> {
    let handler: ((request: { url: string }) => Promise<Response>) | undefined;
    registerDocImageProtocol({ handle: (_s, h) => (handler = h) }, deps);
    return (url) => handler!({ url });
  }
  const scope = new ReadScope({ sessionFolders: () => [], log });

  it('hands the `feed` host to the conversation’s answerer and serves what it says', async () => {
    const feed = createFeedPictureAnswer({
      store: kept(),
      draw: () => ({ body: Buffer.from('small'), mime: 'image/png' }),
      log,
    });
    const ask = registered({ scope, log, feed });
    const res = await ask(feedPictureUrl(ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('small');
    expect((await ask(feedPictureUrl(OTHER))).status).toBe(404);
  });

  it('refuses the `feed` host when nothing answers for it, without reading a path', async () => {
    const ask = registered({ scope, log });
    expect((await ask(feedPictureUrl(ID))).status).toBe(404);
  });

  it('a path smuggled onto the `feed` host is never resolved', async () => {
    const root = tempDir('sb-feedpic-root-');
    fs.writeFileSync(path.join(root, 'shot.png'), Buffer.from(PNG, 'base64'));
    const open = new ReadScope({ sessionFolders: () => [root], log });
    const feed = createFeedPictureAnswer({ store: kept(), draw: () => null, log });
    const ask = registered({ scope: open, log, feed });
    const smuggled = `sb-doc-image://feed/?path=${encodeURIComponent(path.join(root, 'shot.png'))}`;
    expect((await ask(smuggled)).status).toBe(400);
  });
});

describe('opening a picture at full size', () => {
  it('writes its own copy, named by handle and type, and opens that', async () => {
    const dir = path.join(tempDir('sb-feedpic-open-'), 'feed-pictures');
    const openPath = vi.fn(async () => '');
    const jpeg = fake('jpeg');
    expect(await openFeedPicture(ID, { store: kept('image/jpeg', jpeg), dir, openPath, log })).toBe(true);
    const file = path.join(dir, `${ID}.jpg`);
    expect(openPath).toHaveBeenCalledWith(file);
    expect(fs.readFileSync(file).equals(Buffer.from(jpeg, 'base64'))).toBe(true);
  });

  it('a second open of the same picture opens the copy that is there, and writes nothing', async () => {
    const dir = path.join(tempDir('sb-feedpic-open-'), 'feed-pictures');
    const openPath = vi.fn(async () => '');
    const deps = { store: kept(), dir, openPath, log };
    expect(await openFeedPicture(ID, deps)).toBe(true);
    const file = path.join(dir, `${ID}.png`);
    const before = fs.statSync(file).mtimeMs;
    fs.chmodSync(file, 0o444); // as a viewer holding it would make a write fail
    expect(await openFeedPicture(ID, deps)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(openPath).toHaveBeenCalledTimes(2);
    fs.chmodSync(file, 0o644);
  });

  it('never writes bytes that are not the declared kind of picture', async () => {
    const dir = path.join(tempDir('sb-feedpic-open-'), 'feed-pictures');
    const openPath = vi.fn(async () => '');
    const program = Buffer.from('MZ this is a program').toString('base64');
    expect(await openFeedPicture(ID, { store: kept('image/png', program), dir, openPath, log })).toBe(false);
    expect(await openFeedPicture(ID, { store: kept('image/gif', PNG), dir, openPath, log })).toBe(false);
    expect(openPath).not.toHaveBeenCalled();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses what is not a handle, and a handle that names nothing, and writes nothing', async () => {
    const dir = path.join(tempDir('sb-feedpic-open-'), 'feed-pictures');
    const openPath = vi.fn(async () => '');
    for (const id of ['..\\..\\evil', `${ID}/../x`, '', null, 7, OTHER]) {
      expect(await openFeedPicture(id, { store: kept(), dir, openPath, log }), String(id)).toBe(false);
    }
    expect(openPath).not.toHaveBeenCalled();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('says so when the system could not open it', async () => {
    const dir = tempDir('sb-feedpic-open-');
    const openPath = vi.fn(async () => 'no application is associated');
    expect(await openFeedPicture(ID, { store: kept(), dir, openPath, log })).toBe(false);
  });

  it('empties the folder of its own copies and leaves everything else', () => {
    const dir = tempDir('sb-feedpic-sweep-');
    fs.writeFileSync(path.join(dir, `${ID}.png`), 'a');
    fs.writeFileSync(path.join(dir, `${OTHER}.webp`), 'b');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
    fs.writeFileSync(path.join(dir, `${ID}.exe`), 'not ours either');
    expect(emptyFeedPictureDir(dir)).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual([`${ID}.exe`, 'notes.txt'].sort());
    // a folder that is not there is nothing to empty
    expect(emptyFeedPictureDir(path.join(dir, 'absent'))).toBe(0);
  });
});
