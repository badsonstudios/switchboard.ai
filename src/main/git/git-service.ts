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
  /** repo toplevel for a folder, or null when not a repo / no git */
  async root(folder: string): Promise<string | null> {
    const r = await git(folder, ['rev-parse', '--show-toplevel']);
    const top = r.out.trim();
    return r.ok && top ? top : null;
  }

  async status(folder: string): Promise<GitStatus> {
    const probe = await git(folder, ['rev-parse', '--is-inside-work-tree']);
    if (!probe.ok || !probe.out.trim().startsWith('true')) return { isRepo: false, files: [] };

    // quotePath=off: non-ASCII paths arrive literal, so fileVersions can find them
    const r = await git(folder, [
      '-c',
      'core.quotePath=off',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
    ]);
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

  /**
   * The working tree's uncommitted changes as ONE unified diff (P2-E11-01).
   *
   * WHY THIS EXISTS ALONGSIDE `fileVersions`. That one answers Monaco, which
   * wants two whole file contents and renders the difference itself. This one
   * answers a language model, which reads text — and would otherwise be handed
   * two full copies of every changed file and asked to diff them in its head,
   * at several times the tokens.
   *
   * Diffed against `HEAD` with no pathspec, so BOTH staged and unstaged changes
   * are included: a sibling agent asking "what have you changed" means
   * everything not committed, and plain `git diff` would silently omit whatever
   * the other session had already staged. Untracked files are NOT included —
   * `git diff` does not see them.
   *
   * ⚠️ **A REPO WITH NO COMMITS HAS NO `HEAD`**, and `git diff HEAD` there does
   * not return nothing — it fails with `fatal: ambiguous argument 'HEAD'`,
   * which this used to swallow into `{ isRepo: true, text: '' }`. A session
   * that had just scaffolded an entire project and staged it answered "I have
   * changed nothing": a confident wrong answer, which is the one failure mode
   * this whole query path is built to avoid. So an unborn HEAD falls back to
   * git's empty-tree object, against which every file reads as an addition.
   *
   * ⚠️ **`--no-ext-diff` IS THE SECURITY-RELEVANT FLAG, NOT `--no-textconv`.**
   * An earlier version of this comment claimed `--no-textconv` stopped a repo's
   * config running commands on our behalf. It does not — it disables textconv
   * filters only, and `diff.external` (or a `.gitattributes`-selected
   * `diff.<name>.command`) still executes. Measured: with
   * `diff.external = sh -c "echo PWNED"`, `--no-textconv` alone runs it and
   * `--no-ext-diff` does not. This matters more here than anywhere else in the
   * service, because #764 will point this at a folder another agent controls.
   *
   * Fail-open like the rest of this service: not a repo, no git, or a failed
   * command all yield `{ isRepo: false, text: '' }` rather than throwing.
   */
  async diff(folder: string): Promise<{ isRepo: boolean; text: string }> {
    // One probe, and the same one `status()` uses — `--show-toplevel` was a
    // second answer to a question this file already asks.
    const inside = await git(folder, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || inside.out.trim() !== 'true') return { isRepo: false, text: '' };
    // git's canonical empty tree: the base every file is an addition against.
    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const head = await git(folder, ['rev-parse', '--verify', '-q', 'HEAD']);
    const base = head.ok ? 'HEAD' : EMPTY_TREE;
    const r = await git(folder, ['diff', '--no-textconv', '--no-ext-diff', base]);
    return { isRepo: true, text: r.ok ? r.out : '' };
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
