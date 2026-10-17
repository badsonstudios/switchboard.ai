// `ais.json` (#1291): custom-entry persistence (a done-when), the default AI,
// and fail-open on a corrupt file. Real files in a temp dir.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CustomAi } from '../../shared/ais';
import { AIS_FILE, AisStore } from './ais-store';

let dir: string;
const log = () => ({ info: vi.fn(), warn: vi.fn() });
const qwen: CustomAi = {
  id: 'custom:my-local-qwen',
  name: 'My local Qwen',
  command: 'opencode',
  args: ['acp', '--model', 'ollama/qwen3-coder'],
  addedAt: 1760000000000,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ais-store-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AisStore', () => {
  it('no file: no custom AIs and no chosen default (Claude, by the first-registered rule)', () => {
    const s = new AisStore(dir, log());
    s.load();
    expect(s.customAis()).toEqual([]);
    expect(s.defaultAi()).toBeUndefined();
    expect(fs.existsSync(path.join(dir, AIS_FILE))).toBe(false);
  });

  it('a custom AI and the default survive a restart', () => {
    const a = new AisStore(dir, log());
    a.load();
    expect(a.addCustom({ ...qwen, env: { OLLAMA_HOST: 'http://127.0.0.1:11434' } })).toBe(true);
    expect(a.setDefaultAi('custom:my-local-qwen')).toBe(true);
    const b = new AisStore(dir, log());
    b.load();
    expect(b.customAis()).toEqual([{ ...qwen, env: { OLLAMA_HOST: 'http://127.0.0.1:11434' } }]);
    expect(b.defaultAi()).toBe('custom:my-local-qwen');
  });

  it('remove persists, and clearing the default persists', () => {
    const a = new AisStore(dir, log());
    a.addCustom(qwen);
    a.setDefaultAi('custom:my-local-qwen');
    expect(a.removeCustom('custom:my-local-qwen')).toBe(true);
    expect(a.removeCustom('custom:never-there')).toBe(false);
    a.setDefaultAi(undefined);
    const b = new AisStore(dir, log());
    b.load();
    expect(b.customAis()).toEqual([]);
    expect(b.defaultAi()).toBeUndefined();
  });

  it('saves atomically: no tmp file is left behind', () => {
    const a = new AisStore(dir, log());
    a.addCustom(qwen);
    expect(fs.readdirSync(dir).sort()).toEqual([AIS_FILE]);
  });

  it('hands out copies: a caller cannot edit the store by mutating what it was given', () => {
    const a = new AisStore(dir, log());
    a.addCustom(qwen);
    a.customAis()[0].args.push('--evil');
    expect(a.customAis()[0].args).toEqual(qwen.args);
  });

  it('a corrupt file never prevents startup: logged, set aside as .bad, and the store starts empty', () => {
    fs.writeFileSync(path.join(dir, AIS_FILE), '{"version":1,"custom":[{');
    const l = log();
    const s = new AisStore(dir, l);
    expect(() => s.load()).not.toThrow();
    expect(s.customAis()).toEqual([]);
    expect(fs.existsSync(path.join(dir, `${AIS_FILE}.bad`))).toBe(true);
    expect(fs.existsSync(path.join(dir, AIS_FILE))).toBe(false);
    expect(l.warn).toHaveBeenCalledWith(expect.stringMatching(/set aside/), expect.objectContaining({ setAside: expect.any(String) as unknown }));
    // …and the next save writes a good file beside the post-mortem
    s.addCustom(qwen);
    const again = new AisStore(dir, log());
    again.load();
    expect(again.customAis()).toEqual([qwen]);
  });

  it('a corrupt file that cannot be set aside is never written over this run', () => {
    fs.writeFileSync(path.join(dir, AIS_FILE), '{broken');
    const l = log();
    const stuck = {
      ...fs,
      renameSync: () => {
        throw new Error('EPERM');
      },
    } as unknown as typeof fs;
    const s = new AisStore(dir, l, stuck);
    s.load();
    expect(s.addCustom(qwen)).toBe(false);
    expect(fs.readFileSync(path.join(dir, AIS_FILE), 'utf8')).toBe('{broken');
  });

  it('a file that is JSON but not an object is set aside too', () => {
    fs.writeFileSync(path.join(dir, AIS_FILE), '[1,2,3]');
    const s = new AisStore(dir, log());
    s.load();
    expect(fs.existsSync(path.join(dir, `${AIS_FILE}.bad`))).toBe(true);
  });

  it('an unusable entry is dropped with a log line; the good ones survive', () => {
    fs.writeFileSync(
      path.join(dir, AIS_FILE),
      JSON.stringify({
        version: 1,
        defaultAi: 'claude-code',
        custom: [
          qwen,
          { id: 'not-custom-prefixed', name: 'x', command: 'x', args: [] },
          { id: 'custom:bad', name: 'bad', command: 'x', args: ['a&calc'] },
          { ...qwen }, // a duplicate id
        ],
      })
    );
    const l = log();
    const s = new AisStore(dir, l);
    s.load();
    expect(s.customAis()).toEqual([qwen]);
    expect(s.defaultAi()).toBe('claude-code');
    expect(l.warn).toHaveBeenCalledTimes(3);
  });

  it('a file that exists but cannot be READ is not set aside, and is never written over', () => {
    fs.writeFileSync(path.join(dir, AIS_FILE), JSON.stringify({ version: 1, custom: [qwen] }));
    const l = log();
    const locked = {
      ...fs,
      readFileSync: () => {
        throw new Error('EBUSY');
      },
    } as unknown as typeof fs;
    const s = new AisStore(dir, l, locked);
    s.load();
    expect(s.customAis()).toEqual([]);
    expect(s.addCustom({ ...qwen, id: 'custom:other' })).toBe(false);
    expect(fs.existsSync(path.join(dir, `${AIS_FILE}.bad`))).toBe(false);
    const after = new AisStore(dir, log());
    after.load();
    expect(after.customAis()).toEqual([qwen]);
  });

  it('a save that fails twice is logged and reported, never thrown', () => {
    const l = log();
    const failing = {
      ...fs,
      writeFileSync: () => {
        throw new Error('EPERM');
      },
    } as unknown as typeof fs;
    const s = new AisStore(dir, l, failing);
    expect(s.addCustom(qwen)).toBe(false);
    expect(s.customAis()).toEqual([qwen]); // memory keeps it for this run
    expect(l.warn).toHaveBeenCalledWith('could not save ais.json', { error: 'Error: EPERM' });
  });
});
