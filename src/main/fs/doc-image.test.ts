// The scoped image handler (#1080, §5.30 + §5.29).
//
// A SECURITY CHECK, like `read-scope.test.ts` next door: the scheme this
// answers is the one thing `img-src` allows beyond our own origin, so what it
// REFUSES is the deliverable. Real files under tracked temp directories and the
// real `ReadScope` — the guard under test is the composition, not a mock of it.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createLogger, LogSink } from '../log/logger';
import { tempDir } from '../../test-temp-dirs';
import { DOC_IMAGE_SCHEME, docImageUrl } from '../../shared/doc-image';
import {
  MAX_DOC_IMAGES_IN_FLIGHT,
  answerDocImage,
  docImageStatus,
  isNetworkPath,
  registerDocImageProtocol,
} from './doc-image';
import { ReadScope } from './read-scope';

const LOG_DIR = tempDir('sb-docimg-log-');
const log = createLogger(new LogSink({ dir: LOG_DIR }), 'fs');

/** The smallest honest PNG: a 1x1 transparent pixel. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function fixture(): { root: string; outside: string; scope: ReadScope } {
  const root = tempDir('sb-docimg-root-');
  const outside = tempDir('sb-docimg-out-');
  fs.mkdirSync(path.join(root, 'img'));
  fs.writeFileSync(path.join(root, 'img', 'shot.png'), PNG);
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not a picture');
  fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
  const scope = new ReadScope({ sessionFolders: () => [root], log });
  return { root, outside, scope };
}

describe('answerDocImage', () => {
  it('serves a picture inside the scope, with the type its name says', async () => {
    const { root, scope } = fixture();
    const answer = await answerDocImage(docImageUrl(path.join(root, 'img', 'shot.png')), {
      scope,
      log,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.mime).toBe('image/png');
    expect(answer.body.equals(PNG)).toBe(true);
  });

  it('refuses a picture OUTSIDE the scope — the reason this handler exists', async () => {
    const { outside, scope } = fixture();
    const answer = await answerDocImage(docImageUrl(path.join(outside, 'secret.png')), {
      scope,
      log,
    });
    expect(answer).toEqual({ ok: false, reason: 'out-of-scope' });
  });

  it('refuses a climb out with `..`, because the decision is on the real path', async () => {
    const { root, outside, scope } = fixture();
    const climb = path.join(root, 'img', '..', '..', path.basename(outside), 'secret.png');
    expect(await answerDocImage(docImageUrl(climb), { scope, log })).toEqual({
      ok: false,
      reason: 'out-of-scope',
    });
  });

  it('refuses an in-scope file that is not a picture by name, without opening it', async () => {
    const { root, scope } = fixture();
    expect(await answerDocImage(docImageUrl(path.join(root, 'notes.txt')), { scope, log })).toEqual(
      { ok: false, reason: 'not-an-image' }
    );
  });

  it('checks the name of what the path RESOLVES to, not the name it was asked by', async () => {
    // `shot.png` → `notes.txt`: a picture's name on a text file's bytes. Stood
    // in for by the scope, because making a real symlink needs a privilege a
    // Windows runner does not have.
    const { root, scope } = fixture();
    const lying = {
      roots: () => scope.roots(),
      resolve: () => scope.resolve(path.join(root, 'notes.txt')),
    };
    expect(
      await answerDocImage(docImageUrl(path.join(root, 'shot.png')), { scope: lying, log })
    ).toEqual({ ok: false, reason: 'not-an-image' });
  });

  it('says not-found for a picture that is not there, inside the scope', async () => {
    const { root, scope } = fixture();
    expect(await answerDocImage(docImageUrl(path.join(root, 'gone.png')), { scope, log })).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('refuses a directory with a picture name', async () => {
    const { root, scope } = fixture();
    fs.mkdirSync(path.join(root, 'folder.png'));
    const answer = await answerDocImage(docImageUrl(path.join(root, 'folder.png')), { scope, log });
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(['not-a-file', 'unreadable']).toContain(answer.reason);
  });

  it('refuses a picture over the cap before reading it', async () => {
    const { root, scope } = fixture();
    const file = path.join(root, 'img', 'shot.png');
    expect(await answerDocImage(docImageUrl(file), { scope, log, cap: PNG.length - 1 })).toEqual({
      ok: false,
      reason: 'too-large',
    });
    // …and exactly at the cap is fine
    expect((await answerDocImage(docImageUrl(file), { scope, log, cap: PNG.length })).ok).toBe(true);
  });

  it('refuses a URL that is not ours, or carries no path', async () => {
    const { scope } = fixture();
    for (const url of [undefined, 'nonsense', `${DOC_IMAGE_SCHEME}://local/`, 'https://x/?path=/a.png']) {
      expect(await answerDocImage(url, { scope, log })).toEqual({ ok: false, reason: 'invalid-path' });
    }
  });

  it('refuses a NETWORK path as a string — the filesystem is never asked', async () => {
    // Finding the real path of `\\host\share\x.png` means contacting the host:
    // on Windows an SMB connection and a login handshake to a machine the
    // document picked. So `resolve` must not be reached at all.
    const { scope } = fixture();
    let resolved = 0;
    const watched = {
      roots: () => scope.roots(),
      resolve: (target: unknown) => {
        resolved += 1;
        return scope.resolve(target);
      },
    };
    for (const target of [
      '\\\\evil.test\\share\\x.png',
      '//evil.test/share/x.png',
      '\\\\?\\UNC\\evil.test\\share\\x.png',
      '\\/evil.test/share/x.png',
    ]) {
      expect(isNetworkPath(target)).toBe(true);
      expect(await answerDocImage(docImageUrl(target), { scope: watched, log })).toEqual({
        ok: false,
        reason: 'out-of-scope',
      });
    }
    expect(resolved).toBe(0);
  });

  it('…but a session opened ON a share still shows its pictures', async () => {
    // The spelling sits under a granted root, so it goes on to the real check.
    const share = '//nas/projects/sb';
    const target = `${share}/img/shot.png`;
    let asked: unknown;
    const onShare = {
      roots: () => [path.resolve(share)],
      resolve: (t: unknown) => {
        asked = t;
        return { ok: false as const, reason: 'not-found' as const };
      },
    };
    expect(await answerDocImage(docImageUrl(target), { scope: onShare, log })).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(asked).toBe(target);
  });

  it('an ordinary path is not a network path', () => {
    for (const p of ['/home/dan/a.png', 'C:\\a\\b.png', 'a.png', '/', '']) {
      expect(isNetworkPath(p)).toBe(false);
    }
  });

  it('refuses a relative path — there is no root to resolve it against', async () => {
    const { scope } = fixture();
    expect(await answerDocImage(docImageUrl('img/shot.png'), { scope, log })).toEqual({
      ok: false,
      reason: 'invalid-path',
    });
  });
});

describe('registerDocImageProtocol', () => {
  function registered(deps: Parameters<typeof registerDocImageProtocol>[1]): {
    scheme: string;
    ask: (url: string) => Promise<Response>;
  } {
    let scheme = '';
    let handler: ((request: { url: string }) => Promise<Response>) | undefined;
    registerDocImageProtocol(
      {
        handle: (s, h) => {
          scheme = s;
          handler = h;
        },
      },
      deps
    );
    return { scheme, ask: (url) => handler!({ url }) };
  }

  it('answers the bytes with the type, nosniff, and no caching', async () => {
    const { root, scope } = fixture();
    const { scheme, ask } = registered({ scope, log });
    expect(scheme).toBe(DOC_IMAGE_SCHEME);
    const res = await ask(docImageUrl(path.join(root, 'img', 'shot.png')));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('a refusal is a status and an EMPTY body', async () => {
    const { outside, scope } = fixture();
    const { ask } = registered({ scope, log });
    const res = await ask(docImageUrl(path.join(outside, 'secret.png')));
    expect(res.status).toBe(403);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it('never rejects, even when the scope itself throws', async () => {
    const { ask } = registered({
      scope: {
        roots: () => [],
        resolve: () => {
          throw new Error('boom');
        },
      },
      log,
    });
    expect((await ask(docImageUrl('/a/b.png'))).status).toBe(404);
  });

  it('reads a few at a time, and everyone still gets an answer', async () => {
    const { root, scope } = fixture();
    let started = 0;
    const counted = {
      roots: () => scope.roots(),
      resolve: (target: unknown) => {
        started += 1;
        return scope.resolve(target);
      },
    };
    const { ask } = registered({ scope: counted, log });
    const url = docImageUrl(path.join(root, 'img', 'shot.png'));
    const all = Array.from({ length: 20 }, () => ask(url));
    // Microtasks only: every request that was given a turn has reached the
    // scope by now, and no read can have finished — that needs the event loop.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(started).toBe(MAX_DOC_IMAGES_IN_FLIGHT);
    const answers = await Promise.all(all);
    expect(answers.map((r) => r.status)).toEqual(Array.from({ length: 20 }, () => 200));
    expect(started).toBe(20);
  });

  it('maps each refusal to a status', () => {
    expect(docImageStatus('invalid-path')).toBe(400);
    expect(docImageStatus('out-of-scope')).toBe(403);
    expect(docImageStatus('too-large')).toBe(413);
    expect(docImageStatus('not-an-image')).toBe(415);
    expect(docImageStatus('not-found')).toBe(404);
    expect(docImageStatus('unreadable')).toBe(404);
  });
});
