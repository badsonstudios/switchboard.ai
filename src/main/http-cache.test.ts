// The browser cache is kept empty (#744): `http-cache.ts` clears it at start,
// and `static-server.ts` stops anything new being written.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { clearDeadHttpCache, type CacheSession } from './http-cache';
import { startStaticServer, type StaticServer } from './static-server';

function recordingLog() {
  const lines: Array<{ level: string; msg: string; fields?: unknown }> = [];
  const at = (level: string) => (msg: string, fields?: unknown) => void lines.push({ level, msg, fields });
  return { log: { info: at('info'), warn: at('warn'), debug: at('debug') }, lines };
}

describe('clearing the browser cache at start (#744)', () => {
  it('clears the http cache AND the code cache, and says how much it took back', async () => {
    const order: string[] = [];
    const session: CacheSession = {
      getCacheSize: () => Promise.resolve(208 * 1024 * 1024),
      clearCache: () => {
        order.push('http');
        return Promise.resolve();
      },
      clearCodeCaches: () => {
        order.push('code');
        return Promise.resolve();
      },
    };
    const { log, lines } = recordingLog();
    expect(await clearDeadHttpCache(session, log)).toBe(208 * 1024 * 1024);
    expect(order).toEqual(['http', 'code']);
    expect(lines).toEqual([
      {
        level: 'info',
        msg: 'cleared the browser cache: nothing in it could be reused',
        fields: { bytes: 208 * 1024 * 1024, megabytes: 208 },
      },
    ]);
  });

  it('an already-empty cache is cleared quietly: this runs on every start', async () => {
    const clearCache = vi.fn(() => Promise.resolve());
    const { log, lines } = recordingLog();
    expect(await clearDeadHttpCache({ getCacheSize: () => Promise.resolve(4096), clearCache }, log)).toBe(4096);
    expect(clearCache).toHaveBeenCalledOnce();
    expect(lines.map((l) => l.level)).toEqual(['debug']);
  });

  it('⚠️ never rejects: a cache that will not clear costs disk, not a session', async () => {
    const { log, lines } = recordingLog();
    const broken: CacheSession = {
      getCacheSize: () => Promise.reject(new Error('profile locked')),
      clearCache: () => Promise.resolve(),
    };
    await expect(clearDeadHttpCache(broken, log)).resolves.toBeNull();
    const wontClear: CacheSession = {
      getCacheSize: () => Promise.resolve(10),
      clearCache: () => Promise.reject(new Error('disk gone')),
    };
    await expect(clearDeadHttpCache(wontClear, log)).resolves.toBeNull();
    expect(lines.map((l) => l.level)).toEqual(['warn', 'warn']);
    expect(JSON.stringify(lines[0].fields)).toContain('profile locked');
  });

  it('an Electron without the code-cache call still clears the http cache', async () => {
    const clearCache = vi.fn(() => Promise.resolve());
    const { log } = recordingLog();
    expect(await clearDeadHttpCache({ getCacheSize: () => Promise.resolve(0), clearCache }, log)).toBe(0);
    expect(clearCache).toHaveBeenCalledOnce();
  });
});

describe('the renderer is served so that nothing is cached (#744)', () => {
  let server: StaticServer | null = null;
  let dir = '';
  afterEach(() => {
    server?.close();
    server = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = (url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
    new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        })
        .on('error', reject);
    });

  it('⚠️ every file it serves says no-store: the address changes each launch, so a copy is never reused', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-static-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>');
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
    server = await startStaticServer(dir);
    for (const p of ['/', '/assets/index-abc123.js']) {
      const res = await get(server.origin + p);
      expect(res.status, p).toBe(200);
      expect(res.headers['cache-control'], p).toBe('no-store');
      // the policy header it has always carried is still there
      expect(res.headers['content-security-policy'], p).toBeTruthy();
    }
    // and it still picks its own port, which is the reason
    expect(server.origin).toMatch(/^http:[/][/]127[.]0[.]0[.]1:[1-9][0-9]*$/);
  });
});
