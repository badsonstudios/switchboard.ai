import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { IPC_REFUSAL_BRAND, ipcRefusal, isIpcRefusal, IpcRefusal, took, answered } from './refusal';

// The refusal contract (issue 346). The broker's refusal path is UNREACHABLE
// today — our one renderer is granted every capability — so there is no
// behaviour to observe and these tests are the deliverable: they are what pins
// the contract until the Phase-4 caller that can reach it exists.

describe('the refusal value itself', () => {
  it('is branded, names the channel, and carries a reason', () => {
    const r = ipcRefusal('sessions:create', 'capability-not-held');
    expect(isIpcRefusal(r)).toBe(true);
    expect(r.channel).toBe('sessions:create');
    expect(r.reason).toBe('capability-not-held');
  });

  it('survives structured clone — the boundary it exists to cross', () => {
    // Everything over IPC is structured-cloned. This is why the refusal is a
    // plain object and not a class or an Error: a prototype does not make the
    // trip, so an `instanceof` check on the far side is always false and an
    // Error arrives as a mangled string.
    const clone = structuredClone(ipcRefusal('groups:update', 'not-granted'));
    expect(isIpcRefusal(clone)).toBe(true);
    expect(clone).toEqual({ [IPC_REFUSAL_BRAND]: true, channel: 'groups:update', reason: 'not-granted' });
  });

  it('is JSON — no functions, no prototype tricks, nothing lazy', () => {
    const r = ipcRefusal('pty:input', 'unknown-channel');
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  });
});

describe('isIpcRefusal does not mistake a HANDLER answer for a refusal', () => {
  // Every one of these is a real return value from a shipped handler, or a
  // near-miss worth pinning. The middle one is the reason the refusal is not
  // `{ok:false, reason}`: `sessions:setTransport` already answers exactly that
  // for an unknown card, so that shape was TAKEN before this item started.
  const notRefusals: Array<[string, unknown]> = [
    ['null (groups:update, pty:attach, sessions:create)', null],
    ['undefined (a void handler)', undefined],
    ['false (submitPrompt / interrupt / decidePermission)', false],
    ['true', true],
    ["{ok:false, reason} (sessions:setTransport's OWN answer)", { ok: false, reason: 'unknown-card' }],
    ['{ok:true} (setTransport, accepted)', { ok: true }],
    ['an empty list (sessions:cards on a fresh workspace)', []],
    ['a group record', { id: 'g1', name: 'Work', color: '#4a90d9' }],
    ['the empty string', ''],
    ['zero', 0],
    ['the old throw, as a string', 'refused: sessions:create'],
    ['an object with the brand set FALSE', { [IPC_REFUSAL_BRAND]: false }],
    ['an object with the brand set to a truthy non-true', { [IPC_REFUSAL_BRAND]: 1 }],
    ['a null-prototype object', Object.create(null)],
  ];

  for (const [what, value] of notRefusals) {
    it(`says no to ${what}`, () => {
      expect(isIpcRefusal(value)).toBe(false);
    });
  }

  it('narrows the type, so a checked value is usable without a cast', () => {
    const answer: unknown = ipcRefusal('git:status', 'capability-not-held');
    if (!isIpcRefusal(answer)) throw new Error('unreachable');
    const narrowed: IpcRefusal = answer;
    expect(narrowed.reason).toBe('capability-not-held');
  });
});

// #440 — the readers. Same deliverable-is-the-test situation as above: the
// refusal path is unreachable while the renderer holds every capability, so
// these ARE the proof that a refusal reads as "no" rather than as "yes". Built
// with the real `ipcRefusal()` factory, never a hand-written literal, so a
// change to the shape reaches them (the pattern #439 established).

describe('took — did main actually do it', () => {
  it('says yes to true, and to nothing else', () => {
    expect(took(true)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['a REFUSAL — the whole reason this exists', ipcRefusal('fs:openExternal', 'capability-not-held')],
    ['false, the handler declining', false],
    ['undefined, a bridge with no such method', undefined],
    ['null', null],
    ['a truthy string', 'true'],
    ['a truthy number', 1],
    ['a truthy object', {}],
    ['a non-empty array', ['ok']],
  ])('says no to %s', (_what, value) => {
    expect(took(value)).toBe(false);
  });

  it('collapses all three ways of not getting a yes into one answer', () => {
    // The point of the helper: a call site that writes `if (took(x))` cannot
    // accidentally treat "refused" as different from "declined" — and a call
    // site that NEEDS the difference is told to compare explicitly instead.
    const answers = [false, undefined, ipcRefusal('sessions:interrupt', 'not-granted')];
    expect(answers.map(took)).toEqual([false, false, false]);
  });
});

describe('answered — the handler answer, or nothing', () => {
  it('passes a real answer through untouched, identity included', () => {
    const record = { id: 's1', identity: { accentColor: '#4a90d9' } };
    expect(answered(record)).toBe(record);
  });

  it.each<[string, unknown]>([
    ['a folder path', '/home/dan/project'],
    ['an empty list', []],
    ['false', false],
    ['zero', 0],
    ['the empty string', ''],
  ])('passes %s through — it is an ANSWER, not an absence', (_what, value) => {
    expect(answered(value)).toEqual(value);
  });

  it('turns a refusal into undefined, so every existing falsy guard fires', () => {
    expect(answered(ipcRefusal('sessions:pickFolder', 'capability-not-held'))).toBeUndefined();
  });

  it('keeps null distinct from a refusal — null is a real answer', () => {
    // `groups:update`, `sessions:create` and `sounds:get` all answer null for
    // ordinary reasons (#346's first argument). Folding a refusal into null
    // would throw away exactly what the brand was invented to preserve.
    expect(answered(null)).toBeNull();
    expect(answered(ipcRefusal('sounds:get', 'capability-not-held'))).toBeUndefined();
  });

  it('makes the `?? fallback` shape do the right thing on a refusal', () => {
    // The three sites that wore this shape (App.tsx's history repairs, the
    // card's two sound reads) were the quiet ones: `??` never fires on an
    // object, so the brand went into React state as the answer.
    const refused = ipcRefusal('sessions:historyRepairs', 'capability-not-held');
    expect(refused ?? []).toBe(refused); // what the code used to do
    expect(answered(refused) ?? []).toEqual([]); // what it does now
  });

  it('survives the round trip a refusal actually makes', () => {
    // Structured clone, not the literal: this is the value as it arrives.
    const overTheWire = structuredClone(ipcRefusal('workspace:getUi', 'not-granted'));
    expect(answered(overTheWire)).toBeUndefined();
    expect(took(overTheWire)).toBe(false);
  });
});

describe('the brand is unique in the tree', () => {
  it('appears in no production source file except the contract itself', () => {
    // The whole shape rests on "no handler returns this". That is true today
    // by inspection, and this is what keeps it true: if someone puts the brand
    // in a payload, a refusal and an answer become confusable again and this
    // goes red. Same spirit as the broker's stale-tag test, which reads source
    // rather than trusting a comment.
    //
    // Tests are excluded because `broker.test.ts` asserts on the brand as a
    // LITERAL on purpose — that is what stops a rename of this constant from
    // quietly changing the shape on the wire.
    const root = path.join(process.cwd(), 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        if (fs.readFileSync(full, 'utf8').includes(IPC_REFUSAL_BRAND)) {
          offenders.push(path.relative(root, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(root);
    expect(offenders.sort()).toEqual(['shared/ipc/refusal.ts']);
  });
});
