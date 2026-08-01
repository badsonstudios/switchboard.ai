// P2-E18-04 done-when check: the COMPILED fake CLI really speaks stream-json
// over real pipes, driven through the real StreamService and the real adapter
// recipe. Exits 0 on PASS, 1 on FAIL.
//
// The protocol itself is unit-tested in `fake-stream-protocol.test.ts` without
// spawning, because the CI unit job does not run a build. This check covers
// what those cannot: the spawn recipe, the ELECTRON_RUN_AS_NODE delta surviving
// the S-01 scrub, NDJSON over an actual pipe, and the control-channel round
// trip end to end.
//
// Run with: npm run check:fake-stream   (after npm run build)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StreamService, StreamMessage } from '../transport/stream-service';
import { fakeStreamAdapter } from './fake-stream';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fake-stream-check-'));
const service = new StreamService();
const seen: StreamMessage[] = [];
const failures: string[] = [];

function check(label: string, ok: boolean): void {
  if (!ok) failures.push(label);
  console.log(`[fake-stream-check] ${ok ? 'ok  ' : 'FAIL'} ${label}`);
}

const tag = (m: StreamMessage): string => `${m.type}${m.subtype ? ':' + String(m.subtype) : ''}`;

function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (pred()) return res();
      if (Date.now() - t0 > ms) return rej(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function userMsg(text: string): Record<string, unknown> {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: '',
  };
}

async function main(): Promise<number> {
  // the REAL recipe, not a hand-built one — this is what the session manager
  // would hand the transport
  const recipe = fakeStreamAdapter.buildSpawn({ cwd: work, sessionId: 'check', stateDir: work });
  check('adapter declares the stream transport', recipe.transport === 'stream');

  const s = service.spawn({
    id: 'check',
    command: recipe.command,
    args: recipe.args,
    cwd: work,
    env: recipe.env,
    onDiagnostic: (d) => console.log(`[fake-stream-check] diag ${d.kind}: ${d.detail}`),
  });
  s.onMessage((m) => seen.push(m));

  // ---- turn 1: a plain prompt ------------------------------------------------
  s.send(userMsg('hello'));
  await waitFor(() => seen.some((m) => m.type === 'result'), 15_000, 'the first result');

  check('system:init arrived', seen.some((m) => tag(m) === 'system:init'));
  check('token deltas arrived', seen.filter((m) => m.type === 'stream_event').length > 0);
  const assistant = seen.find((m) => m.type === 'assistant') as
    | { message: { content: Array<{ text: string }> } }
    | undefined;
  check('assistant text is the echo', assistant?.message.content[0].text === 'FAKE-REPLY: hello');
  check('result:success arrived', seen.some((m) => tag(m) === 'result:success'));
  check('framing is intact', s.health.parseFailures === 0);

  // ---- turn 2: the permission round trip -------------------------------------
  seen.length = 0;
  const target = path.join(work, '.claude', 'scripts', 'coverage.sh');
  s.send(userMsg('!perm .claude/scripts/coverage.sh'));
  await waitFor(() => seen.some((m) => m.type === 'control_request'), 15_000, 'a control_request');

  const req = seen.find((m) => m.type === 'control_request') as {
    request_id: string;
    request: Record<string, unknown>;
  };
  check('control_request is can_use_tool', req.request.subtype === 'can_use_tool');
  check('it carries decision_reason_type', req.request.decision_reason_type === 'safetyCheck');
  check('it carries permission_suggestions', Array.isArray(req.request.permission_suggestions));
  check('the turn has NOT completed yet', !seen.some((m) => m.type === 'result'));

  // answer it exactly as P2-E18-07 will
  s.send({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: req.request_id,
      response: { behavior: 'allow', updatedInput: req.request.input },
    },
  });
  await waitFor(() => seen.some((m) => m.type === 'result'), 15_000, 'the turn to finish');

  check('the file was actually written', fs.existsSync(target));
  check('the whole exchange parsed cleanly', s.health.parseFailures === 0);

  // ---- the S-11 surprise, reproduced ----------------------------------------
  check(
    'system:init is emitted ONCE PER TURN (S-11)',
    seen.filter((m) => tag(m) === 'system:init').length === 1
  );

  // ---- exit ------------------------------------------------------------------
  let exited = false;
  s.onExit(() => (exited = true));
  s.send(userMsg('!exit 0'));
  await waitFor(() => exited, 10_000, 'the child to exit');
  check('the child exits on command', exited);

  service.killAll();
  fs.rmSync(work, { recursive: true, force: true });

  const ok = failures.length === 0;
  console.log(ok ? '[fake-stream-check] PASS' : `[fake-stream-check] FAIL: ${failures.join(', ')}`);
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[fake-stream-check] ERROR', err);
    service.killAll();
    process.exit(1);
  }
);
