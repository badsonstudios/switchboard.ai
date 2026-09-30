// #997 probe — does an `is_meta: true` frame reach our STREAM, and would the
// Feed render it?
//
// ---------------------------------------------------------------------------
// WHY THIS PROBE EXISTS
//
// `src/main/feed/blocks.ts` drops a CLI-internal line with
// `if (entry.isMeta === true) return []`. `isMeta` is the TRANSCRIPT spelling.
// Reading the PATH binary (2.1.280) for every builder that sets
// `model: "<synthetic>"` turned up the stream spelling: **`is_meta`** —
// snake_case — and nothing in `src/` matches `is_meta` at all (grep: zero).
// So on the stream path that guard is read by nothing.
//
// The issue was filed asking for a PushNotification frame to be provoked. That
// is the WRONG TARGET, and reading the binary is what said so — see
// `spike/findings/997-is-meta-on-the-stream.md` §1. In one sentence: the
// PushNotification builder's only call site is inside the interactive REPL's
// remote-control bridge hook, behind two remote configs that both default off,
// and it writes to the BRIDGE, not to stdout. It cannot be provoked from here.
//
// The same read found a builder that CAN be: a hook whose JSON output carries
// `systemMessage` becomes an internal `attachment: hook_system_message`, and
// the SDK converter turns THAT into
//
//   {type:"assistant", message:{content:[…]}, parent_tool_use_id:null,
//    is_meta:true, session_id, uuid, timestamp}
//
// on the wire. Hooks are not exotic — switchboard writes its own on every
// spawn (`buildHookSettings`), and so does anyone with a `settings.json`.
//
// ---------------------------------------------------------------------------
// WHAT IS MEASURED, and why each piece is here
//
// ONE turn, one cheap prompt, against the real CLI with switchboard's exact
// flag list plus `--settings <path>` (which the app also passes, S-02).
//
// TWO INDEPENDENT ASSERTIONS, because #978 and S-09 both record the same trap:
// a silent result is indistinguishable from a broken harness.
//
//   * THE HOOK MARKER. Each hook invocation appends a line to a file. If the
//     marker is empty, the hook never ran and "no `is_meta` frame" is a
//     statement about this probe, not about the CLI.
//   * THE CONTROL TOKEN. The model is asked to echo one word. If it does not
//     arrive, the stream is not working and nothing above it is evidence.
//
// Both must pass before the verdict means anything, and the verdict says so
// out loud rather than leaving it to the reader.
//
// THE SIBLING FLAGS ARE CHECKED IN THE SAME RUN. The issue asks for
// `isVisibleInTranscriptOnly` and `isCompactSummary` too. Rather than trying to
// provoke each, every frame is scanned for ANY key matching /^is[_A-Z]/ and the
// set is reported — so a spelling nobody predicted shows up as itself.
//
// THE TRANSCRIPT IS READ TOO, because the comparison is the whole point: if the
// same hook message is `isMeta` in the file and `is_meta` on the wire, that is
// the two-spellings finding stated as a measurement rather than as a grep.
//
// Real CLI, one turn, no `--bg`: nothing survives the kill. Temp cwd removed at
// the end. Run `claude agents --json` before and after anyway.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONTROL_TOKEN = 'MARMALADE-9971';
const SYS_MSG = 'SB997-HOOK-SYSTEM-MESSAGE';
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb997-probe-'));
const markerPath = path.join(cwd, 'hook-marker.txt');
const hookScript = path.join(cwd, 'hook.mjs');
const settingsPath = path.join(cwd, 'settings.json');

/**
 * The hook. Appends to the marker (so "it ran" is provable independently of
 * anything on the stream) and prints `systemMessage` on stdout.
 *
 * `systemMessage` is a TOP-LEVEL key of the hook's JSON output — read off the
 * binary's own schema (`systemMessage:o().describe("Warning message shown to
 * the user").optional()`), not guessed. `hookSpecificOutput` is not needed for
 * this field and is deliberately omitted: fewer moving parts to misspell.
 *
 * An mjs script run through `node` rather than a shell one-liner, because the
 * CLI runs hook commands through the platform shell and a JSON literal with
 * quotes in it does not survive `cmd.exe` intact.
 */
fs.writeFileSync(
  hookScript,
  [
    `import fs from 'node:fs';`,
    `let raw = '';`,
    `process.stdin.on('data', (c) => (raw += c));`,
    `process.stdin.on('end', () => {`,
    `  let ev = 'unknown';`,
    `  try { ev = JSON.parse(raw).hook_event_name ?? 'unknown'; } catch {}`,
    `  fs.appendFileSync(${JSON.stringify(markerPath)}, ev + '\\n');`,
    `  process.stdout.write(JSON.stringify({ systemMessage: ${JSON.stringify(SYS_MSG)} + ' [' + ev + ']' }));`,
    `  process.exit(0);`,
    `});`,
  ].join('\n')
);

/**
 * `UserPromptSubmit` is the primary: it fires once, before the model, on a
 * prompt that uses no tools — the cheapest event that can carry a
 * `systemMessage` at all.
 *
 * `Stop` is the second chance, because the binary's Stop-hook collector was
 * seen pushing a `hook_system_message` attachment down a different path, and a
 * hook that returns ONLY `systemMessage` sets no continuation flag — so it
 * cannot provoke a second model turn. The probe kills the session after the
 * first `result` regardless, so a surprise there cannot spend more tokens.
 */
const nodeExe = process.execPath;
const hookCommand = `"${nodeExe}" "${hookScript}"`;
fs.writeFileSync(
  settingsPath,
  JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand }] }],
        Stop: [{ hooks: [{ type: 'command', command: hookCommand }] }],
      },
    },
    null,
    2
  )
);

/**
 * switchboard's own flag list, verbatim from `src/main/providers/claude.ts`
 * (the `args.push(...)` block), plus the `--settings` this probe needs. Copied
 * rather than imported, for #978's reason: the point is to measure what the
 * SHIPPED spawn does, and an import would track a refactor without anyone
 * noticing the probe's premise had moved.
 *
 * `--permission-mode default` is added on purpose. #760's discovery probe is
 * the cautionary tale — a `bypassPermissions` probe is not contained by its
 * cwd and went reading this machine's other live sessions. Nothing here needs
 * a tool, so nothing here gets permission to use one.
 */
const ARGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--permission-prompt-tool', 'stdio',
  '--replay-user-messages',
  '--include-partial-messages',
  '--settings', settingsPath,
  '--permission-mode', 'default',
];

const child =
  process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'claude', ...ARGS], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn('claude', ARGS, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

const frames = [];
let sessionId = null;
let results = 0;
const waiters = [];
let buf = '';
const stderrChunks = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    frames.push(m);
    if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
      sessionId = m.session_id;
    }
    if (m.type === 'result') {
      results++;
      for (const w of waiters.splice(0)) w();
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => stderrChunks.push(c));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const untilResults = (n, ms) =>
  Promise.race([
    new Promise((r) => {
      const check = () => (results >= n ? r() : waiters.push(check));
      check();
    }),
    sleep(ms),
  ]);

// #760's finding: a control request written to stdin at t=0 is silently lost.
// The same delay is kept for the first user frame — every 721 probe waits and
// that wait is load-bearing.
await sleep(2500);

child.stdin.write(
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: `Reply with exactly the word ${CONTROL_TOKEN} and nothing else.` },
  }) + '\n'
);
await untilResults(1, 120_000);
// Long enough for a `Stop` hook's own frame to land after the result.
await sleep(4000);

if (process.platform === 'win32' && child.pid) {
  spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
child.stdin.end();
child.kill();
await sleep(1000);

const markerLines = fs.existsSync(markerPath)
  ? fs.readFileSync(markerPath, 'utf8').split('\n').filter((l) => l.trim())
  : [];

/**
 * Every `is*` flag seen anywhere in the frame set, at the TOP LEVEL of a frame
 * and inside `message`. Reported as a set rather than tested one name at a
 * time, so `isVisibleInTranscriptOnly`, `isCompactSummary` and any spelling
 * nobody predicted all show up as themselves.
 */
function flagCensus(objects) {
  const seen = {};
  const note = (where, k, v) => {
    const key = `${where}.${k}`;
    seen[key] = seen[key] ?? { count: 0, values: new Set() };
    seen[key].count++;
    seen[key].values.add(JSON.stringify(v));
  };
  for (const m of objects) {
    for (const [k, v] of Object.entries(m)) {
      if (/^is[_A-Z]/.test(k)) note('frame', k, v);
    }
    const msg = m.message;
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      for (const [k, v] of Object.entries(msg)) {
        if (/^is[_A-Z]/.test(k)) note('frame.message', k, v);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(seen).map(([k, v]) => [k, { count: v.count, values: [...v.values] }])
  );
}

const metaFrames = frames.filter((m) => m.is_meta === true || m.isMeta === true);
const sysMsgFrames = frames.filter((m) => JSON.stringify(m).includes(SYS_MSG));

function findTranscript(id) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(root)) return null;
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const f = path.join(root, dir.name, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

const transcript = sessionId ? findTranscript(sessionId) : null;

/**
 * The transcript side. Only the entries carrying the hook's own marker string
 * are interesting — those are the SAME event as the wire frames above, which is
 * what makes the spelling comparison a measurement rather than an inference.
 */
function transcriptShape() {
  if (!transcript) return null;
  const all = [];
  for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      all.push(JSON.parse(l));
    } catch {
      /* partial tail */
    }
  }
  return {
    entryCount: all.length,
    flagCensus: flagCensus(all),
    hookMessageEntries: all
      .filter((e) => JSON.stringify(e).includes(SYS_MSG))
      .map((e) => ({
        type: e.type,
        isMeta: e.isMeta ?? null,
        is_meta: e.is_meta ?? null,
        keys: Object.keys(e).filter((k) => /^is[_A-Z]/.test(k)),
        raw: JSON.stringify(e).slice(0, 700),
      })),
  };
}

const controlText = frames
  .filter((m) => m.type === 'assistant')
  .flatMap((m) => (Array.isArray(m.message?.content) ? m.message.content : []))
  .filter((c) => c?.type === 'text')
  .map((c) => c.text)
  .join('');

const hookRan = markerLines.length > 0;
const controlWorked = controlText.includes(CONTROL_TOKEN);
const metaArrived = metaFrames.length > 0;

const report = {
  cli: spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : 'claude',
    process.platform === 'win32' ? ['/c', 'claude', '--version'] : ['--version'],
    { encoding: 'utf8' }
  ).stdout.trim(),
  args: ARGS,
  sessionId,
  transcript,
  // --- the two assertions that have to pass before the verdict means anything
  hookRan,
  hookInvocations: markerLines,
  controlWorked,
  controlText: controlText.slice(0, 300),
  // --- the finding
  frameCount: frames.length,
  frameTypes: frames.reduce((acc, m) => {
    const k = m.subtype ? `${m.type}:${m.subtype}` : m.type;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {}),
  flagCensus: flagCensus(frames),
  metaFrameCount: metaFrames.length,
  // WHOLE, not summarised: only the raw frame answers "in a shape our
  // derivation would render", which is the half that decides where the fix goes.
  metaFramesRaw: metaFrames.slice(0, 4),
  framesCarryingSystemMessage: sysMsgFrames.map((m) => JSON.stringify(m).slice(0, 700)),
  transcriptShape: transcriptShape(),
  stderr: stderrChunks.join('').slice(0, 1500),
  verdict: !hookRan
    ? 'PROBE BROKEN: the hook never ran (marker empty) — nothing here is evidence about is_meta'
    : !controlWorked
      ? 'PROBE BROKEN: the control token never came back — the stream is not working'
      : metaArrived
        ? 'IS_META REACHES THE STREAM: a frame arrived with is_meta === true. blocks.ts reads only isMeta, so it is not dropped.'
        : 'NO IS_META FRAME on this turn shape, with both assertions passing. See the findings note before reading this as proof of absence.',
};
process.stdout.write(JSON.stringify(report, null, 2) + '\n');

await sleep(800);
for (let i = 0; i < 6; i++) {
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* handle may linger */
  }
  if (!fs.existsSync(cwd)) break;
  await sleep(500);
}
if (fs.existsSync(cwd)) process.stderr.write(`!! temp cwd survived: ${cwd}\n`);
process.exit(0);
