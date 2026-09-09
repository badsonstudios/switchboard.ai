// P2-E11-03: the `mcp` capability and `--mcp-config`.
//
// A separate file from `claude.test.ts` because the load-bearing assertions
// here are NEGATIVE ones, and they deserve to be findable. #762's lesson was
// that a mutation set only measures the mutations you thought of; the ones
// worth thinking of on this item are the mutations that make the bus work
// perfectly while quietly costing the user their own MCP servers, or that
// change what a bus-less session spawns with.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import {
  AUTONOMY_PERMISSION_MODE,
  claudeAdapter,
  resetCliPathCache,
  writeSessionMcpConfig,
} from './claude';
import type { McpAttachmentHost, SpawnOptions } from '../extensibility/contributions';

let tmp: string;
let origPath: string | undefined;
beforeEach(() => {
  tmp = tempDir('sb-claude-mcp-');
  origPath = process.env.PATH;
  resetCliPathCache();
});
afterEach(() => {
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  cleanupTempDirs();
});

function withCliOnPath(): string {
  const name = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const cli = path.join(tmp, name);
  fs.writeFileSync(cli, 'stub');
  process.env.PATH = tmp + path.delimiter + (process.env.PATH ?? '');
  return cli;
}

const LAUNCH = {
  command: 'C:\\electron.exe',
  args: ['bus-server.js', '--session', 's1', '--pipe', 'P', '--token-file', 'T'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

/** A bus that answers with `launch`, and records who was asked about. */
function bus(launch: typeof LAUNCH | null): McpAttachmentHost & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    attachSession: (id) => {
      asked.push(id);
      return launch;
    },
    releaseSession: () => {},
  };
}

/**
 * Every combination a real spawn can present.
 *
 * The negatives below are only worth something if they hold across all of them:
 * a guard that only fires on the bare path is a guard the stream path walks
 * straight past, and the stream path is the default transport.
 */
const MATRIX: { label: string; opts: Partial<SpawnOptions> }[] = [
  { label: 'bare', opts: {} },
  { label: 'stream', opts: { transport: 'stream' } },
  { label: 'resume', opts: { resumeSessionId: 'native-1' } },
  { label: 'settings', opts: { settings: { model: 'x' } } },
  { label: 'full-auto', opts: { autonomy: 'full-auto' } },
  {
    label: 'everything',
    opts: {
      transport: 'stream',
      resumeSessionId: 'n',
      autonomy: 'plan',
      settings: { model: 'x' },
    },
  },
];

describe('claudeAdapter.capabilities.mcp (P2-E11-03)', () => {
  it('is declared at all — it was deliberately absent until this item', () => {
    expect(claudeAdapter.capabilities?.mcp).toBeDefined();
  });

  it('shapes the host launch into the config schema the CLI was MEASURED on', () => {
    // `spike/probes/760/probe-attach.mjs` wrote exactly this object and the CLI
    // answered `mcp_status` with our server connected, our serverInfo and our
    // tools. Not read off `--help`.
    const cfg = claudeAdapter.capabilities!.mcp!.configFor('s1', bus(LAUNCH)) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(cfg.mcpServers)).toEqual(['switchboard']);
    const entry = cfg.mcpServers.switchboard;
    expect(entry.type).toBe('stdio');
    expect(entry.command).toBe(LAUNCH.command);
    expect(entry.args).toEqual(LAUNCH.args);
    // Load-bearing, and the easiest thing in this diff to delete by accident:
    // the bus server is a rollup entry that in a packaged build lives inside
    // `app.asar`, and only Electron-as-node can read it there (#762 measured
    // plain node failing with MODULE_NOT_FOUND). `buildSpawn` STRIPS this same
    // variable from the session's own env a few lines away, so a reader who
    // assumes symmetry removes precisely this.
    expect(entry.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  });

  it('attaches NOTHING when the host has no bus for the session', () => {
    expect(claudeAdapter.capabilities!.mcp!.configFor('s1', bus(null))).toBeNull();
  });

  it('asks the host about the session it was actually given', () => {
    // A capability that ignored its argument would pass every other test in
    // this file and attach session A's endpoint to session B — which the host
    // rejects as "not authorized" for the rest of that session's life, with
    // nothing in any log to explain it (#762's own near-miss).
    const b = bus(LAUNCH);
    claudeAdapter.capabilities!.mcp!.configFor('the-right-one', b);
    expect(b.asked).toEqual(['the-right-one']);
  });
});

describe('claudeAdapter.buildSpawn — --mcp-config (P2-E11-03)', () => {
  it('points at a real, PARSEABLE file', () => {
    withCliOnPath();
    const servers = { mcpServers: { switchboard: { type: 'stdio', command: 'x', args: [], env: {} } } };
    const recipe = claudeAdapter.buildSpawn({
      cwd: tmp,
      sessionId: 'sess-1',
      stateDir: path.join(tmp, 'state'),
      mcpConfig: servers,
    });
    const i = recipe.args.indexOf('--mcp-config');
    expect(i).toBeGreaterThanOrEqual(0);
    const written = recipe.args[i + 1];
    expect(path.isAbsolute(written)).toBe(true);
    // The CLI SILENTLY IGNORES a config it cannot parse (the S-02 caveat that
    // cost us the hooks file once), so "the file exists" is not the claim worth
    // making. "It parses, and it says what we meant" is.
    expect(JSON.parse(fs.readFileSync(written, 'utf8'))).toEqual(servers);
  });

  it('writes it beside settings.json, in the per-session state directory', () => {
    // Not cosmetic. `abandonStart` and #290's sweep reclaim that directory, so a
    // config written anywhere else is a file nothing ever cleans up — and it
    // holds the path of a token file.
    withCliOnPath();
    const stateDir = path.join(tmp, 'state');
    const recipe = claudeAdapter.buildSpawn({
      cwd: tmp,
      sessionId: 'sess-1',
      stateDir,
      settings: { model: 'x' },
      mcpConfig: { mcpServers: {} },
    });
    const mcpPath = recipe.args[recipe.args.indexOf('--mcp-config') + 1];
    const settingsPath = recipe.args[recipe.args.indexOf('--settings') + 1];
    expect(path.dirname(mcpPath)).toBe(path.dirname(settingsPath));
    expect(path.dirname(mcpPath)).toBe(path.join(stateDir, 'sess-1'));
    // THE FILENAME, PINNED. Review of #763 found this test asserted only the
    // two DIRNAMES matched — which stays true if the config filename is changed
    // to `settings.json`, a mutation that survives the whole suite while
    // silently overwriting the hooks settings file and costing every session
    // every hook. "Beside settings.json" has to mean beside, not instead of.
    expect(path.basename(mcpPath)).toBe('mcp.json');
    expect(mcpPath).not.toBe(settingsPath);
    // Both files really exist, so "beside" is a fact about the disk rather than
    // about two strings.
    expect(fs.existsSync(mcpPath)).toBe(true);
    expect(fs.existsSync(settingsPath)).toBe(true);
  });

  it('refuses a non-object config rather than letting the CLI ignore it', () => {
    const stateDir = path.join(tmp, 'state');
    for (const bad of [null, [], 'x', 3]) {
      expect(() => writeSessionMcpConfig(stateDir, 's', bad as never)).toThrow(/plain object/);
    }
  });

  // ── THE NEGATIVES ─────────────────────────────────────────────────────────

  it.each(MATRIX)('never passes --strict-mcp-config ($label)', ({ opts }) => {
    withCliOnPath();
    const recipe = claudeAdapter.buildSpawn({
      cwd: tmp,
      sessionId: 's',
      stateDir: path.join(tmp, 'st'),
      mcpConfig: { mcpServers: { switchboard: {} } },
      ...opts,
    });
    // MEASURED, not inferred (#760, three runs): baseline `DeepWiki`; with
    // `--mcp-config`, `DeepWiki` + ours; with BOTH flags, ours only — DeepWiki
    // gone. Passing it evicts every server the user configured, silently.
    expect(recipe.args).not.toContain('--strict-mcp-config');
    // ...and the positive in the same breath, so a mutant that stops attaching
    // anything at all cannot pass this by making the negative vacuous.
    expect(recipe.args).toContain('--mcp-config');
  });

  it.each(MATRIX)('spawns byte-identically with no mcpConfig ($label)', ({ opts }) => {
    withCliOnPath();
    const base: SpawnOptions = {
      cwd: tmp,
      sessionId: 's',
      stateDir: path.join(tmp, 'st'),
      ...opts,
    };
    const recipe = claudeAdapter.buildSpawn(base);
    // §5.3's claim is not "no new flag" — it is that a provider which declares
    // no `mcp` capability spawns EXACTLY as it did before E11.
    //
    // ⚠️ THIS USED TO READ `expect(recipe).toEqual(buildSpawn(base))`, which
    // compares the output to a second call with the same input and therefore
    // proves DETERMINISM, not byte-identity — an unconditional `env: {FOO:'1'}`
    // or a forced `transport: 'stream'` survived it, while its own comment
    // claimed it caught exactly those (found in review of #763). Pinned against
    // LITERALS now, so the expectation lives outside the implementation.
    expect(recipe.env).toEqual({
      ELECTRON_RUN_AS_NODE: undefined,
      ELECTRON_NO_ATTACH_CONSOLE: undefined,
    });
    expect(recipe.transport).toBe(opts.transport === 'stream' ? 'stream' : undefined);
    // The full argv, as a literal — not "does not contain the new flag", which
    // is satisfied by any number of OTHER things having been added.
    const expected: string[] = [];
    if (opts.settings) expected.push('--settings', path.join(tmp, 'st', 's', 'settings.json'));
    if (opts.transport === 'stream') {
      expected.push(
        '--output-format', 'stream-json',
        '--verbose',
        '--input-format', 'stream-json',
        '--permission-prompt-tool', 'stdio',
        '--replay-user-messages',
        '--include-partial-messages'
      );
    }
    if (opts.resumeSessionId) expected.push('--resume', opts.resumeSessionId);
    expected.push('--permission-mode', AUTONOMY_PERMISSION_MODE[opts.autonomy ?? 'ask']);
    expect(recipe.args).toEqual(expected);
    // ...and nothing was written for a session that asked for nothing.
    expect(fs.existsSync(path.join(tmp, 'st', 's', 'mcp.json'))).toBe(false);
  });
});

/**
 * Every line of CODE (not prose) naming `--strict-mcp-config` under `root`.
 *
 * ONE FUNCTION, called by both the real check and its self-test. The first
 * version had two copies of this walk — the real one over `src/main`, a
 * hand-written twin over a fixture — so the "guard's guard" could not catch a
 * mutation in the guard, which is the entire thing it existed to do. Review of
 * #763 named four mutations that survived it: narrowing `root`, dropping the
 * recursion, and changing the extension.
 */
function flagOffenders(root: string): string[] {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (!e.name.endsWith('.ts') && !e.name.endsWith('.tsx')) continue;
      if (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx')) continue;
      // AN EXPLICIT ALLOWLIST, not a `-check.ts` suffix rule. The suffix version
      // silently exempted any future production file that happened to be named
      // `*-check.ts` — a preflight, a health check — which review flagged as an
      // exemption nobody had bounded. These two are local check harnesses: test
      // code that lives under `src/` only so the same build compiles it, and
      // `mcp-attach-check.ts` ASSERTS the flag's absence, so it has to be able
      // to name it exactly as a `.test.ts` does. Neither spawns a user session.
      if (EXEMPT.includes(e.name)) continue;
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (!line.includes('--strict-mcp-config')) continue;
        // Prose may name it — the reason we never pass it has to be writable
        // down. Code may not.
        const t = line.trimStart();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
        offenders.push(`${path.relative(root, full)}: ${t}`);
      }
    }
  };
  walk(root);
  return offenders;
}

const EXEMPT = ['mcp-attach-check.ts'];

describe('the --strict-mcp-config source guard (P2-E11-03)', () => {
  it('the flag appears in no shipping source file', () => {
    // "We just will not add it" is not a mechanism; this is. The flag evicts
    // every MCP server the user configured, and the failure is silent and total
    // — their servers simply gone from every session switchboard starts. A
    // future item reaching for it to make something deterministic has to delete
    // this test to do it, which is exactly the friction wanted.
    //
    // WHOLE OF `src/`, not just `src/main`. Review pointed out the original
    // walked one directory and so said nothing about `shared`, `preload` or the
    // renderer. There is no reason any of them would build a CLI argv, and that
    // is the point: a guard should cover the places you are confident about too.
    expect(flagOffenders(path.join(__dirname, '..', '..'))).toEqual([]);
  });

  it("the guard's guard — the SAME function really flags a violation", () => {
    // Without this, the test above passes just as happily against a walk that
    // matched nothing: a wrong root, a changed extension, a `readdir` that threw
    // into an empty list. #762's lesson in miniature — an assertion that has
    // never been shown to fail is not evidence that anything works.
    //
    // It calls `flagOffenders` itself, so a mutation to the real walk fails HERE
    // as well as going unnoticed above.
    const dir = path.join(tmp, 'fake-src');
    fs.mkdirSync(path.join(dir, 'deep', 'nested'), { recursive: true });
    // Buried two levels down, so deleting the recursion fails this.
    fs.writeFileSync(path.join(dir, 'deep', 'nested', 'bad.ts'), "args.push('--strict-mcp-config');\n");
    fs.writeFileSync(path.join(dir, 'ok.ts'), '// never pass --strict-mcp-config\n');
    fs.writeFileSync(path.join(dir, 'ok.test.ts'), "expect(a).not.toContain('--strict-mcp-config');\n");
    fs.writeFileSync(path.join(dir, 'tsx-counts.tsx'), "const x = '--strict-mcp-config';\n");
    const hits = flagOffenders(dir).map((h) => h.split(':')[0]);
    expect(hits.sort()).toEqual([path.join('deep', 'nested', 'bad.ts'), 'tsx-counts.tsx'].sort());
  });

  it('the exemption is an allowlist, and it does not cover the adapter', () => {
    // An exemption nobody bounds is how a guard dies. `providers/claude.ts` is
    // the file that actually builds the argv a user's session runs with.
    expect(EXEMPT).not.toContain('claude.ts');
    // And the allowlist is not vacuous — it names something that really exists,
    // so a rename that orphans the entry shows up here rather than silently
    // re-arming the guard against a file that legitimately names the flag.
    for (const name of EXEMPT) {
      expect(fs.existsSync(path.join(__dirname, '..', 'bus', name))).toBe(true);
    }
  });
});
