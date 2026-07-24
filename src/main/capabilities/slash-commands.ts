// Slash-command discovery (P2-E10-07, §5.17/§5.19 seed): what can the user
// type after '/' in this session? Merges the provider's builtin catalog with
// the project's and user's own commands and skills — plain files under
// `.claude/`, so this is a directory scan + light frontmatter parse (the
// §5.19 Capability Inspector will grow from the same scan).
//
// Fail-open (hard constraint): a scan error yields whatever was gathered —
// worst case the builtins — and NEVER rejects. Fully async: the scan runs on
// the main process, and a slow disk (network home dir) must never stall IPC
// for every window. No cache: the scan runs only when the popup opens and
// reads a handful of tiny files, and always-fresh means a just-added command
// shows up immediately.
import { promises as fsp } from 'fs';
import path from 'path';
import { mergeCommands, SlashCommand, SlashCommandSource } from '../../shared/slash-commands';

const MAX_COMMAND_DEPTH = 3; // subdirs namespace commands: sub/cmd.md -> /sub:cmd
const FRONTMATTER_BYTES = 4096; // descriptions live in the first few lines

export interface ScanRoots {
  /** the session's folder — project-scope `.claude/` lives here */
  cwd: string;
  /** the user's `~/.claude` (injectable for tests) */
  userClaudeDir: string;
}

export async function scanSlashCommands(
  roots: ScanRoots,
  builtins: SlashCommand[],
  log?: (msg: string) => void
): Promise<SlashCommand[]> {
  const projectClaude = path.join(roots.cwd, '.claude');
  const scanned = await Promise.all([
    scanCommandsDir(path.join(projectClaude, 'commands'), 'project-command', log),
    scanCommandsDir(path.join(roots.userClaudeDir, 'commands'), 'user-command', log),
    scanSkillsDir(path.join(projectClaude, 'skills'), 'project-skill', log),
    scanSkillsDir(path.join(roots.userClaudeDir, 'skills'), 'user-skill', log),
  ]);
  return mergeCommands(builtins, ...scanned);
}

/** `<dir>/**\/*.md` -> one command per file; subdirectories namespace with ':'. */
async function scanCommandsDir(
  dir: string,
  source: SlashCommandSource,
  log?: (msg: string) => void,
  prefix = '',
  depth = 0
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // no such dir — the common case, not an error
  }
  for (const e of entries) {
    try {
      if (e.isDirectory()) {
        if (depth < MAX_COMMAND_DEPTH) {
          out.push(...(await scanCommandsDir(path.join(dir, e.name), source, log, `${prefix}${e.name}:`, depth + 1)));
        }
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const name = prefix + e.name.slice(0, -3);
        out.push({ name, source, description: (await readFrontmatter(path.join(dir, e.name)))?.description });
      }
    } catch (err) {
      log?.(`slash-command scan skipped ${path.join(dir, e.name)}: ${String(err)}`);
    }
  }
  return out;
}

/** `<dir>/<name>/SKILL.md` -> one command per skill directory. */
async function scanSkillsDir(
  dir: string,
  source: SlashCommandSource,
  log?: (msg: string) => void
): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const fm = await readFrontmatter(path.join(dir, e.name, 'SKILL.md'));
      if (fm === null) continue; // no SKILL.md -> not a skill
      out.push({ name: fm.name ?? e.name, source, description: fm.description });
    } catch (err) {
      log?.(`skill scan skipped ${path.join(dir, e.name)}: ${String(err)}`);
    }
  }
  return out;
}

/**
 * Light YAML-frontmatter parse: top-level `key: value` lines between the
 * opening and closing `---`. Enough for name/description — a real YAML
 * dependency isn't warranted for two fields. Block-scalar values
 * (`description: |`, `>-` …) read as "no description" rather than a literal
 * indicator character. Returns null when the file can't be read (missing);
 * malformed content just yields empty fields — fail-open.
 */
async function readFrontmatter(file: string): Promise<{ name?: string; description?: string } | null> {
  let head = '';
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(FRONTMATTER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = buf.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
  const lines = head.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const out: { name?: string; description?: string } = {};
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const m = /^(name|description):\s*(.+)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^['"]|['"]$/g, '');
    // a YAML block-scalar indicator means the value lives on later indented
    // lines — beyond this parser; better no description than garbage
    if (!value || /^[|>][+-]?$/.test(value)) continue;
    out[m[1] as 'name' | 'description'] = value;
  }
  return out;
}
