// E40 item 05 (#1288): the per-AI surfaces stay out of shared code.
//
// Two halves. The SOURCE GUARD fails if one of the surface modules hard-codes
// Claude again — a path under `.claude`, Anthropic's page, a Claude model
// family, Claude's CLI lookup or one of the Claude surface modules — so the
// next "just this once" is a red test rather than a review comment. The
// CAPABILITY half pins that both Claude adapters declare the same, real
// surfaces, which is what keeps "no visible change for Claude" true for the
// e2e suite (it runs the fake).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { claudeAdapter } from './claude';
import { fakeStreamAdapter } from './fake-stream';
import { claudeSurfaces, CLAUDE_STATUSPAGE_BASE } from './claude-surfaces';
import { claudeEstimateCostUsd } from './claude-pricing';
import { claudePreflight } from './claude-preflight';
import { runContainedPrompt } from './claude-oneshot';
import { claudeCommandFiles } from './claude-command-files';

const ROOT = path.resolve(__dirname, '../../..');
const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Code with comments removed and strings KEPT (the same reader as `engine-seam.test.ts`). */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

/** The modules #1288 took Claude out of. Each must stay out of `providers/`. */
const SURFACE_MODULES = [
  'src/main/preflight.ts',
  'src/main/slash-commands-for.ts',
  'src/main/health/statuspage.ts',
  'src/main/health/service.ts',
  'src/main/mcp/ipc.ts',
  'src/main/mcp/redact-url.ts',
  'src/main/usage/price.ts',
  'src/main/usage/event-usage.ts',
  'src/renderer/src/lib/usage.ts',
  'src/renderer/src/lib/service-health.ts',
  'src/renderer/src/extensibility/status-bar-items.tsx',
];

/** What "hard-codes Claude" looks like in code (comments are allowed to say it). */
const CLAUDE_IN_CODE: Array<[string, RegExp]> = [
  ['a path under .claude', /['"`/\\]\.claude(\.json)?\b/],
  ["Anthropic's status page", /anthropic/i],
  ['a Claude model family', /\b(opus|sonnet|haiku|fable|mythos)\b/i],
  ["Claude's CLI lookup", /\bresolveCliPath\b/],
  ['a Claude surface module', /providers\/claude/],
];

describe('the per-AI surfaces hard-code no AI (#1288)', () => {
  it.each(SURFACE_MODULES)('%s', (file) => {
    const code = stripComments(read(file));
    for (const [what, pattern] of CLAUDE_IN_CODE) {
      expect(pattern.test(code), `${file} contains ${what}: ${pattern}`).toBe(false);
    }
  });

  it('the guard can fail: each pattern matches what it is meant to catch', () => {
    // Witness, so a regex that silently matches nothing cannot keep this green.
    const samples = [
      "path.join(os.homedir(), '.claude.json')",
      "const BASE = 'https://status.anthropic.com'",
      "{ match: /sonnet/i, rate: {} }",
      'const cli = resolveCliPath();',
      "import { x } from '../providers/claude-pricing'",
    ];
    CLAUDE_IN_CODE.forEach(([, pattern], i) => expect(pattern.test(samples[i])).toBe(true));
  });

  it('the label path, the slash-command wiring and the MCP Manager reach Claude only through a provider', () => {
    const ipc = stripComments(read('src/main/sessions/ipc.ts'));
    expect(ipc).not.toMatch(/providers\/claude-oneshot/);
    const index = stripComments(read('src/main/index.ts'));
    for (const gone of [/claude-oneshot/, /runContainedPrompt/, /scanSlashCommands/, /mcp\/config/, /\.claude['"]/]) {
      expect(gone.test(index), `index.ts still has ${gone}`).toBe(false);
    }
  });
});

describe('Claude declares its surfaces, and the e2e fake declares the same ones', () => {
  const KEYS = ['usage', 'statusPage', 'preflight', 'labels', 'mcpManager', 'commandFiles'] as const;

  it.each([
    ['claudeAdapter', claudeAdapter],
    ['fakeStreamAdapter', fakeStreamAdapter],
  ])('%s', (_name, adapter) => {
    for (const k of KEYS) expect(adapter.capabilities?.[k], k).toBe(claudeSurfaces[k]);
  });

  it('the surfaces are the real Claude implementations', () => {
    expect(claudeSurfaces.usage?.estimateCostUsd).toBe(claudeEstimateCostUsd);
    expect(claudeSurfaces.statusPage?.base).toBe(CLAUDE_STATUSPAGE_BASE);
    expect(CLAUDE_STATUSPAGE_BASE).toBe('https://status.anthropic.com'); // DESIGN §5.14's address
    expect(claudeSurfaces.preflight?.check).toBe(claudePreflight);
    expect(claudeSurfaces.labels?.run).toBe(runContainedPrompt);
    expect(claudeSurfaces.commandFiles).toBe(claudeCommandFiles);
  });
});
