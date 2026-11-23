// Port and dev-database clashes between live sessions (#1507).
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  claimsFromEnv,
  listeningPorts,
  localDatabase,
  parseDotenv,
  portsFromCommand,
  portsInUse,
  readEnvFiles,
  ResourceClashes,
  MAX_ENV_BYTES,
  RUN_CLAIM_MS,
} from './resource-clash';
import type { ClashMark, FeedBlock } from '../feed/blocks';

describe('portsFromCommand', () => {
  it('reads PORT= and --port', () => {
    expect(portsFromCommand('PORT=3000 npm run dev')).toEqual([3000]);
    expect(portsFromCommand('npx vite --port 5173')).toEqual([5173]);
    expect(portsFromCommand('next dev --port=4000')).toEqual([4000]);
    expect(portsFromCommand('cd web && PORT="8080" node server.js')).toEqual([8080]);
    expect(portsFromCommand('$env:PORT=3001; npm start')).toEqual([3001]);
  });

  it('ignores -p, URLs, other variables and impossible ports', () => {
    expect(portsFromCommand('mkdir -p 3000')).toEqual([]);
    expect(portsFromCommand('curl http://localhost:3000/health')).toEqual([]);
    expect(portsFromCommand('DB_PORT=5432 npm test')).toEqual([]);
    expect(portsFromCommand('PORT=0 node x.js')).toEqual([]);
    expect(portsFromCommand('PORT=99999 node x.js')).toEqual([]);
  });
});

describe('listeningPorts', () => {
  it('reads the common dev servers', () => {
    expect(listeningPorts('Server listening on port 3000')).toEqual([3000]);
    expect(listeningPorts('listening on http://localhost:4000')).toEqual([4000]);
    expect(listeningPorts('  ➜  Local:   http://localhost:5173/')).toEqual([5173]);
    expect(listeningPorts('ready - started server on 0.0.0.0:3000, url: http://localhost:3000')).toEqual([3000]);
    expect(listeningPorts('Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)')).toEqual([8000]);
  });

  it('does not read a request to a port as a server on it', () => {
    expect(listeningPorts('GET http://localhost:3000/api 200')).toEqual([]);
    expect(listeningPorts('connected to postgres at db.example.com:5432')).toEqual([]);
  });
});

describe('portsInUse', () => {
  it('reads EADDRINUSE and friends', () => {
    expect(portsInUse('Error: listen EADDRINUSE: address already in use :::3000')).toEqual([3000]);
    expect(portsInUse('OSError: [Errno 98] address already in use 127.0.0.1:8000')).toEqual([8000]);
    expect(portsInUse('Port 5173 is in use, trying another one...')).toEqual([5173]);
    expect(portsInUse('port 3000 is already in use')).toEqual([3000]);
  });

  it('says nothing about ordinary output', () => {
    expect(portsInUse('listening on port 3000')).toEqual([]);
  });
});

describe('dotenv', () => {
  it('parses keys, quotes, export and comments', () => {
    const m = parseDotenv('# c\nexport PORT=3000\nNAME="a b"\nX=\'y\'\nZ=1 # note\r\nbad line\n');
    expect(m.get('PORT')).toBe('3000');
    expect(m.get('NAME')).toBe('a b');
    expect(m.get('X')).toBe('y');
    expect(m.get('Z')).toBe('1');
    expect(m.has('bad')).toBe(false);
  });

  it('claims serve ports and local databases, later files winning', () => {
    const claims = claimsFromEnv([
      { file: '.env', text: 'PORT=3000\nDB_PORT=5432\nDATABASE_URL=postgres://u:secret@localhost:5432/app_dev\n' },
      { file: '.env.local', text: 'PORT=3100\nVITE_PORT=5173\n' },
    ]);
    const by = Object.fromEntries(claims.map((c) => [c.setting, c]));
    expect(by.PORT).toMatchObject({ key: 'port:3100', file: '.env.local' });
    expect(by.VITE_PORT).toMatchObject({ key: 'port:5173' });
    expect(by.DB_PORT).toBeUndefined();
    expect(by.DATABASE_URL).toMatchObject({ resource: 'database', value: 'app_dev on localhost:5432' });
    expect(JSON.stringify(claims)).not.toContain('secret');
  });
});

describe('localDatabase', () => {
  it('one key for the spellings of one local database', () => {
    const a = localDatabase('postgresql://u:p@localhost/app');
    const b = localDatabase('postgres://127.0.0.1:5432/app?sslmode=disable');
    expect(a?.key).toBe(b?.key);
    expect(localDatabase('mysql://root@localhost:3306/shop')?.label).toBe('shop on localhost:3306');
    expect(localDatabase('mongodb://localhost:27017/x')?.key).toContain('mongodb://');
  });

  it('remote hosts, no database name, variables and relative sqlite are not compared', () => {
    expect(localDatabase('postgres://db.example.com/app')).toBeNull();
    expect(localDatabase('postgres://localhost:5432')).toBeNull();
    expect(localDatabase('postgres://localhost/${DB}')).toBeNull();
    expect(localDatabase('file:./dev.db')).toBeNull();
    expect(localDatabase('not a url')).toBeNull();
  });

  it('an absolute sqlite file is one database wherever it is named from', () => {
    expect(localDatabase('file:/srv/data/dev.db')?.key).toBe(localDatabase('sqlite:////srv/data/dev.db')?.key);
    expect(localDatabase('file:C:/data/dev.db')).not.toBeNull();
  });
});

describe('readEnvFiles', () => {
  it('reads the known files, skips missing and oversized ones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clash-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n');
      fs.writeFileSync(path.join(dir, '.env.local'), 'X'.repeat(MAX_ENV_BYTES + 1));
      fs.writeFileSync(path.join(dir, '.env.production'), 'PORT=1\n');
      expect(await readEnvFiles(dir)).toEqual([{ file: '.env', text: 'PORT=3000\n' }]);
      expect(await readEnvFiles(path.join(dir, 'missing'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── the tracker ─────────────────────────────────────────────────────────────

const shell = (command: string, out?: string): FeedBlock =>
  ({
    seq: 1,
    kind: 'tool',
    tool: { name: 'Bash', category: 'shell', summary: command, detail: JSON.stringify({ command }), ...(out ? { out } : {}) },
  }) as FeedBlock;

function harness(env: Record<string, string> = {}, names: Record<string, { name: string; folder: string }> = {}) {
  const placed: Array<{ sessionId: string; mark: ClashMark }> = [];
  const t = new ResourceClashes({
    describe: (id) => names[id] ?? { name: `session ${id}`, folder: `/work/${id}` },
    place: (sessionId, mark) => placed.push({ sessionId, mark }),
    readEnv: async (folder) => (env[folder] !== undefined ? [{ file: '.env', text: env[folder] }] : []),
  });
  return { t, placed };
}

describe('ResourceClashes', () => {
  it('two sessions starting a server on one port: one line, on the second', () => {
    const { t, placed } = harness();
    t.noteBlock('a', shell('PORT=3000 npm run dev'));
    expect(placed).toEqual([]);
    t.noteBlock('b', shell('npm run dev', 'listening on port 3000'));
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({
      sessionId: 'b',
      mark: { resource: 'port', cause: 'started', value: '3000', other: 'session a', otherFolder: '/work/a' },
    });
    // the same block re-emitted with its result, and again later: still one
    t.noteBlock('b', shell('PORT=3000 npm run dev', 'listening on port 3000'));
    t.noteBlock('a', shell('PORT=3000 npm run dev'));
    expect(placed).toHaveLength(1);
  });

  it('never warns a session about itself', () => {
    const { t, placed } = harness();
    t.noteBlock('a', shell('PORT=3000 npm run dev', 'listening on port 3000'));
    t.noteBlock('a', shell('PORT=3000 npm run dev', 'Error: listen EADDRINUSE: address already in use :::3000'));
    expect(placed).toEqual([]);
  });

  it('a port in use is reported only when another session claims it', () => {
    const { t, placed } = harness();
    t.noteBlock('b', shell('npm run dev', 'Error: listen EADDRINUSE: address already in use :::3000'));
    expect(placed).toEqual([]); // something outside the app: not ours
    t.noteBlock('a', shell('PORT=4000 npm run dev'));
    t.noteBlock('b', shell('npm run dev', 'Error: listen EADDRINUSE: address already in use :::4000'));
    expect(placed).toHaveLength(1);
    expect(placed[0].mark).toMatchObject({ cause: 'in-use', value: '4000' });
  });

  it('only reads shell tools', () => {
    const { t, placed } = harness();
    t.noteBlock('a', shell('PORT=3000 npm run dev'));
    t.noteBlock('b', {
      seq: 2,
      kind: 'tool',
      tool: { name: 'Read', category: 'read', summary: 'log.txt', out: 'listening on port 3000' },
    } as FeedBlock);
    expect(placed).toEqual([]);
  });

  it('the same .env in two worktrees: port and database, once each', async () => {
    const text = 'PORT=3000\nDATABASE_URL=postgres://localhost:5432/app_dev\n';
    const { t, placed } = harness({ '/repo': text, '/wt/feature': text });
    await t.noteFolder('a', '/repo');
    expect(placed).toEqual([]);
    await t.noteFolder('b', '/wt/feature');
    expect(placed.map((p) => [p.sessionId, p.mark.resource, p.mark.cause, p.mark.setting])).toEqual([
      ['b', 'port', 'config', 'PORT'],
      ['b', 'database', 'config', 'DATABASE_URL'],
    ]);
    await t.noteFolder('b', '/wt/feature');
    expect(placed).toHaveLength(2);
  });

  it('two sessions in one folder share its settings by choice: nothing', async () => {
    const { t, placed } = harness({ '/repo': 'PORT=3000\n' });
    await t.noteFolder('a', '/repo');
    await t.noteFolder('b', '/repo/');
    expect(placed).toEqual([]);
  });

  it('different settings: nothing', async () => {
    const { t, placed } = harness({ '/repo': 'PORT=3000\n', '/wt': 'PORT=3001\n' });
    await t.noteFolder('a', '/repo');
    await t.noteFolder('b', '/wt');
    expect(placed).toEqual([]);
  });

  it('a port in use that another folder is set to: names the setting', async () => {
    const { t, placed } = harness({ '/repo': 'PORT=3000\n', '/wt': '' });
    await t.noteFolder('a', '/repo');
    await t.noteFolder('b', '/wt');
    t.noteBlock('b', shell('npm run dev', 'EADDRINUSE: address already in use :::3000'));
    expect(placed).toHaveLength(1);
    expect(placed[0].mark).toMatchObject({ cause: 'in-use', setting: 'PORT', file: '.env' });
  });

  it('a command that only looks at text claims nothing (review)', () => {
    const { t, placed } = harness();
    t.noteBlock('a', shell('PORT=3000 npm run dev'));
    t.noteBlock('b', shell('cat server.ts', "app.listen(3000); console.log('listening on port 3000')"));
    t.noteBlock('b', shell('echo PORT=3000 >> .env'));
    t.noteBlock('b', shell('grep -n "address already in use" log.txt', 'EADDRINUSE: address already in use :::3000'));
    expect(placed).toEqual([]);
    // ...while redirecting a real server's output still counts
    t.noteBlock('b', shell('PORT=3000 npm run dev > dev.log 2>&1 &'));
    expect(placed).toHaveLength(1);
  });

  it('a background command read with BashOutput counts', () => {
    const { t, placed } = harness();
    t.noteBlock('a', shell('PORT=3000 npm run dev'));
    t.noteBlock('b', {
      seq: 9,
      kind: 'tool',
      tool: { name: 'BashOutput', category: 'other', summary: 'bash_1', out: 'Server listening on port 3000' },
    } as FeedBlock);
    expect(placed).toHaveLength(1);
  });

  it('a server started long ago is no longer believed', () => {
    let now = 0;
    const placed: ClashMark[] = [];
    const t = new ResourceClashes({
      describe: (id) => ({ name: id, folder: `/${id}` }),
      place: (_s, m) => placed.push(m),
      now: () => now,
    });
    t.noteBlock('a', shell('PORT=3000 npm test'));
    now = RUN_CLAIM_MS + 1;
    t.noteBlock('b', shell('PORT=3000 npm run dev'));
    t.noteBlock('c', shell('npm run dev', 'EADDRINUSE: address already in use :::4000'));
    expect(placed.map((m) => m.other)).toEqual([]);
    // b's own claim is fresh, so a third session clashes with b
    t.noteBlock('d', shell('PORT=3000 npm run dev'));
    expect(placed.map((m) => m.other)).toEqual(['b']);
  });

  it('the call that got the error does not count as being in its own way (review)', async () => {
    const { t, placed } = harness({ '/repo': 'PORT=3000\n', '/wt': '' });
    await t.noteFolder('a', '/repo');
    await t.noteFolder('b', '/wt');
    const call = shell('PORT=3000 npm run dev');
    t.noteBlock('b', call);
    t.noteBlock('b', { ...call, tool: { ...call.tool!, out: 'Error: listen EADDRINUSE: address already in use :::3000' } });
    expect(placed).toHaveLength(1);
    expect(placed[0].mark).toMatchObject({ cause: 'in-use', setting: 'PORT' });
  });

  it('with repositories known, settings are compared within one repository only', async () => {
    const text = 'PORT=3000\n';
    const placed: ClashMark[] = [];
    const repos: Record<string, string | undefined> = { '/repo': 'r1', '/wt': 'r1', '/other': 'r2', '/plain': undefined };
    const t = new ResourceClashes({
      describe: (id) => ({ name: id, folder: `/${id}` }),
      place: (_s, m) => placed.push(m),
      readEnv: async () => [{ file: '.env', text }],
      repoKey: async (f) => repos[f],
    });
    await t.noteFolder('a', '/repo');
    await t.noteFolder('b', '/other');
    await t.noteFolder('c', '/plain');
    expect(placed).toEqual([]);
    await t.noteFolder('d', '/wt');
    expect(placed.map((m) => m.other)).toEqual(['a']);
  });

  it('forget frees the session and lets a later clash be said again', () => {
    const { t, placed } = harness();
    t.noteBlock('a', shell('PORT=3000 x'));
    t.noteBlock('b', shell('PORT=3000 x'));
    expect(placed).toHaveLength(1);
    t.forget('a');
    t.noteBlock('c', shell('PORT=3000 x'));
    expect(placed).toHaveLength(2);
    expect(placed[1]).toMatchObject({ sessionId: 'c', mark: { other: 'session b' } });
  });

  it('a session already gone draws nothing', () => {
    const placed: ClashMark[] = [];
    const t = new ResourceClashes({ describe: () => null, place: (_s, m) => placed.push(m) });
    t.noteBlock('a', shell('PORT=3000 x'));
    t.noteBlock('b', shell('PORT=3000 x'));
    expect(placed).toEqual([]);
  });

  it('fails open: a throwing reader or drawer changes nothing visible', async () => {
    const warn = vi.fn();
    const t = new ResourceClashes({
      describe: (id) => ({ name: id, folder: `/${id}` }),
      place: () => {
        throw new Error('panel gone');
      },
      readEnv: async () => {
        throw new Error('EACCES');
      },
      log: { info: vi.fn(), warn },
    });
    await expect(t.noteFolder('a', '/a')).resolves.toBeUndefined();
    t.noteBlock('a', shell('PORT=3000 x'));
    expect(() => t.noteBlock('b', shell('PORT=3000 x'))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('a slow read for a folder the session already left lands nowhere', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const placed: ClashMark[] = [];
    const t = new ResourceClashes({
      describe: (id) => ({ name: id, folder: `/${id}` }),
      place: (_s, m) => placed.push(m),
      readEnv: async (folder) => {
        if (folder === '/old') await gate;
        return [{ file: '.env', text: folder === '/x' ? 'PORT=4000\n' : 'PORT=3000\n' }];
      },
    });
    await t.noteFolder('a', '/x');
    const slow = t.noteFolder('b', '/old');
    t.forget('b');
    release();
    await slow;
    await t.noteFolder('c', '/old2');
    expect(placed).toEqual([]);
  });
});
