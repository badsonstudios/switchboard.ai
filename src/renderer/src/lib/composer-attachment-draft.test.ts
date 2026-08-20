// The kept attachments, and the line the decision draws through them (#546).
//
// The seam this pins is a SPLIT one, and both halves have to be checked
// separately or the feature is a lie in one direction or the other:
//
//   * the BYTES are in memory and survive a remount — a test that only checked
//     the blob would pass with the chips never coming back;
//   * the BYTES ARE NOT IN THE BLOB — a test that only checked "the chips come
//     back" would pass with the base64 written straight to disk, which is
//     precisely the thing this item decided against.
//
// So there is an assertion here whose whole job is to fail if a future change
// starts persisting payloads: `nothing that reaches main carries the bytes`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  attachmentDraftKey,
  loadStashedAttachments,
  lostAttachmentNames,
  pruneAttachmentDrafts,
  resetAttachmentDrafts,
  stashAttachments,
  staleAttachmentDraftKeys,
  MAX_RETAINED_PAYLOAD_CHARS,
} from './composer-attachment-draft';
import type { Attachment } from './composer-attachments';
import { loadUiState, uiFlush, uiGet, UI_PUSH_DELAY_MS } from './ui-state';

let sent: Array<Record<string, unknown>>;

/** the preload bridge, and nothing else */
function bridge(initial: Record<string, unknown> = {}): void {
  sent = [];
  vi.stubGlobal('window', {
    switchboard: {
      workspace: {
        getUi: () => Promise.resolve(initial),
        setUi: (ui: unknown) => sent.push({ ...(ui as Record<string, unknown>) }),
      },
    },
  });
}

/** what main has actually been told, last write wins */
const persisted = (key: string): unknown =>
  sent.length === 0 ? undefined : sent[sent.length - 1][key];

const image = (name: string, data = 'AAAA'): Attachment => ({
  id: `att-${name}`,
  name,
  kind: 'image',
  mediaType: 'image/png',
  bytes: 3,
  data,
});

const text = (name: string, body = 'hello'): Attachment => ({
  id: `att-${name}`,
  name,
  kind: 'text',
  mediaType: 'text/plain',
  bytes: body.length,
  text: body,
});

beforeEach(async () => {
  vi.useFakeTimers();
  resetAttachmentDrafts();
  bridge();
  await loadUiState();
});

afterEach(() => {
  uiFlush();
  resetAttachmentDrafts();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('stashAttachments', () => {
  it('hands the chips back IMMEDIATELY — this is what survives a remount', () => {
    const shot = image('pasted-1.png', 'PNGPNGPNG==');
    stashAttachments('card-1', [shot]);
    // no timer has run and nothing has been pushed...
    expect(sent).toHaveLength(0);
    // ...and a composer that mounts on the very next tick has its picture back
    expect(loadStashedAttachments('card-1')).toEqual([shot]);
  });

  it('NEVER puts the payload where it could reach disk — the decision, pinned', () => {
    stashAttachments('card-1', [image('shot.png', 'SECRETBYTES='), text('notes.md', 'my notes')]);
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(sent).toHaveLength(1);
    // names, and only names
    expect(persisted(attachmentDraftKey('card-1'))).toEqual(['shot.png', 'notes.md']);
    // and nothing anywhere in what main was told carries the bytes. If this
    // ever fails, someone has started persisting attachment payloads and the
    // manual's "no copy is left on disk" is no longer true.
    const wire = JSON.stringify(sent);
    expect(wire).not.toContain('SECRETBYTES=');
    expect(wire).not.toContain('my notes');
  });

  it('is per card — one card’s screenshot never lands on another', () => {
    stashAttachments('card-1', [image('one.png')]);
    stashAttachments('card-2', [image('two.png')]);
    expect(loadStashedAttachments('card-1').map((a) => a.name)).toEqual(['one.png']);
    expect(loadStashedAttachments('card-2').map((a) => a.name)).toEqual(['two.png']);
  });

  it('does nothing at all for a card with no id', () => {
    stashAttachments(undefined, [image('nowhere.png')]);
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(sent).toHaveLength(0);
    expect(loadStashedAttachments(undefined)).toEqual([]);
  });

  it('an EMPTY strip forgets both halves, and the blob half goes at once', () => {
    stashAttachments('card-1', [image('one.png')]);
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(persisted(attachmentDraftKey('card-1'))).toEqual(['one.png']);

    stashAttachments('card-1', []);
    // IMMEDIATELY, not on the debounce: a send that cleared the chips but left
    // their names on a 400ms fuse could be quit inside that window, and the
    // next launch would announce the loss of something that was sent.
    expect(sent).toHaveLength(2);
    expect(persisted(attachmentDraftKey('card-1'))).toBeUndefined();
    expect(loadStashedAttachments('card-1')).toEqual([]);
  });

  it('an empty strip on a card that never had one costs no push', () => {
    // the mount case for the overwhelming majority of composers: the effect
    // fires once with `[]` and must not send the whole blob for it
    stashAttachments('card-fresh', []);
    expect(sent).toHaveLength(0);
  });

  it('re-stashing the same array is a no-op', () => {
    const same = [image('one.png')];
    stashAttachments('card-1', same);
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    const before = sent.length;
    // what a remount does: read the store, then stash what it read
    stashAttachments('card-1', loadStashedAttachments('card-1'));
    vi.advanceTimersByTime(UI_PUSH_DELAY_MS);
    expect(sent).toHaveLength(before);
  });

  it('evicts the least-recently-stashed card when the retention ceiling is crossed', () => {
    const big = (n: string): Attachment =>
      image(n, 'x'.repeat(Math.ceil(MAX_RETAINED_PAYLOAD_CHARS * 0.6)));
    stashAttachments('old', [big('old.png')]);
    stashAttachments('new', [big('new.png')]);
    // the card being stashed is always admitted; the idle one goes
    expect(loadStashedAttachments('new')).toHaveLength(1);
    expect(loadStashedAttachments('old')).toEqual([]);
    // ...and its NAMES stay, so the loss is announced rather than silent
    expect(lostAttachmentNames('old')).toEqual(['old.png']);
  });
});

describe('lostAttachmentNames', () => {
  it('names a previous run’s chips — the relaunch case', async () => {
    bridge({ [attachmentDraftKey('card-7')]: ['diagram.png', 'server.log'], railHidden: true });
    await loadUiState();
    expect(lostAttachmentNames('card-7')).toEqual(['diagram.png', 'server.log']);
    expect(uiGet('railHidden', false)).toBe(true);
  });

  it('says nothing while the bytes are still here', () => {
    stashAttachments('card-1', [image('one.png')]);
    expect(lostAttachmentNames('card-1')).toEqual([]);
  });

  it('is PURE — reading it twice gives the same answer', async () => {
    // it is called from a `useState` initializer, which StrictMode runs twice
    bridge({ [attachmentDraftKey('card-7')]: ['a.png'] });
    await loadUiState();
    expect(lostAttachmentNames('card-7')).toEqual(['a.png']);
    expect(lostAttachmentNames('card-7')).toEqual(['a.png']);
  });

  it('shrugs off a value that is not a list of names', async () => {
    bridge({ [attachmentDraftKey('a')]: 'nope', [attachmentDraftKey('b')]: [1, null, 'ok.png'] });
    await loadUiState();
    expect(lostAttachmentNames('a')).toEqual([]);
    expect(lostAttachmentNames('b')).toEqual(['ok.png']);
  });

  it('has nothing to say about a card with no id', () => {
    expect(lostAttachmentNames(undefined)).toEqual([]);
  });
});

describe('the sweep', () => {
  const blob = {
    [attachmentDraftKey('gone')]: ['ghost.png'],
    [attachmentDraftKey('alive')]: ['still-here.png'],
    railHidden: true,
  };

  it('finds the keys whose card is gone, and only those', () => {
    expect(staleAttachmentDraftKeys(blob, new Set(['alive']))).toEqual([attachmentDraftKey('gone')]);
  });

  it('an EMPTY known-set deletes nothing — a failed card list is not an empty one', () => {
    expect(staleAttachmentDraftKeys(blob, new Set())).toEqual([]);
  });

  it('pruneAttachmentDrafts drops the names AND the bytes behind them', async () => {
    bridge(blob);
    await loadUiState();
    stashAttachments('gone', [image('ghost.png')]);
    stashAttachments('alive', [image('still-here.png')]);

    pruneAttachmentDrafts(new Set(['alive']));

    expect(loadStashedAttachments('gone')).toEqual([]);
    expect(lostAttachmentNames('gone')).toEqual([]);
    expect(loadStashedAttachments('alive')).toHaveLength(1);
    expect(persisted('railHidden')).toBe(true);
  });

  it('keeps everything when the known-set is empty, memory included', async () => {
    bridge(blob);
    await loadUiState();
    stashAttachments('gone', [image('ghost.png')]);
    pruneAttachmentDrafts(new Set());
    expect(loadStashedAttachments('gone')).toHaveLength(1);
  });
});
