import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { writeFileDurable, type DurableFs } from './durable-write';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';

afterEach(() => cleanupTempDirs());

/** Real fs, every call recorded with its arguments, in order. */
function recording(): { fsx: DurableFs; calls: { name: string; args: unknown[] }[] } {
  const calls: { name: string; args: unknown[] }[] = [];
  const wrap =
    <K extends keyof DurableFs>(k: K) =>
    (...args: Parameters<DurableFs[K]>): ReturnType<DurableFs[K]> => {
      calls.push({ name: k, args });
      return (fs[k] as (...a: unknown[]) => ReturnType<DurableFs[K]>)(...args);
    };
  const fsx = {
    writeFileSync: wrap('writeFileSync'),
    renameSync: wrap('renameSync'),
    openSync: wrap('openSync'),
    fsyncSync: wrap('fsyncSync'),
    closeSync: wrap('closeSync'),
  };
  return { fsx, calls };
}

describe('writeFileDurable (#1410)', () => {
  it('writes the temp file FLUSHED, then renames it over the target', () => {
    const dir = tempDir('sb-durable-');
    const file = path.join(dir, 'state.json');
    const { fsx, calls } = recording();
    writeFileDurable(file, `${file}.tmp`, '{"ok":true}', { mode: 0o600 }, fsx);

    expect(fs.readFileSync(file, 'utf8')).toBe('{"ok":true}');
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(calls[0]).toEqual({
      name: 'writeFileSync',
      args: [`${file}.tmp`, '{"ok":true}', { mode: 0o600, flush: true }],
    });
    expect(calls[1]).toEqual({ name: 'renameSync', args: [`${file}.tmp`, file] });
  });

  it('a write that fails is a save that did not happen: no rename, and it throws', () => {
    const dir = tempDir('sb-durable-');
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, 'the old contents');
    const { fsx, calls } = recording();
    const broken: DurableFs = {
      ...fsx,
      writeFileSync: () => {
        throw new Error('EIO');
      },
    };
    expect(() => writeFileDurable(file, `${file}.tmp`, 'new', undefined, broken)).toThrow('EIO');
    expect(calls.map((c) => c.name)).not.toContain('renameSync');
    expect(fs.readFileSync(file, 'utf8')).toBe('the old contents');
  });
});
