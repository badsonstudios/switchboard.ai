// #313 — a STREAM session's permission Notification never reaches the status.
//
// The sibling of `stream-hold-guard.test.ts`, and the other half of the same
// ruling. P2-E18-07 stopped a stream session's `PreToolUse` being HELD, so
// there is no second approval bar; it said nothing about the STATUS, and
// `Notification` is the path that reaches it. `state-machine`'s Notification arm
// transitions to `needs-permission` on a regex over the CLI's DEBOUNCED nudge —
// no evidence anything is held, and no way for a pure function to know it is on
// a transport with an exact signal. On stream every real permission arrives as
// `can_use_tool` and is mapped precisely, so a Notification-driven
// `needs-permission` is a duplicate at best and a false alarm at worst: the
// nudge landing after the request was answered drags a working card back to
// "needs permission" with nothing held and no bar to answer it with.
//
// Suppressed at the PRODUCER — this listener already knows the transport — so
// `transition()` stays pure and transport-free. Dropping the event is exactly
// equivalent to not transitioning on it: `apply` does nothing with a hook event
// but run it through `transition`, and a permission blob can only reach the two
// `/permission/i` arms.
//
// UNMEASURED, as at `maybeHold`: nobody has confirmed the real CLI fires
// Notification hooks at all under `--permission-prompt-tool stdio`. Correct
// either way, but a guard, not a finding.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import http from 'http';
import { HookListener } from './hook-listener';
import { LogSink, createLogger } from '../log/logger';
import { cleanupTempDirs, tempDir } from '../../test-temp-dirs';
import { SessionEvent, isPermissionNotification, transition } from '../sessions/state-machine';

let dir: string;
let listener: HookListener;
let port: number;
let applied: Array<{ sessionId: string; ev: SessionEvent }>;
let nativeIds: string[];
let transport: 'pty' | 'stream' | undefined;

beforeEach(async () => {
  dir = tempDir('sb-sng-');
  applied = [];
  nativeIds = [];
  transport = 'pty';
  listener = new HookListener({
    stateDir: dir,
    log: createLogger(new LogSink({ dir }), 'hooks'),
    manager: {
      apply: (sessionId, ev) => applied.push({ sessionId, ev }),
      setNativeSessionId: (_id, nativeId) => nativeIds.push(nativeId),
    },
    transportFor: () => transport,
  });
  port = await listener.start();
});

// Stop, THEN remove: the listener holds its stateDir open. In a `finally` so a
// `beforeEach` that threw before assigning `listener` cannot skip the cleanup
// (#213).
afterEach(() => {
  try {
    listener.stop();
  } finally {
    cleanupTempDirs();
  }
});

/** POST one hook event as `sessionId`, through the real HTTP path. */
function hook(sessionId: string, body: Record<string, unknown>): Promise<void> {
  // registerSession() is the listener's OWN answer for "where is this session's
  // token" — read the API, never scrape buildHookSettings' JSON (the trailing
  // backslash that broke both POSIX legs in stream-hold-guard.test.ts).
  const { tokenPath } = listener.registerSession(sessionId);
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  const json = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/hook',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(json),
          'x-switchboard-token': token,
          host: `127.0.0.1:${port}`,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve());
      }
    );
    req.on('error', reject);
    req.end(json);
  });
}

const PERMISSION = {
  hook_event_name: 'Notification',
  notification_type: 'permission_prompt',
  message: 'Claude needs your permission to use Write',
};

/** the hook events the manager was told about */
const events = (): string[] =>
  applied.map((a) => (a.ev.kind === 'hook' ? a.ev.event : a.ev.kind));

describe('a permission Notification is dropped on a stream session (#313)', () => {
  it('the identical event on a PTY session IS applied — the control case', async () => {
    transport = 'pty';

    await hook('s-pty', PERMISSION);

    expect(applied).toHaveLength(1);
    expect(applied[0].ev).toMatchObject({ kind: 'hook', event: 'Notification' });
    // and it really would have moved the badge — otherwise the stream case
    // below proves only that this payload was always inert
    expect(transition('working', applied[0].ev).status).toBe('needs-permission');
  });

  it('on a STREAM session it never reaches the manager', async () => {
    transport = 'stream';

    await hook('s-stream', PERMISSION);

    expect(applied).toEqual([]);
  });

  // Only the permission classification, and this is the narrowest claim in the
  // file: a guard that dropped Notifications wholesale would silence the CLI's
  // idle nag and its "waiting for you" prompt on every Direct session — signals
  // that have no `can_use_tool` equivalent and are therefore the ONLY thing the
  // hook channel is still good for in stream mode.
  it('a non-permission Notification on the same session still gets through', async () => {
    transport = 'stream';

    await hook('s-stream', {
      hook_event_name: 'Notification',
      notification_type: 'idle',
      message: 'Claude is waiting for your input',
    });

    expect(applied).toHaveLength(1);
    expect(transition('working', applied[0].ev).status).toBe('idle');
  });

  it('every other hook event on a stream session is untouched', async () => {
    transport = 'stream';

    for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SubagentStop', 'Stop']) {
      await hook('s-stream', { hook_event_name: event });
    }

    expect(events()).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PostToolUse',
      'SubagentStop',
      'Stop',
    ]);
  });

  // The classification is on the BLOB, notification type plus message, because
  // the CLI's debounced nudge labels every on-screen dialog `permission_prompt`
  // and the specifics live in the message (probed — see `state-machine`).
  it('the message alone is enough to classify it', async () => {
    transport = 'stream';

    await hook('s-stream', {
      hook_event_name: 'Notification',
      notification_type: 'generic',
      message: 'Claude needs your permission to run npm test',
    });

    expect(applied).toEqual([]);
  });

  // Absent = PTY, so every pre-E18 caller (hook-check, the unit suites, the app
  // before the epic) behaves exactly as it always did.
  it('an absent transport behaves as PTY', async () => {
    transport = undefined;

    await hook('s-legacy', PERMISSION);

    expect(applied).toHaveLength(1);
  });

  // The suppression is of the STATUS and of nothing else. `session_id` is
  // applied above the guard on purpose: a dropped Notification must not also
  // cost us the conversation id it happened to be carrying, which is what binds
  // the transcript to the card.
  it('the native session id is still learned from a dropped Notification', async () => {
    transport = 'stream';

    await hook('s-stream', { ...PERMISSION, session_id: 'native-42' });

    expect(nativeIds).toEqual(['native-42']);
    expect(applied).toEqual([]);
  });
});

// The classifier itself, lifted out of `state-machine` so the listener and the
// state machine cannot answer the same question differently.
describe('isPermissionNotification (#313)', () => {
  const notification = (notificationType?: string, message?: string): SessionEvent => ({
    kind: 'hook',
    event: 'Notification',
    notificationType,
    message,
  });

  it('matches on the type, on the message, and case-insensitively', () => {
    expect(isPermissionNotification(notification('permission_prompt', ''))).toBe(true);
    expect(isPermissionNotification(notification('generic', 'needs your Permission'))).toBe(true);
  });

  it('is false for an idle nag and for an empty notification', () => {
    expect(isPermissionNotification(notification('idle', 'waiting for your input'))).toBe(false);
    expect(isPermissionNotification(notification())).toBe(false);
  });

  // The caller should not have to check the event name first, and no other hook
  // event carries this signal — a PreToolUse for a tool called `permissions.sh`
  // must not read as one.
  it('is false for anything that is not a Notification', () => {
    expect(
      isPermissionNotification({ kind: 'hook', event: 'PreToolUse', message: 'permission' })
    ).toBe(false);
    expect(isPermissionNotification({ kind: 'permission-held' })).toBe(false);
  });
});
