// Shared harness for the #1285 probes: spawn an ACP (or app-server) agent the
// way the app spawns a Windows `.cmd` shim, speak newline-delimited JSON-RPC 2.0
// to it, and write EVERY byte it sends (and every frame we send) to a JSON-lines
// capture file, redacted.
//
// The spawn shape is a COPY of `src/main/transport/win-cmd.ts` `execSpec`
// (quoteArg + escapeForCmd + `cmd.exe /d /v:off /s /c "<line>"` with
// windowsVerbatimArguments). It is copied, not imported, because the spike runs
// under plain `node` with no TypeScript loader; the two functions are short and
// pure, and the point of the probe is to measure that exact shape.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CAPTURES = path.join(HERE, 'captures');
export const SANDBOX = path.join(HERE, 'sandbox');
export const ADAPTER = '@agentclientprotocol/codex-acp@2.2.2';
export const NODE = process.execPath;

const BS = String.fromCharCode(92); // a backslash, built from its code point

export function quoteArg(arg) {
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === BS) {
      slashes += 1;
      out += ch;
      continue;
    }
    if (ch === '"') {
      out += BS.repeat(slashes) + '""';
      slashes = 0;
      continue;
    }
    slashes = 0;
    out += ch;
  }
  return out + BS.repeat(slashes) + '"';
}

export function escapeForCmd(s) {
  return s.replace(/[()%!^"<>&|]/g, (c) => '^' + c);
}

/**
 * `stream-service.ts` `launchSpec`: `cmd.exe /c <cli> <args...>`, libuv quoting.
 * App-authored argv only (see that file's header).
 */
export function launchSpec(cli, args) {
  if (!/\.(cmd|bat)$/i.test(cli)) return { file: cli, argv: [...args], windowsVerbatimArguments: false };
  return { file: 'cmd.exe', argv: ['/c', cli, ...args], windowsVerbatimArguments: false };
}

/** Which spawn shape the probes use; set by SPAWN_SHAPE=exec|launch (default launch). */
export function spawnSpec(cli, args) {
  return (process.env.SPAWN_SHAPE || 'launch') === 'exec' ? execSpec(cli, args) : launchSpec(cli, args);
}

export function execSpec(cli, args) {
  if (!/\.(cmd|bat)$/i.test(cli)) {
    return { file: cli, argv: [...args], windowsVerbatimArguments: false };
  }
  const line = [cli, ...args].map((a) => escapeForCmd(quoteArg(a))).join(' ');
  return {
    file: path.win32.join(process.env.SystemRoot || 'C:' + BS + 'Windows', 'System32', 'cmd.exe'),
    argv: ['/d', '/v:off', '/s', '/c', '"' + line + '"'],
    windowsVerbatimArguments: true,
  };
}

/** `npx.cmd` next to the running node.exe (Node's own install layout). */
export function npxCmd() {
  return path.join(path.dirname(process.execPath), 'npx.cmd');
}

// ── redaction ────────────────────────────────────────────────────────────────
// Emails, JWT-shaped strings, and the VALUE of any key that names a token,
// cookie, secret, key or account/user id. Applied to every line before it is
// written; the raw bytes are never stored.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/g;
const JWT = /eyJ[A-Za-z0-9_-]{8,}[.][A-Za-z0-9_-]{8,}[.]?[A-Za-z0-9_-]*/g;
const SECRET_KEY = /(token|cookie|secret|api_?key|password|account_?id|user_?id|chatgpt_?account)/i;

export function redactValue(v) {
  if (typeof v === 'string') return v.replace(EMAIL, '<redacted-email>').replace(JWT, '<redacted-jwt>');
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && typeof val === 'string' && val.length > 0) o[k] = '<redacted>';
      else o[k] = redactValue(val);
    }
    return o;
  }
  return v;
}

export function redactText(s) {
  return s.replace(EMAIL, '<redacted-email>').replace(JWT, '<redacted-jwt>');
}

// ── process hygiene ──────────────────────────────────────────────────────────
export function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

export function codexProcesses() {
  const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => /codex/i.test(l))
    .map((l) => l.trim());
}

// ── the client ───────────────────────────────────────────────────────────────
export class RpcClient {
  /**
   * @param {object} o
   * @param {string} o.name           capture file stem
   * @param {string} o.cli            the executable (`.cmd` goes through cmd.exe)
   * @param {string[]} o.args
   * @param {object} [o.env]          merged over process.env; `null` value deletes
   * @param {string} [o.cwd]
   * @param {(method:string, params:any)=>any} [o.onRequest]  agent->client requests
   */
  constructor(o) {
    this.o = o;
    this.nextId = 1;
    this.pending = new Map();
    this.frames = []; // every inbound parsed frame
    this.nonJson = []; // every stdout line that did not parse
    this.stderr = '';
    this.t0 = Date.now();
    fs.mkdirSync(CAPTURES, { recursive: true });
    this.capPath = path.join(CAPTURES, o.name + '.jsonl');
    fs.writeFileSync(this.capPath, '');
    this.firstStdout = null;
    this.firstStderr = null;
    this.waiters = [];
  }

  cap(rec) {
    const line = JSON.stringify(redactValue({ t: Date.now() - this.t0, ...rec }));
    fs.appendFileSync(this.capPath, line + '\n');
  }

  note(text, extra) {
    this.cap({ dir: 'note', text, ...(extra ? { extra } : {}) });
    console.log('[note] ' + redactText(text));
  }

  start() {
    const env = { ...process.env };
    for (const [k, v] of Object.entries(this.o.env || {})) {
      if (v === null) delete env[k];
      else env[k] = v;
    }
    const spec = spawnSpec(this.o.cli, this.o.args);
    this.cap({ dir: 'note', text: 'spawn', extra: { file: spec.file, argv: spec.argv, cwd: this.o.cwd || process.cwd(), envOverrides: this.o.env || {} } });
    this.child = spawn(spec.file, spec.argv, {
      cwd: this.o.cwd,
      env,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.exited = new Promise((res) => this.child.on('exit', (code, sig) => {
      this.cap({ dir: 'note', text: 'exit', extra: { code, sig } });
      res({ code, sig });
    }));
    let buf = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      if (this.firstStdout === null) {
        this.firstStdout = { t: Date.now() - this.t0, bytes: d.slice(0, 120) };
        this.cap({ dir: 'note', text: 'first-stdout', extra: this.firstStdout });
      }
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!raw.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(raw);
        } catch {
          this.nonJson.push(raw);
          this.cap({ dir: 'nonjson-stdout', text: raw });
          continue;
        }
        this.cap({ dir: 'in', frame: msg });
        this.frames.push(msg);
        this.dispatch(msg);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d) => {
      if (this.firstStderr === null) {
        this.firstStderr = { t: Date.now() - this.t0, bytes: d.slice(0, 200) };
      }
      this.stderr += d;
      this.cap({ dir: 'stderr', text: d });
    });
    return this;
  }

  dispatch(msg) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      Promise.resolve()
        .then(() => (this.o.onRequest ? this.o.onRequest(msg.method, msg.params, this) : undefined))
        .then((result) => {
          if (result === undefined) this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found (probe client)' } });
          else this.send({ jsonrpc: '2.0', id: msg.id, result });
        });
    }
    for (const w of [...this.waiters]) {
      if (w.pred(msg)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  }

  send(frame) {
    this.cap({ dir: 'out', frame });
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.cap({ dir: 'note', text: 'TIMEOUT ' + method, extra: { id, timeoutMs } });
        reject(new Error('timeout: ' + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Resolve on the next inbound frame matching `pred`. */
  waitFor(pred, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error('waitFor timeout'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  async close(graceMs = 4000) {
    try {
      this.child.stdin.end();
    } catch {
      /* already gone */
    }
    const r = await Promise.race([this.exited, new Promise((res) => setTimeout(() => res(null), graceMs))]);
    if (r === null) {
      this.note('did not exit within grace after stdin EOF; killing tree', { pid: this.child.pid });
      killTree(this.child.pid);
      await Promise.race([this.exited, new Promise((res) => setTimeout(res, 3000))]);
    } else {
      this.note('exited on stdin EOF', r);
    }
    // whatever it left behind under its own pid tree
    killTree(this.child.pid);
  }
}

/** Summarise session/update variants seen in a client's frames. */
export function updateKinds(frames) {
  const counts = {};
  for (const f of frames) {
    if (f.method === 'session/update') {
      const k = f.params?.update?.sessionUpdate ?? '(none)';
      counts[k] = (counts[k] || 0) + 1;
    }
  }
  return counts;
}

/** Guard: never leave a child running if the probe itself throws. */
export function installExitGuard(getClients) {
  const bail = (why) => {
    for (const c of getClients()) if (c?.child?.pid) killTree(c.child.pid);
    console.error('probe aborted: ' + why);
    process.exit(1);
  };
  process.on('uncaughtException', (e) => bail(e.stack || String(e)));
  process.on('unhandledRejection', (e) => bail(e?.stack || String(e)));
}
