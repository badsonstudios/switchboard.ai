// Unlink before delete (#916, #1506): deleting a worktree folder that holds a
// linked `node_modules` must remove the LINK and leave the real folder it
// points at untouched. This is the guarantee, tested on the real file system
// (a junction on Windows, a directory symlink elsewhere).
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { findLinks, isLink, linkDir, removeWorktreeFolder, unlinkShared } from './worktree-links';
import { tempDir } from '../../test-temp-dirs';

/** a "primary checkout" with a real node_modules, and an empty worktree folder */
function setup(): { primary: string; real: string; worktree: string } {
  const primary = tempDir('sb-links-primary-');
  const real = path.join(primary, 'node_modules');
  fs.mkdirSync(path.join(real, 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(real, 'left-pad', 'index.js'), 'module.exports = 1;\n');
  const worktree = tempDir('sb-links-wt-');
  fs.writeFileSync(path.join(worktree, 'README.md'), '# wt\n');
  return { primary, real, worktree };
}

describe('linkDir', () => {
  it('makes a link the worktree reads through', async () => {
    const { real, worktree } = setup();
    const link = path.join(worktree, 'node_modules');
    await linkDir(real, link);
    expect(await isLink(link)).toBe(true);
    expect(fs.readFileSync(path.join(link, 'left-pad', 'index.js'), 'utf8')).toContain('module.exports');
    await unlinkShared(worktree, ['node_modules']);
  });
});

describe('removeWorktreeFolder', () => {
  it('unlinks a shared folder BEFORE deleting, so the real folder survives', async () => {
    const { real, worktree } = setup();
    await linkDir(real, path.join(worktree, 'node_modules'));
    const order: string[] = [];
    const why = await removeWorktreeFolder(worktree, ['node_modules'], async (dir) => {
      // the deleter must never see a link: it would walk into the real folder
      order.push((await findLinks(dir)).length === 0 ? 'delete-after-unlink' : 'delete-with-link');
      await fs.promises.rm(dir, { recursive: true, force: true });
    });
    expect(why).toBeNull();
    expect(order).toEqual(['delete-after-unlink']);
    expect(fs.existsSync(worktree)).toBe(false);
    // the point of the whole thing
    expect(fs.readFileSync(path.join(real, 'left-pad', 'index.js'), 'utf8')).toContain('module.exports');
  });

  it('also unlinks a link the settings no longer name (the safety net)', async () => {
    const { real, worktree } = setup();
    await linkDir(real, path.join(worktree, 'packages', 'app', 'node_modules'));
    expect(await findLinks(worktree)).toEqual(['packages/app/node_modules']);
    const why = await removeWorktreeFolder(worktree, [], async (dir) => {
      await fs.promises.rm(dir, { recursive: true, force: true });
    });
    expect(why).toBeNull();
    expect(fs.existsSync(path.join(real, 'left-pad', 'index.js'))).toBe(true);
  });

  it('leaves a real folder at a shared path alone (it is the worktree’s own)', async () => {
    const { worktree } = setup();
    fs.mkdirSync(path.join(worktree, 'node_modules', 'x'), { recursive: true });
    expect(await unlinkShared(worktree, ['node_modules'])).toEqual([]);
    expect(fs.existsSync(path.join(worktree, 'node_modules', 'x'))).toBe(true);
  });

  it('deletes nothing when a link cannot be taken out', async () => {
    const { real, worktree } = setup();
    await linkDir(real, path.join(worktree, 'node_modules'));
    const unlink = vi.spyOn(fs.promises, 'unlink').mockRejectedValue(new Error('EPERM'));
    const rmdir = vi.spyOn(fs.promises, 'rmdir').mockRejectedValue(new Error('EPERM'));
    let deleted = false;
    try {
      const why = await removeWorktreeFolder(worktree, ['node_modules'], async () => {
        deleted = true;
      });
      expect(why).toMatch(/node_modules/);
      expect(deleted).toBe(false);
    } finally {
      unlink.mockRestore();
      rmdir.mockRestore();
    }
    expect(fs.existsSync(path.join(real, 'left-pad', 'index.js'))).toBe(true);
    await unlinkShared(worktree, ['node_modules']);
  });
});
