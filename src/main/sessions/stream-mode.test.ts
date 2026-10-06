// #1072 — the mode chip has to follow the CLI when the CLI changes mode itself.
//
// Approve a plan and Claude Code leaves plan mode and says so, in a `system` /
// `status` message. Nothing read it, so the chip went on saying "plan" for a
// session that had started asking about each write.
import { describe, expect, it, vi } from 'vitest';
import { autonomyFromPermissionMode, StreamMode } from './stream-mode';
import { AUTONOMY_MODES } from '../../shared/sessions';
import { AUTONOMY_PERMISSION_MODE } from '../providers/claude';

/** the message, as #588's probe recorded it 7 ms after the Allow */
const leftPlanMode = {
  type: 'system',
  subtype: 'status',
  session_id: 'native-1',
  permissionMode: 'default',
};

describe('#1072 — what the CLI calls each mode', () => {
  it('reads every mode we can START a session at back to the same profile', () => {
    // the two directions are one table; this is what holds them together
    for (const mode of AUTONOMY_MODES) {
      expect(autonomyFromPermissionMode(AUTONOMY_PERMISSION_MODE[mode])).toBe(mode);
    }
  });

  it('reads the CLI`s `default` as ask — the case in the report', () => {
    expect(autonomyFromPermissionMode('default')).toBe('ask');
  });

  it('has no name for a mode we do not offer, and does not pick a near one', () => {
    for (const v of ['auto', 'dontAsk', '', 'PLAN', 7, null, undefined, {}]) {
      expect(autonomyFromPermissionMode(v)).toBeNull();
    }
  });
});

describe('#1072 — following the session`s own announcements', () => {
  it('knows nothing until the CLI has said something', () => {
    expect(new StreamMode().modeFor('s1')).toBeNull();
  });

  it('records the mode the CLI announces, and tells whoever is listening', () => {
    const store = new StreamMode();
    const heard = vi.fn();
    store.onChange(heard);
    store.offer('s1', leftPlanMode);
    expect(store.modeFor('s1')).toBe('ask');
    expect(heard).toHaveBeenCalledExactlyOnceWith('s1', 'ask');
  });

  it('says it once per change, not once per status message', () => {
    const store = new StreamMode();
    const heard = vi.fn();
    store.onChange(heard);
    store.offer('s1', leftPlanMode);
    store.offer('s1', leftPlanMode);
    expect(heard).toHaveBeenCalledTimes(1);
    store.offer('s1', { ...leftPlanMode, permissionMode: 'plan' });
    expect(heard).toHaveBeenLastCalledWith('s1', 'plan');
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('keeps sessions apart', () => {
    const store = new StreamMode();
    store.offer('s1', leftPlanMode);
    expect(store.modeFor('s2')).toBeNull();
  });

  it('ignores a status message that carries no mode — most of them', () => {
    const store = new StreamMode();
    store.offer('s1', leftPlanMode);
    store.offer('s1', { type: 'system', subtype: 'status', status: 'compacting' });
    expect(store.modeFor('s1')).toBe('ask');
  });

  it('keeps what it had when the CLI names a mode we have no word for', () => {
    const store = new StreamMode();
    const heard = vi.fn();
    store.offer('s1', leftPlanMode);
    store.onChange(heard);
    store.offer('s1', { ...leftPlanMode, permissionMode: 'dontAsk' });
    expect(store.modeFor('s1')).toBe('ask');
    expect(heard).not.toHaveBeenCalled();
  });

  it('does not take a mode from any other kind of message', () => {
    const store = new StreamMode();
    store.offer('s1', { type: 'system', subtype: 'init', permissionMode: 'default' });
    store.offer('s1', { type: 'assistant', permissionMode: 'default' });
    store.offer('s1', { type: 'result', subtype: 'status', permissionMode: 'default' });
    expect(store.modeFor('s1')).toBeNull();
  });

  it('forgets a session that is gone, so its successor starts with a clean slate', () => {
    const store = new StreamMode();
    store.offer('s1', leftPlanMode);
    store.forgetSession('s1');
    expect(store.modeFor('s1')).toBeNull();
  });

  it('survives a listener that throws, and still tells the others', () => {
    const store = new StreamMode();
    const heard = vi.fn();
    store.onChange(() => {
      throw new Error('boom');
    });
    store.onChange(heard);
    store.offer('s1', leftPlanMode);
    expect(store.modeFor('s1')).toBe('ask');
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
