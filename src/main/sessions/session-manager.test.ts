import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionManager, PtyLike } from './session-manager';
import { transition, SessionStatus } from './state-machine';
import { ContributionRegistry } from '../extensibility/registry';
import { LogSink, createLogger } from '../log/logger';

// ---- fakes ------------------------------------------------------------------
function fakeRegistry(): ContributionRegistry {
  const r = new ContributionRegistry();
  r.register('provider-adapter', {
    manifest: { id: 'fake', displayName: 'Fake', version: '0', capabilities: ['sessions.spawn'] },
    buildSpawn: (o) => ({ command: 'fake-cli', args: o.resumeSessionId ? ['--resume', o.resumeSessionId] : [], env: {} }),
  });
  return r;
}

class FakePtys implements PtyLike {
  spawned: Array<{ id: string; command: string; args: string[] }> = [];
  exitHandlers = new Map<string, (code: number) => void>();
  removed: string[] = [];
  spawn(opts: { id: string; command: string; args: string[] }) {
    this.spawned.push(opts);
    return {
      pid: 1000 + this.spawned.length,
      onExit: (l: (code: number) => void) => {
        this.exitHandlers.set(opts.id, l);
        return () => {};
      },
      kill: () => this.exitHandlers.get(opts.id)?.(0),
    };
  }
  remove(id: string): void {
    this.removed.push(id);
    this.exitHandlers.get(id)?.(0);
  }
}

let dir: string;
let ptys: FakePtys;
let mgr: SessionManager;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sm-'));
  ptys = new FakePtys();
  const sink = new LogSink({ dir });
  mgr = new SessionManager(fakeRegistry(), ptys, createLogger(sink, 'sessions'), dir);
});

const identity = { title: 't', folder: 'C:/tmp/x', providerId: 'fake' };

// ---- the REAL recorded work cycle from the S-06 spike run -------------------
// spike/findings/artifacts/s06/transitions.json: SessionStart ->
// UserPromptSubmit -> Notification(permission_prompt) -> Stop
const S06_REAL_CYCLE = [
  { ev: { kind: 'hook', event: 'SessionStart' } as const, expect: 'starting' },
  { ev: { kind: 'hook', event: 'UserPromptSubmit' } as const, expect: 'working' },
  {
    ev: { kind: 'hook', event: 'Notification', notificationType: 'permission_prompt', message: 'Claude needs your permission' } as const,
    expect: 'needs-permission',
  },
  { ev: { kind: 'hook', event: 'Stop' } as const, expect: 'done' },
];

describe('state machine vs the recorded real cycle (S-06 artifact)', () => {
  it('replays the spike transitions exactly', () => {
    let status: SessionStatus = 'starting';
    for (const step of S06_REAL_CYCLE) {
      status = transition(status, step.ev).status;
      expect(status).toBe(step.expect);
    }
  });

  it('SubagentStop is transient; unknown hooks never transition', () => {
    expect(transition('working', { kind: 'hook', event: 'SubagentStop' })).toMatchObject({
      changed: false,
      note: 'subagent-done',
    });
    expect(transition('working', { kind: 'hook', event: 'FutureThing' })).toMatchObject({
      changed: false,
      note: 'unknown-hook:FutureThing',
    });
  });

  it('exit codes: 0 -> done, nonzero -> crashed, after done -> done', () => {
    expect(transition('working', { kind: 'exit', code: 1 }).status).toBe('crashed');
    expect(transition('working', { kind: 'exit', code: 0 }).status).toBe('done');
    expect(transition('done', { kind: 'exit', code: -1073741510 }).status).toBe('done');
  });

  it('permission hold/resolve (the E2-05+ authority path)', () => {
    expect(transition('working', { kind: 'permission-held' }).status).toBe('needs-permission');
    expect(transition('needs-permission', { kind: 'permission-resolved' }).status).toBe('working');
  });

  it('done is turn-terminal: idle notifications and keystrokes never revive it', () => {
    // the real ClaudeMon bug: done -> needs-input -> working via a stray key
    expect(
      transition('done', { kind: 'hook', event: 'Notification', message: 'Claude is waiting' })
    ).toMatchObject({ status: 'done', changed: false });
    expect(transition('done', { kind: 'user-input' })).toMatchObject({ status: 'done', changed: false });
    expect(transition('done', { kind: 'hook', event: 'SubagentStop' })).toMatchObject({ status: 'done' });
    expect(transition('done', { kind: 'hook', event: 'PostToolUse' })).toMatchObject({ status: 'done' });
    // ...but a genuinely new turn (UserPromptSubmit) does leave done
    expect(transition('done', { kind: 'hook', event: 'UserPromptSubmit' }).status).toBe('working');
  });

  it('a keystroke never forces working (it is not a submitted prompt)', () => {
    expect(transition('needs-input', { kind: 'user-input' })).toMatchObject({ status: 'needs-input', changed: false });
    expect(transition('working', { kind: 'user-input' })).toMatchObject({ status: 'working', changed: false });
  });
});

describe('SessionManager (done-when: observable transitions through the cycle)', () => {
  it('create -> real cycle -> transitions logged and queryable', () => {
    const seen: string[] = [];
    mgr.onStatusChange((c) => seen.push(`${c.from}->${c.to}`));
    const s = mgr.create(identity);
    for (const step of S06_REAL_CYCLE) mgr.apply(s.id, step.ev);

    expect(mgr.get(s.id)!.status).toBe('done');
    const t = mgr.transitions(s.id);
    expect(t.map((x) => x.to)).toEqual(['working', 'needs-permission', 'done']);
    expect(t.every((x) => x.sessionId === s.id)).toBe(true);
    expect(seen).toEqual(['starting->working', 'working->needs-permission', 'needs-permission->done']);
    // and the log file carries it, sessionId-filterable (E1-05 contract)
    const lines = fs
      .readFileSync(path.join(dir, 'switchboard.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.sessionId === s.id && r.msg === 'session status');
    expect(lines.map((r) => r.to)).toEqual(['working', 'needs-permission', 'done']);
  });

  it('kill flips to done via exit(0); crash via nonzero', () => {
    const a = mgr.create(identity);
    mgr.kill(a.id);
    expect(mgr.get(a.id)!.status).toBe('done');

    const b = mgr.create(identity);
    ptys.exitHandlers.get(b.id)!(1);
    expect(mgr.get(b.id)!.status).toBe('crashed');
  });

  it('restart preserves identity and passes the native id as resume', () => {
    const a = mgr.create(identity);
    mgr.setNativeSessionId(a.id, 'native-9');
    const b = mgr.restart(a.id);
    expect(b.id).not.toBe(a.id);
    expect(b.identity).toEqual(identity);
    const spawn = ptys.spawned.at(-1)!;
    expect(spawn.args).toEqual(['--resume', 'native-9']);
    expect(mgr.get(a.id)).toBeUndefined();
  });

  it('late events for removed sessions are dropped silently', () => {
    expect(() => mgr.apply('ghost', { kind: 'hook', event: 'Stop' })).not.toThrow();
  });

  it('onSessionExit fires: kill = not crashed, nonzero-without-kill = crashed', () => {
    const exits: Array<{ crashed: boolean; code: number }> = [];
    mgr.onSessionExit((e) => exits.push({ crashed: e.crashed, code: e.code }));

    const a = mgr.create(identity);
    mgr.kill(a.id); // FakePtys.kill -> exit(0)
    expect(exits.at(-1)).toEqual({ crashed: false, code: 0 });

    const b = mgr.create(identity);
    ptys.exitHandlers.get(b.id)!(1); // spontaneous nonzero exit = a crash
    expect(exits.at(-1)).toEqual({ crashed: true, code: 1 });
  });

  it('remove drops the record so it leaves the list (card closed)', () => {
    const a = mgr.create(identity);
    expect(mgr.get(a.id)).toBeDefined();
    mgr.remove(a.id);
    expect(mgr.get(a.id)).toBeUndefined();
    expect(mgr.list().find((s) => s.id === a.id)).toBeUndefined();
  });
});
