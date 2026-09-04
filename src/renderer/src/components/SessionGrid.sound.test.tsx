// @vitest-environment jsdom
// The card's sound entry (P2-E14-05a, §5.9 + §5.11).
//
// Three things here can rot silently and all three lie to the user: the entry
// showing a cue the store never agreed to, the preview playing a DIFFERENT
// sound from the one it just pinned, and — the one #444 already paid for once —
// a bridge without the `sounds` namespace throwing out of a mount effect and
// taking the whole card down. None of them is visible in a screenshot.
//
// The dockview wall is climbed exactly as `SessionGrid.transport.test.tsx`
// does; see its header for why the stub is the honest way in.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { initI18nForTests } from '../i18n/test-i18n';
import en from '../../../shared/i18n/locales/en.json';
import { sessionStore } from '../store/session-store';
import { registerBuiltinContributions } from '../bootstrap';
import { rendererRegistry } from '../extensibility/registry-instance';
import { setSharedAnnouncer } from '../lib/announcer';
import type { CardSound } from '../../../shared/sounds';
import type { IDockviewPanelProps } from 'dockview-react';
import { SessionGrid, type CardParams } from './SessionGrid';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let components: Record<string, React.ComponentType<IDockviewPanelProps<CardParams>>> = {};

vi.mock('dockview-react', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    DockviewReact: (props: {
      components: Record<string, React.ComponentType<IDockviewPanelProps<CardParams>>>;
    }): null => {
      components = props.components;
      return null;
    },
  };
});

vi.mock('./TerminalPane', () => ({
  TerminalPane: (): React.JSX.Element => <div data-testid="terminal-pane" />,
}));
vi.mock('./FeedView', () => ({
  FeedView: (): React.JSX.Element => <div data-testid="feed-view" />,
}));

const off = (): void => {};
const disposable = { dispose: off };

interface SoundCalls {
  get: string[];
  set: Array<[string, string | null]>;
}
let soundCalls: SoundCalls;
/** what `sounds.get` answers; `null` stands for a refusal */
let currentSound: CardSound | null;
/** what `sounds.set` answers — the store's truth, which may differ */
let setReply: CardSound | null;
let setThrows = false;
/** cues the preview actually played */
let previewed: string[];

/** `withSounds: false` is the #444 case — a bridge missing the namespace. */
function installBridge(withSounds = true): void {
  soundCalls = { get: [], set: [] };
  const sounds = {
    get: (cardId: string) => {
      soundCalls.get.push(cardId);
      return Promise.resolve(currentSound);
    },
    set: (cardId: string, sound: string | null) => {
      soundCalls.set.push([cardId, sound]);
      if (setThrows) return Promise.reject(new Error('store said no'));
      // the real store un-pins on `null`, and a later `get` has to say so —
      // otherwise the re-read below would keep answering the old truth
      if (sound === null && currentSound) currentSound = { ...currentSound, pinned: false };
      return Promise.resolve(setReply);
    },
    onPlay: () => off,
    onSpeak: () => off,
  };
  (window as unknown as { switchboard: unknown }).switchboard = {
    sessions: {
      create: () =>
        Promise.resolve({
          id: 'live-1',
          identity: { accentColor: 'var(--faint)', langBadge: 'ts' },
          autonomy: 'ask',
          status: 'idle',
          transport: 'pty',
        }),
      setTransport: () => Promise.resolve({ ok: true }),
      dropLive: () => Promise.resolve(),
      setAutonomy: () => Promise.resolve(),
      setTaskLabel: () => Promise.resolve(),
      decidePermission: () => Promise.resolve(),
      allowAllSession: () => Promise.resolve(),
      closeCard: () => Promise.resolve(),
      pendingPermissions: () => Promise.resolve([]),
      onExited: () => off,
      onUsage: () => off,
      // which model the footer shows (#746) — push plus pull-on-mount
      currentModel: () => Promise.resolve(null),
      onModel: () => off,
      onStatus: () => off,
      onPermissionRequest: () => off,
      onPermissionResolved: () => off,
    },
    transcripts: { binding: () => Promise.resolve(null) },
    git: { status: () => Promise.resolve(null) },
    ...(withSounds ? { sounds } : {}),
  };
}

function panelProps(cardId: string): IDockviewPanelProps<CardParams> {
  return {
    api: {
      id: `session-${cardId}`,
      title: 'acme',
      isVisible: true,
      location: { type: 'grid' },
      onDidVisibilityChange: () => disposable,
      onDidLocationChange: () => disposable,
      onDidGroupChange: () => disposable,
      // the card subscribes to this too, for #555's `dockEpoch` — dockview
      // reattaches a panel's DOM when its group is activated, and the feed
      // cannot see that happen to it
      onDidActiveChange: () => disposable,
    },
    containerApi: { getPanel: () => undefined, removePanel: off },
    params: { cardId, folder: 'C:\\Projects\\acme', title: 'acme' },
  } as unknown as IDockviewPanelProps<CardParams>;
}

let root: Root | null = null;
let host: HTMLElement;

function menuButton(): HTMLButtonElement {
  const btn = host.querySelector<HTMLButtonElement>(`button[title="${en.grid.menu}"]`);
  if (!btn) throw new Error('the card has no ⋯ menu');
  return btn;
}

const soundItem = (): HTMLButtonElement | null =>
  host.querySelector<HTMLButtonElement>('[data-testid="card-sound"]');

/** the entry's words, as en.json renders them */
const label = (now: string, next: string): string =>
  en.grid.menuSound.replace('{now}', now).replace('{next}', next);

/** the "nobody has chosen yet" reading of the current cue */
const auto = (name: string): string => en.sounds.autoNow.replace('{name}', name);

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function mountCard(): Promise<void> {
  await act(async () => {
    root!.render(React.createElement(components.sessionCard, panelProps('c1')));
  });
}

const openMenu = (): Promise<void> => click(menuButton());

beforeAll(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await initI18nForTests();
  installBridge();
  registerBuiltinContributions(rendererRegistry);
  const gridHost = document.createElement('div');
  document.body.appendChild(gridHost);
  const gridRoot = createRoot(gridHost);
  await act(async () => {
    gridRoot.render(<SessionGrid colorScheme="dark" seedPanels={0} onCardsChanged={() => {}} />);
  });
  await act(async () => gridRoot.unmount());
  gridHost.remove();
  expect(typeof components.sessionCard).toBe('function');
});

beforeEach(() => {
  installBridge();
  currentSound = { id: 'chime', pinned: false };
  setReply = null;
  setThrows = false;
  previewed = [];
  // No real audio in a unit run — and no real audio in ANY run this test can
  // cause: the shared announcer is the one the card reaches for.
  setSharedAnnouncer({
    play: (id) => {
      previewed.push(id);
      return true;
    },
    say: () => true,
  });
  sessionStore.setSessions([]);
  sessionStore.initPresentation(new Map());
  sessionStore.forgetCardLiveIds('c1');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root!.unmount());
  host.remove();
  root = null;
  setSharedAnnouncer(null);
});

describe('the entry says which cue this card rings', () => {
  it('names the current cue and the one a click lands on', async () => {
    await mountCard();
    await openMenu();
    expect(soundItem()?.textContent).toBe(label(auto(en.sounds.chime), en.sounds.bell));
  });

  it('says which cue an unchosen card will actually ring', async () => {
    // "Automatic" alone answers the wrong question — the user wants to know
    // what they are about to hear
    await mountCard();
    await openMenu();
    expect(soundItem()?.textContent).toContain(en.sounds.chime);
  });

  it('reads the card when the MENU OPENS, not once at mount', async () => {
    // A card mounts before `sessions:create` has persisted it, so a mount-time
    // read asks about a card main does not have yet — and with no other
    // trigger the entry would stay hidden for the life of the card.
    await mountCard();
    expect(soundCalls.get).toEqual([]);
    await openMenu();
    expect(soundCalls.get).toEqual(['c1']);
  });

  it('re-reads every time it is opened, so it cannot go stale', async () => {
    await mountCard();
    await openMenu();
    await openMenu(); // close
    await openMenu();
    expect(soundCalls.get).toEqual(['c1', 'c1']);
  });

  it('states the cue and the ACTION separately, never one word alone', async () => {
    // #153, as a claim: in a menu an entry reads as a command, so "Sound:
    // Chime" alone would look like "switch to Chime"
    await mountCard();
    await openMenu();
    const text = soundItem()!.textContent ?? '';
    expect(text).toContain(en.sounds.chime);
    expect(text).toContain(en.sounds.bell);
  });
});

describe('clicking it', () => {
  it('pins the next cue and PLAYS it, so the choice is audible', async () => {
    setReply = { id: 'bell', pinned: true };
    await mountCard();
    await openMenu();
    await click(soundItem()!);
    expect(soundCalls.set).toEqual([['c1', 'bell']]);
    expect(previewed).toEqual(['bell']);
  });

  it('previews exactly the cue it just wrote — never a different one', async () => {
    setReply = { id: 'bell', pinned: true };
    await mountCard();
    await openMenu();
    await click(soundItem()!);
    expect(previewed).toEqual([soundCalls.set[0][1]]);
  });

  it('walks the bank on repeated clicks', async () => {
    await mountCard();
    await openMenu();
    setReply = { id: 'bell', pinned: true };
    await click(soundItem()!);
    setReply = { id: 'knock', pinned: true };
    await click(soundItem()!);
    expect(soundCalls.set.map(([, s]) => s)).toEqual(['bell', 'knock']);
    expect(previewed).toEqual(['bell', 'knock']);
  });

  it('past the last cue it goes back to automatic, and previews nothing', async () => {
    // the ninth step. "Automatic" is not a sound, so playing the cue it happens
    // to resolve to would say the opposite of what was just chosen.
    currentSound = { id: 'thrum', pinned: true };
    setReply = null; // "back to auto" and "refused" answer the same thing…
    await mountCard();
    await openMenu();
    await click(soundItem()!);
    expect(soundCalls.set).toEqual([['c1', null]]);
    expect(previewed).toEqual([]);
    // …so the menu asks rather than guessing, and shows what it is told
    expect(soundCalls.get.length).toBeGreaterThan(1);
    expect(soundItem()?.textContent).toBe(label(auto(en.sounds.thrum), en.sounds.chime));
  });

  it('repaints to what the STORE answered, not to what was clicked', async () => {
    // a refused or corrected write must leave the menu showing the truth
    setReply = { id: 'thrum', pinned: true };
    await mountCard();
    await openMenu();
    await click(soundItem()!);
    expect(soundItem()?.textContent).toBe(label(en.sounds.thrum, en.sounds.auto));
  });

  it('a rejected write leaves the optimistic value rather than throwing', async () => {
    setThrows = true;
    await mountCard();
    await openMenu();
    await expect(click(soundItem()!)).resolves.toBeUndefined();
    expect(soundItem()?.textContent).toBe(label(en.sounds.bell, en.sounds.knock));
  });
});

describe('fail-open (P6: a notification nicety may not cost the card)', () => {
  it('draws no entry at all without the bridge namespace', async () => {
    // #444: a card that read `window.switchboard.rules` unguarded white-screened
    // against a partial bridge. A control that provably cannot work is not shown.
    installBridge(false);
    await mountCard();
    await openMenu();
    expect(soundItem()).toBeNull();
    expect(host.querySelector('[data-testid="card-header"]')).not.toBeNull();
  });

  it('draws no entry when the cue could not be read', async () => {
    currentSound = null;
    await mountCard();
    await openMenu();
    expect(soundItem()).toBeNull();
  });

  it('survives a read that rejects', async () => {
    (window as unknown as { switchboard: { sounds: { get: unknown } } }).switchboard.sounds.get =
      () => Promise.reject(new Error('main is gone'));
    await mountCard();
    await openMenu();
    expect(soundItem()).toBeNull();
    expect(host.querySelector('[data-testid="card-header"]')).not.toBeNull();
  });
});
