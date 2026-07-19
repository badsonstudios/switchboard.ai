// GitService (P1-E5-01): status + diff via the system git binary, parsed
// models, graceful everywhere — a session folder that isn't a repo (or a
// machine without git) yields { isRepo: false }, never an error dialog.
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface GitFileStatus {
  path: string;
  /** porcelain XY, e.g. "M.", ".M", "??" (untracked) */
  xy: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
}

export interface FileVersions {
  /** content at HEAD (empty for new files) */
  original: string;
  /** working-tree content (empty for deletions) */
  modified: string;
}

function git(folder: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: folder, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve({ ok: !err, out: stdout ?? '' })
    );
  });
}

export class GitService {
  async status(folder: string): Promise<GitStatus> {
    const probe = await git(folder, ['rev-parse', '--is-inside-work-tree']);
    if (!probe.ok || !probe.out.trim().startsWith('true')) return { isRepo: false, files: [] };

    const r = await git(folder, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
    if (!r.ok) return { isRepo: false, files: [] };

    const status: GitStatus = { isRepo: true, files: [] };
    for (const line of r.out.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        status.branch = line.slice('# branch.head '.length).trim();
      } else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // ordinary/rename entries: "1 XY sub mH mI mW hH hI path"
        const parts = line.split(' ');
        const xy = parts[1];
        const p = line.startsWith('2 ')
          ? line.split('\t')[0].split(' ').slice(9).join(' ')
          : parts.slice(8).join(' ');
        status.files.push({
          path: p,
          xy,
          staged: xy[0] !== '.',
          unstaged: xy[1] !== '.',
          untracked: false,
        });
      } else if (line.startsWith('? ')) {
        status.files.push({ path: line.slice(2), xy: '??', staged: false, unstaged: true, untracked: true });
      }
    }
    return status;
  }

  /** HEAD vs working-tree contents for a Monaco diff (E5-02). */
  async fileVersions(folder: string, file: string): Promise<FileVersions> {
    const head = await git(folder, ['show', `HEAD:${toGitPath(file)}`]);
    let modified = '';
    try {
      modified = fs.readFileSync(path.join(folder, file), 'utf8');
    } catch {
      modified = ''; // deleted in working tree
    }
    return { original: head.ok ? head.out : '', modified };
  }
}

function toGitPath(p: string): string {
  return p.replace(/\\/g, '/');
}
