// S-09 spike: a minimal stdio MCP server whose ONLY job is to answer Claude
// Code's permission requests, so we can find out whether
// `--permission-prompt-tool` fires in INTERACTIVE (TUI) mode.
//
// Why this matters (2026-07-31): switchboard's approval UI rides on PreToolUse
// hooks, which cannot see anything the CLI decides above the hook layer — a
// `.claude/**` write is the case that exposed it. The VS Code extension DOES
// surface those prompts, via a `can_use_tool` control request carrying
// `blocked_path`/`decision_reason` — but it gets that by driving the CLI in
// stream-json mode with no terminal at all. If `--permission-prompt-tool
// mcp__<server>__<tool>` works against an interactive session, we get the same
// prompt WITHOUT giving up the real terminal.
//
// Everything this server sees is appended to a log file, because the whole
// point is to find out what (if anything) arrives.
const fs = require('fs');
const path = require('path');

const LOG = process.env.SB_PERM_LOG || path.join(__dirname, 'perm-calls.log');

function log(kind, payload) {
  fs.appendFileSync(
    LOG,
    JSON.stringify({ at: new Date().toISOString(), kind, payload }) + '\n'
  );
}

// The verdict shape the CLI expects back from a permission-prompt tool: a
// single text content block whose TEXT is JSON. (Documented for the SDK's
// stdio form; assumed identical here — if it is wrong, the CLI will say so and
// that itself is a finding.)
function verdict(behavior, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ behavior, ...extra }) }],
  };
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('unparseable', line.slice(0, 500));
      continue;
    }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  log('rpc', { id, method, params });

  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sbperm', version: '0.0.1' },
      },
    });
  }

  if (method === 'notifications/initialized') return; // no reply to notifications

  if (method === 'tools/list') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'approve',
            description:
              'Permission prompt handler. Claude Code calls this instead of showing its own prompt.',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object' },
                tool_use_id: { type: 'string' },
              },
              required: ['tool_name', 'input'],
            },
          },
        ],
      },
    });
  }

  if (method === 'tools/call') {
    // THE MEASUREMENT. If this ever fires from an interactive session, the
    // answer is yes and switchboard can own every permission prompt.
    log('PERMISSION_REQUEST', params);
    const input = params?.arguments?.input ?? {};
    // Always allow: we are measuring whether we are ASKED, not building policy.
    return send({
      jsonrpc: '2.0',
      id,
      result: verdict('allow', { updatedInput: input }),
    });
  }

  // anything else: minimal well-formed error so the CLI does not hang
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } });
  }
}

log('server-start', { argv: process.argv.slice(2), cwd: process.cwd() });
process.stdin.resume();
