// Staging one hunk, from the renderer (E24 Git v2 item 14).
//
// `main/git/git-hunks.test.ts` owns the patch algebra and the counter-example for
// why line-level selection is not in this item. This file owns the renderer's two
// jobs: compose the patch bytes for ONE hunk, and never read a refusal as a
// success.
import { describe, it, expect, afterEach } from 'vitest';
import { ipcRefusal } from '../../../shared/ipc/refusal';
import {
  type HunksDto,
  applyOneHunk,
  canStageHunks,
  hunkLabel,
  onePatch,
  readHunks,
} from './git-hunks';

/** A single newline, named rather than escaped. */
const LF = String.fromCharCode(10);

const dto: HunksDto = {
  header: ['diff --git a/f.txt b/f.txt', '--- a/f.txt', '+++ b/f.txt'],
  hunks: [
    {
      header: '@@ -1,4 +1,4 @@',
      lines: ['-one', '+ONE', ' two', ' three', ' four'],
      oldStart: 1,
      oldCount: 4,
      newStart: 1,
      newCount: 4,
    },
    {
      header: '@@ -7,4 +7,4 @@ six',
      lines: [' seven', ' eight', ' nine', '-ten', '+TEN'],
      oldStart: 7,
      oldCount: 4,
      newStart: 7,
      newCount: 4,
    },
  ],
};

function bridge(impl: {
  hunks?: (folder: string, file: string) => Promise<unknown>;
  applyPatch?: (folder: string, patch: string, opts?: unknown) => Promise<unknown>;
}): { patches: string[]; opts: unknown[] } {
  const patches: string[] = [];
  const opts: unknown[] = [];
  (globalThis as { switchboard?: unknown }).switchboard = {
    git: {
      hunks: impl.hunks,
      applyPatch: impl.applyPatch
        ? (folder: string, patch: string, o?: unknown) => {
            patches.push(patch);
            opts.push(o);
            return impl.applyPatch!(folder, patch, o);
          }
        : undefined,
    },
  };
  return { patches, opts };
}

describe('composing the patch for one hunk', () => {
  it('⚠️ CONTAINS THE HEADER, THAT HUNK, AND NOTHING ELSE (the done-when)', () => {
    const patch = onePatch(dto, dto.hunks[0]);
    expect(patch).toContain('diff --git a/f.txt b/f.txt');
    expect(patch).toContain('@@ -1,4 +1,4 @@');
    expect(patch).toContain('+ONE');
    // ⚠️ THE OTHER HUNK MUST NOT BE IN IT — that is the entire feature.
    expect(patch).not.toContain('+TEN');
    expect(patch).not.toContain('@@ -7,4');
  });

  it('⚠️ ENDS WITH A NEWLINE, which is one byte between working and "corrupt patch"', () => {
    expect(onePatch(dto, dto.hunks[0]).endsWith(LF)).toBe(true);
  });

  it('a patch with no header is still composed, rather than throwing', () => {
    // `header` is optional on the DTO because a refusal carries none. A patch
    // without it will be refused BY GIT, which is the right place for that
    // verdict — this must not be where it crashes.
    expect(() => onePatch({ hunks: dto.hunks }, dto.hunks[0])).not.toThrow();
  });
});

describe('reading and applying', () => {
  afterEach(() => {
    delete (globalThis as { switchboard?: unknown }).switchboard;
  });

  it('reads the hunks and stages the one it is given', async () => {
    const { patches, opts } = bridge({
      hunks: async () => dto,
      applyPatch: async () => ({ ok: true, applied: 1 }),
    });
    expect(await readHunks('/proj', 'f.txt')).toEqual(dto);
    expect(await applyOneHunk('/proj', dto, dto.hunks[1])).toEqual({ ok: true, applied: 1 });
    expect(patches[0]).toContain('+TEN');
    expect(patches[0]).not.toContain('+ONE');
    expect(opts[0]).toEqual({});
  });

  it('reverse-applies to unstage, which is the same patch the other way', async () => {
    const { opts } = bridge({
      hunks: async () => dto,
      applyPatch: async () => ({ ok: true, applied: 1 }),
    });
    await applyOneHunk('/proj', dto, dto.hunks[0], { reverse: true });
    expect(opts[0]).toEqual({ reverse: true });
  });

  it('⚠️ `null` MEANS "WE LEARNED NOTHING", WHICH IS NOT "NO HUNKS"', () => {
    // A file with nothing unstaged really has an empty list; a surface that drew
    // the same thing for both would tell a user their change had vanished.
    expect(dto.hunks.length).toBeGreaterThan(0);
  });

  it('a refusal reads as nothing learned, not as an empty file', async () => {
    bridge({ hunks: async () => ipcRefusal('git:hunks', 'capability-not-held') });
    expect(await readHunks('/proj', 'f.txt')).toBeNull();
  });

  it('a payload that is not a hunk list is nothing learned', async () => {
    for (const junk of [{}, { hunks: 'lots' }, 42, null, 'done']) {
      bridge({ hunks: async () => junk });
      expect(await readHunks('/proj', 'f.txt')).toBeNull();
    }
  });

  it('a rejected read is nothing learned, and never a throw', async () => {
    bridge({
      hunks: async () => {
        throw new Error('gone');
      },
    });
    await expect(readHunks('/proj', 'f.txt')).resolves.toBeNull();
  });

  it('⚠️ A REFUSED APPLY IS NOT A SUCCESS', async () => {
    bridge({
      hunks: async () => dto,
      applyPatch: async () => ipcRefusal('git:applyPatch', 'capability-not-held'),
    });
    const r = await applyOneHunk('/proj', dto, dto.hunks[0]);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(0);
  });

  it('⚠️ AND GIT’S OWN REFUSAL COMES BACK VERBATIM', async () => {
    // "patch does not apply" and "corrupt patch at line N" are both things the
    // user — or we — need to see rather than a sentence of ours.
    bridge({
      hunks: async () => dto,
      applyPatch: async () => ({ ok: false, applied: 0, reason: 'error: patch does not apply' }),
    });
    expect((await applyOneHunk('/proj', dto, dto.hunks[0])).reason).toBe(
      'error: patch does not apply'
    );
  });

  it('⚠️ NO BRIDGE IS A REPORTED FAILURE, and the ⊞ is absent', async () => {
    delete (globalThis as { switchboard?: unknown }).switchboard;
    expect(canStageHunks()).toBe(false);
    expect(await readHunks('/proj', 'f.txt')).toBeNull();
    const r = await applyOneHunk('/proj', dto, dto.hunks[0]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cannot stage part of a file');
  });

  it('⚠️ BOTH HALVES OR NEITHER — a build with one is a button that cannot work', async () => {
    bridge({ hunks: async () => dto });
    expect(canStageHunks()).toBe(false);
    bridge({ hunks: async () => dto, applyPatch: async () => ({ ok: true, applied: 1 }) });
    expect(canStageHunks()).toBe(true);
  });
});

describe('what a hunk is called on screen', () => {
  it('⚠️ NOT THE `@@` LINE, which is precise and means nothing to most people', () => {
    // `@@ -160,12 +160,18 @@` is exact; what a reader wants is WHERE and HOW MUCH.
    const label = hunkLabel(dto.hunks[0]);
    expect(label.key).toBe('scm.hunkLabel');
    expect(label.values).toEqual({ line: 1, added: 1, removed: 1 });
  });

  it('counts both sides of the change, and ignores context', () => {
    const label = hunkLabel({
      header: '@@ -5,3 +5,5 @@',
      lines: [' a', '-b', '-c', '+B', '+C', '+D', ' d'],
      oldStart: 5,
      oldCount: 4,
      newStart: 5,
      newCount: 5,
    });
    expect(label.values).toEqual({ line: 5, added: 3, removed: 2 });
  });

  it('returns a KEY, so the catalog owns the words', () => {
    expect(hunkLabel(dto.hunks[0]).key.startsWith('scm.')).toBe(true);
  });
});
