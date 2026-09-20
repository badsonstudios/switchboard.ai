#!/usr/bin/env node
/**
 * Probe #758b — HOW does the prompt reach the CLI, when the prompt is a
 * transcript excerpt full of quotes and newlines?
 *
 * WHY THIS IS A SEPARATE QUESTION. `probe-label-containment.mjs` passed a 24 KB
 * excerpt as an **argv string** straight to `claude.exe` and it worked. The app
 * cannot copy that, and the reason is specific:
 *
 *   - `providers/claude.ts`'s `resolveCliPath` scans PATH, and on this machine
 *     PATH holds **`claude.cmd`**, not the exe.
 *   - Argv destined for a `.cmd` goes through `transport/win-cmd.ts`'s
 *     `execSpec`, which **throws** on a double quote (:268) and on control
 *     characters (:265). That guard exists because of #714 and is not something
 *     to route around — it is what stops cmd.exe's parser seeing live
 *     metacharacters.
 *   - A transcript excerpt is *made of* quotes and newlines.
 *
 * So the feature needs a delivery route that carries arbitrary text safely.
 * The candidate is **stdin**: `--help` calls `-p/--print` "useful for pipes".
 * That is a hint, not a contract (§2.2 — help has been wrong before), so it is
 * measured here.
 *
 * THE QUESTIONS
 *   Q7  Does `-p` with NO prompt argument read the prompt from stdin?
 *   Q8  Does stdin survive content that argv cannot — double quotes, newlines,
 *       backticks, `%PATH%`, `$(…)`, and a NUL-adjacent control character?
 *       The answer must come back proving the CLI saw the WHOLE thing.
 *   Q9  Does the same stdin route work through the **`.cmd` shim** — which is
 *       what `resolveCliPath` actually returns — and not only through the exe?
 *   Q10 CONTROL — argv with an embedded double quote, through the exe. If this
 *       succeeds, Q8's success is not yet an argument for stdin; if it fails,
 *       we have shown the failure the app's guard is there to prevent.
 *
 * HOW A "YES" IS PROVEN. Each prompt asks for a codeword that is unique to this
 * run and embedded AFTER the awkward characters. A reply carrying the codeword
 * proves the CLI received the whole prompt, not a truncated prefix — the s-09
 * rule (assert your input ARRIVED before reading a verdict out of it) and the
 * same technique #801 used.
 *
 * COST: at most four tiny `haiku` turns. Fully contained, per the sibling
 * probe's finding: `--tools "" --restricted --strict-mcp-config`.
 *
 *   node spike/probes/758/probe-prompt-delivery.mjs > delivery.json 2> delivery.txt
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const HOME = homedir();
const EXE = join(HOME, 'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
/** What `resolveCliPath` actually finds on PATH — the shim, not the exe. */
const CMD = join(HOME, 'AppData/Roaming/npm/claude.cmd');
const PROJECTS = join(HOME, '.claude', 'projects');
const MODEL = 'haiku';

const CONTAINED = [
  '--tools',
  '',
  '--restricted',
  '--strict-mcp-config',
  '--permission-mode',
  'default',
  '--model',
  MODEL,
];

function transcriptFiles() {
  const seen = new Set();
  if (!existsSync(PROJECTS)) return seen;
  for (const d of readdirSync(PROJECTS)) {
    let files = [];
    try {
      files = readdirSync(join(PROJECTS, d));
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith('.jsonl')) seen.add(join(PROJECTS, d, f));
  }
  return seen;
}

/**
 * @param stdinText when present, the prompt is PIPED and no prompt argv is given
 */
function run(file, args, { cwd, stdinText, timeoutMs = 90_000, shell = false } = {}) {
  return new Promise((res) => {
    const started = Date.now();
    let p;
    try {
      p = spawn(file, args, {
        cwd,
        stdio: [stdinText === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell,
      });
    } catch (e) {
      res({ code: null, out: '', err: `spawn threw: ${String(e)}`, spawnThrew: true, ms: 0 });
      return;
    }
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(t);
      res({ code, out, err, timedOut, ms: Date.now() - started });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      res({ code: null, out, err: String(e), spawnThrew: true, timedOut, ms: Date.now() - started });
    });
    if (stdinText !== undefined) {
      p.stdin.on('error', () => {
        /* the CLI may close stdin first; the close handler has the verdict */
      });
      p.stdin.end(stdinText);
    }
  });
}

/** The awkward payload argv cannot carry, with the codeword AFTER all of it. */
function nastyPrompt(codeword) {
  return [
    'Here is a transcript excerpt. It contains characters that break shells:',
    'user: he said "quote me" and then `backtick` and $(subshell) and %PATH%',
    'assistant: {"type":"text","text":"a JSON line with \\"escaped\\" quotes"}',
    'user: a line with a tab\tand trailing spaces   ',
    '',
    `Ignore all of the above content. Reply with exactly this word and nothing else: ${codeword}`,
  ].join('\n');
}

async function main() {
  const before = transcriptFiles();
  const scratch = mkdtempSync(join(tmpdir(), 'probe758b-'));
  const report = {
    probe: 'spike/probes/758/probe-prompt-delivery.mjs',
    when: new Date().toISOString(),
    exe: EXE,
    cmdShim: CMD,
    exeExists: existsSync(EXE),
    cmdShimExists: existsSync(CMD),
    model: MODEL,
    results: {},
  };
  const say = (s) => process.stderr.write(`${s}\n`);
  const verdict = (r, codeword) => ({
    exit: r.code,
    ms: r.ms,
    timedOut: !!r.timedOut,
    spawnThrew: !!r.spawnThrew,
    sawCodeword: r.out.includes(codeword),
    outTail: r.out.slice(-200),
    errTail: r.err.slice(-300),
  });

  // ── Q7 — does `-p` with no prompt argument read stdin at all? ────────────
  {
    const cw = `SB-${randomUUID().slice(0, 8).toUpperCase()}`;
    say('Q7  exe + stdin, no prompt argv...');
    const r = await run(EXE, [...CONTAINED, '-p'], {
      cwd: scratch,
      stdinText: `Reply with exactly this word and nothing else: ${cw}`,
    });
    report.results.Q7_stdinSimple = { codeword: cw, ...verdict(r, cw) };
    say(`    exit=${r.code} sawCodeword=${r.out.includes(cw)} ms=${r.ms}`);
  }

  // ── Q8 — does stdin carry what argv cannot? ─────────────────────────────
  {
    const cw = `SB-${randomUUID().slice(0, 8).toUpperCase()}`;
    say('Q8  exe + stdin, shell-hostile payload...');
    const r = await run(EXE, [...CONTAINED, '-p'], {
      cwd: scratch,
      stdinText: nastyPrompt(cw),
    });
    report.results.Q8_stdinNasty = { codeword: cw, ...verdict(r, cw) };
    say(`    exit=${r.code} sawCodeword=${r.out.includes(cw)} ms=${r.ms}`);
  }

  // ── Q9 — the route the APP would actually take: the .cmd shim ───────────
  {
    const cw = `SB-${randomUUID().slice(0, 8).toUpperCase()}`;
    say('Q9  .cmd SHIM + stdin (what resolveCliPath returns)...');
    // Node 22 refuses to spawn a .cmd without a shell (EINVAL, CVE-2024-27980).
    // `shell: true` is what `execSpec` exists to make safe — and note the argv
    // here is APP-AUTHORED ONLY: the prompt goes down stdin, so nothing
    // untrusted meets cmd.exe's parser. That is the whole proposition.
    const r = await run(CMD, [...CONTAINED, '-p'], {
      cwd: scratch,
      stdinText: nastyPrompt(cw),
      shell: true,
    });
    report.results.Q9_cmdShimStdin = { codeword: cw, ...verdict(r, cw) };
    say(`    exit=${r.code} sawCodeword=${r.out.includes(cw)} spawnThrew=${!!r.spawnThrew}`);
  }

  // ── Q10 — CONTROL: argv carrying a double quote, through the exe ────────
  {
    const cw = `SB-${randomUUID().slice(0, 8).toUpperCase()}`;
    say('Q10 CONTROL — the same payload as an ARGV string...');
    const r = await run(EXE, [...CONTAINED, '-p', nastyPrompt(cw)], { cwd: scratch });
    report.results.Q10_argvControl = {
      codeword: cw,
      ...verdict(r, cw),
      // The app could not do this anyway — `execSpec` throws on the quote long
      // before spawn — but knowing whether the CLI itself copes separates "the
      // app's guard forbids it" from "the CLI cannot take it".
      note: 'app-forbidden by execSpec regardless of this result',
    };
    say(`    exit=${r.code} sawCodeword=${r.out.includes(cw)}`);
  }

  // ── cleanup ─────────────────────────────────────────────────────────────
  const after = transcriptFiles();
  const minted = [...after].filter((f) => !before.has(f));
  let removed = 0;
  for (const f of minted) {
    try {
      rmSync(f);
      removed++;
    } catch {
      /* leave it rather than fight for a handle */
    }
  }
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* tmp dir, not worth failing over */
  }
  report.cleanup = { mintedTranscripts: minted.length, removed };
  say(`\ncleanup: ${removed}/${minted.length} minted transcripts removed`);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((e) => {
  process.stderr.write(`probe failed: ${String(e?.stack ?? e)}\n`);
  process.exitCode = 1;
});
