// `git worktree list --porcelain`, read (E42 step 1, #1637).
//
// One record per worktree, separated by a blank line. Each record starts with
// `worktree <path>` and then carries some of: `HEAD <sha>`, `branch <ref>`,
// `detached`, `bare`, `locked [reason]`, `prunable [reason]`. Git prints the
// path with forward slashes on Windows too (`C:/Projects/x`). The FIRST record
// is always the primary checkout (or the bare repo), which is how the project
// card knows which worktree to mark PRIMARY.
//
// Pure, so the whole format is pinned by `worktree-list.test.ts` without a git.

import { WorktreeInfo } from '../../shared/projects';

export function parseWorktreeList(text: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '') {
      cur = null;
      continue;
    }
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      cur = { path: val, primary: out.length === 0, branch: null, head: null, detached: false };
      out.push(cur);
      continue;
    }
    // a line before any `worktree` line is not ours to guess at
    if (!cur) continue;
    switch (key) {
      case 'HEAD':
        cur.head = val || null;
        break;
      case 'branch':
        cur.branch = val.replace(/^refs\/heads\//, '') || null;
        break;
      case 'detached':
        cur.detached = true;
        break;
      case 'bare':
        cur.bare = true;
        break;
      case 'locked':
        cur.locked = true;
        break;
      case 'prunable':
        cur.prunable = true;
        break;
      default:
        // a key a newer git added: ignored, never fatal
        break;
    }
  }
  return out;
}
