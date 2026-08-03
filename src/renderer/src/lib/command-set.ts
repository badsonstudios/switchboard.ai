// The seed command set (P2-E9-01). Kept apart from the registry mechanics in
// commands.ts: this file knows WHAT the app can do, that one knows how keys
// reach a command. E9-02's palette renders whatever this returns; later items
// (attention queue, layout modes, maximize) add to it rather than binding keys
// of their own.
//
// Every seed command is scope 'app': none of them fire while the user is typing
// in the composer, renaming a session, or working in a terminal.
import { Command, CommandContext } from './commands';
import { PanelId } from '../extensibility/contributions';
import type { Ladder } from './presentation';

export interface CommandDeps {
  /** focus the session card with this card id */
  focusCard: (cardId: string) => void;
  /** pick a folder and open a new session in it */
  newSession: () => void;
  /** close a card (asks for confirmation — it forgets the record) */
  closeCard: (cardId: string) => void;
  /** switch a card's view tab; the same view twice returns to the Session view */
  toggleCardView: (cardId: string, view: PanelId) => void;
  /** pop a card out to its own window, or dock it back in */
  popOutCard: (cardId: string) => void;
  /** take a card out of the workspace, keeping the session running (§5.8) */
  hideCard: (cardId: string) => void;
  /** put a card on a named rung of §5.8's presentation ladder (E9-05) */
  setLadder: (cardId: string, rung: Ladder) => void;
  /** step a card one rung down (collapse) or up (expand) — E9-05 */
  stepLadder: (cardId: string, dir: 'down' | 'up') => void;
  /** show/hide the sessions rail */
  toggleRail: () => void;
  /** open the command palette (E9-02) */
  openPalette: () => void;
  /** wrap the tab strip onto more rows, or keep it to one (#84) */
  toggleTabRows: () => void;
  /** jump to the next session waiting on a human (E9-03 attention queue) */
  jumpToNextAttention: () => void;
  /** show the build identity — version, commit, branch, build age (E15-15) */
  openAbout: () => void;
}

const CATEGORY_SESSION = 'commands.category.session';
const CATEGORY_VIEW = 'commands.category.view';
const CATEGORY_ATTENTION = 'commands.category.attention';
const CATEGORY_HELP = 'commands.category.help';

/** index of the focused card in rail order, or -1 */
function activeIndex(ctx: CommandContext): number {
  return ctx.activeCardId ? ctx.sessions.findIndex((s) => s.id === ctx.activeCardId) : -1;
}

export function buildCommands(deps: CommandDeps): Command[] {
  const hasActive = (ctx: CommandContext): boolean => ctx.activeCardId !== null;

  // Ctrl+1..9 — the Nth session in RAIL order (lib/groups railOrder), so the
  // keyboard and the eye always agree
  const jumps: Command[] = Array.from({ length: 9 }, (_, i) => ({
    id: `session.jump.${i + 1}`,
    titleKey: 'commands.jumpTo',
    titleParams: { n: i + 1 },
    categoryKey: CATEGORY_SESSION,
    binding: `Mod+${i + 1}`,
    scope: 'app' as const,
    enabled: (ctx: CommandContext) => ctx.sessions.length > i,
    disabledReasonKey: 'commands.disabled.noSuchSession',
    run: (ctx: CommandContext) => {
      const s = ctx.sessions[i];
      if (s) deps.focusCard(s.id);
    },
  }));

  const step = (delta: number) => (ctx: CommandContext) => {
    if (ctx.sessions.length === 0) return;
    const i = activeIndex(ctx);
    // no focused card: enter the list at either end rather than doing nothing
    const next = i < 0 ? (delta > 0 ? 0 : ctx.sessions.length - 1) : i + delta;
    const wrapped = (next + ctx.sessions.length) % ctx.sessions.length;
    deps.focusCard(ctx.sessions[wrapped].id);
  };

  return [
    {
      // The one command that may fire while you're typing (E9-02): the palette
      // is the fail-open path to everything else, and Ctrl+Shift+P is not a
      // text-editing key. No KEYDOWN from a terminal ever runs it — that rule
      // doesn't bend for anyone — but the chord itself does work from there,
      // because the browser process claims it before the page sees it at all
      // (#90, shared/terminal-accelerators.ts).
      id: 'palette.open',
      titleKey: 'commands.openPalette',
      categoryKey: CATEGORY_VIEW,
      binding: 'Mod+Shift+P',
      scope: 'typing-ok',
      run: () => deps.openPalette(),
    },
    {
      // Inbox-zero for agents (§5.8): with 7–8 sessions this, not the grid, is
      // the primary workflow — so it sits directly under the palette.
      //
      // Scope 'app', deliberately: Ctrl+Space is a REAL keystroke in a terminal
      // (NUL — emacs set-mark, and some CLIs' completion), and the hard rule
      // says the terminal owns every key it can see.
      //
      // That used to mean the queue was mouse-only from a terminal. #90 fixed
      // it WITHOUT touching this scope: Ctrl+Space is one of the two chords the
      // browser process claims in before-input-event, so from a terminal the
      // keystroke never reaches the page — and the command arrives here by id
      // instead. The scope below still governs every other route to it, which
      // is why it must stay 'app': the composer keeps its keys.
      //
      // macOS caveat: 'Mod' is Cmd there, and Cmd+Space is Spotlight — the OS
      // will usually win, so the hotkey quietly won't fire. It fails open (the
      // palette still lists it, §5.8's hiding-chrome-never-removes-capability
      // invariant) and Dan is on Windows; a per-platform accelerator override
      // is the fix if a Mac user ever turns up.
      id: 'attention.next',
      titleKey: 'commands.jumpAttention',
      categoryKey: CATEGORY_ATTENTION,
      binding: 'Mod+Space',
      scope: 'app',
      enabled: (ctx) => ctx.attentionCount > 0,
      disabledReasonKey: 'commands.disabled.emptyQueue',
      run: () => deps.jumpToNextAttention(),
    },
    ...jumps,
    {
      id: 'session.next',
      titleKey: 'commands.nextSession',
      categoryKey: CATEGORY_SESSION,
      binding: 'Mod+PageDown',
      scope: 'app',
      enabled: (ctx) => ctx.sessions.length > 0,
      disabledReasonKey: 'commands.disabled.noSessions',
      run: step(1),
    },
    {
      id: 'session.prev',
      titleKey: 'commands.prevSession',
      categoryKey: CATEGORY_SESSION,
      binding: 'Mod+PageUp',
      scope: 'app',
      enabled: (ctx) => ctx.sessions.length > 0,
      disabledReasonKey: 'commands.disabled.noSessions',
      run: step(-1),
    },
    {
      id: 'session.new',
      titleKey: 'commands.newSession',
      categoryKey: CATEGORY_SESSION,
      binding: 'Mod+N',
      scope: 'app',
      run: () => deps.newSession(),
    },
    {
      id: 'session.close',
      titleKey: 'commands.closeSession',
      categoryKey: CATEGORY_SESSION,
      binding: 'Mod+W',
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.closeCard(ctx.activeCardId);
      },
    },
    // ── §5.8's presentation ladder (E9-05) ────────────────────────────────
    //
    // Two BINDINGS that step, and four palette entries that jump straight to a
    // rung. The pair is deliberate: stepping is the everyday gesture and gets
    // the keys, while naming a rung is the thing you do once and would rather
    // read off a list than count out in keystrokes.
    //
    // Every one of them acts on the ACTIVE card, which means a card with a
    // dockview panel — so the only rung you cannot reach from here is "up, from
    // a card that isn't in the workspace". That is not a gap: §5.8's OTHER
    // reveal triggers cover it (click the collapsed row, the lamp, the rail row
    // or the event), and the palette's own `go to session <name>` entries
    // reveal a hidden card by name. Capability is never removed, which is the
    // invariant this whole item is written against.
    {
      id: 'session.ladder.down',
      titleKey: 'commands.ladderDown',
      categoryKey: CATEGORY_VIEW,
      binding: 'Mod+Shift+ArrowDown',
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.stepLadder(ctx.activeCardId, 'down');
      },
    },
    {
      id: 'session.ladder.up',
      titleKey: 'commands.ladderUp',
      categoryKey: CATEGORY_VIEW,
      binding: 'Mod+Shift+ArrowUp',
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.stepLadder(ctx.activeCardId, 'up');
      },
    },
    {
      // The card gives its dock slot back and becomes a row in the collapsed
      // strip — still running, one click from coming straight back.
      id: 'session.collapse',
      titleKey: 'commands.collapseSession',
      categoryKey: CATEGORY_VIEW,
      scope: 'app', // palette-only: the step bindings above are the key path
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.setLadder(ctx.activeCardId, 'collapsed');
      },
    },
    {
      // Stacked with every other tabbed session in one group, so all of them
      // together cost one slot.
      id: 'session.tabbed',
      titleKey: 'commands.tabSession',
      categoryKey: CATEGORY_VIEW,
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.setLadder(ctx.activeCardId, 'tabbed');
      },
    },
    {
      id: 'session.expand',
      titleKey: 'commands.expandSession',
      categoryKey: CATEGORY_VIEW,
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.setLadder(ctx.activeCardId, 'expanded');
      },
    },
    {
      // The ladder's bottom rung. NOT a close: the session keeps running and the
      // card keeps its record, its rail row, its lamp and its events — which is
      // also why it needs no confirmation, unlike Mod+W. Clicking the session
      // anywhere brings it back to the slot it left.
      id: 'session.hide',
      titleKey: 'commands.hideSession',
      categoryKey: CATEGORY_VIEW,
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.hideCard(ctx.activeCardId);
      },
    },
    {
      id: 'session.popOut',
      titleKey: 'commands.popOut',
      categoryKey: CATEGORY_VIEW,
      binding: 'Mod+Shift+O',
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.popOutCard(ctx.activeCardId);
      },
    },
    {
      id: 'view.terminal',
      titleKey: 'commands.toggleTerminal',
      categoryKey: CATEGORY_VIEW,
      binding: 'Mod+`',
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.toggleCardView(ctx.activeCardId, 'terminal');
      },
    },
    {
      id: 'view.changes',
      titleKey: 'commands.toggleChanges',
      categoryKey: CATEGORY_VIEW,
      scope: 'app', // palette-only for now — no binding to spare
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.toggleCardView(ctx.activeCardId, 'diff');
      },
    },
    {
      id: 'view.rail',
      titleKey: 'commands.toggleRail',
      categoryKey: CATEGORY_VIEW,
      binding: 'Mod+B',
      scope: 'app',
      run: () => deps.toggleRail(),
    },
    {
      id: 'view.tabRows',
      titleKey: 'commands.toggleTabRows',
      categoryKey: CATEGORY_VIEW,
      scope: 'app', // palette-only: a preference, not a per-minute action
      run: () => deps.toggleTabRows(),
    },
    {
      // The keyboard route to the build identity (E15-15). Palette-only and no
      // binding: it is looked up once in a while, never in a hurry — but it has
      // to be HERE, because the palette is the standing promise that everything
      // the app can do is reachable without knowing where its chrome went
      // (§5.8). Searching "version", "build" or "about" all land on it via the
      // title text.
      id: 'help.about',
      titleKey: 'commands.about',
      categoryKey: CATEGORY_HELP,
      scope: 'app',
      run: () => deps.openAbout(),
    },
  ];
}
