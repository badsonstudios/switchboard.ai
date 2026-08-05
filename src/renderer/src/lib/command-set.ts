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
import { POLICY_ORDER, PresentationPolicy } from './presentation-policy';
import { LAYOUT_MODES, LayoutMode } from './layout-mode';

export interface CommandDeps {
  /** focus the session card with this card id */
  focusCard: (cardId: string) => void;
  /** pick a folder and open a new session in it */
  newSession: () => void;
  /** close a card (asks for confirmation — it forgets the record) */
  closeCard: (cardId: string) => void;
  /** close every session at once, except the pinned ones (E9-09 bulk-close) */
  closeAllCards: () => void;
  /** pin or unpin a session — §5.8's protection contract (E9-09) */
  togglePin: (cardId: string) => void;
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
  /** what happens to EVERY session's card when its prompt is submitted (E9-06) */
  setGlobalPolicy: (policy: PresentationPolicy) => void;
  /** override the global for ONE session; `undefined` follows the default again */
  setSessionPolicy: (cardId: string, policy: PresentationPolicy | undefined) => void;
  /** override the global for a whole persistent group (E9-06) */
  setGroupPolicy: (groupId: string, policy: PresentationPolicy | undefined) => void;
  /** put the whole workspace in a named layout mode (E9-07) */
  setLayoutMode: (mode: LayoutMode) => void;
  /** next layout mode in the cycle — the one binding (E9-07) */
  cycleLayoutMode: () => void;
  /** blow one session up to fill the workspace, or put the prior layout back */
  toggleMaximize: (cardId: string) => void;
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
    // ── §5.8's PINNING contract (E9-09) ───────────────────────────────────
    //
    // ONE command and one binding, not a pin/unpin pair: §5.8 says "pin/unpin
    // is ONE gesture", and a pair would also have to fight over which of them
    // owns the chord (the contribution builder dedupes by binding, so the
    // second would silently lose it). The named-targets split the ladder and
    // the policies use is for choices with three or four values; a boolean has
    // one control, exactly as `view.rail` and `view.terminal` do.
    {
      id: 'session.pin',
      titleKey: 'commands.togglePin',
      categoryKey: CATEGORY_SESSION,
      binding: 'Mod+Alt+P',
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.togglePin(ctx.activeCardId);
      },
    },
    {
      // The bulk operation pinning exists to be exempt from (§5.8). Palette-only
      // and deliberately WITHOUT a binding: closing every session at once is not
      // something anyone should be able to do by mistyping a chord, and the
      // title has to be read to be found. It confirms once, not once per card.
      id: 'session.closeAll',
      titleKey: 'commands.closeAllSessions',
      categoryKey: CATEGORY_SESSION,
      scope: 'app',
      enabled: (ctx) => ctx.sessions.length > 0,
      disabledReasonKey: 'commands.disabled.noSessions',
      run: () => deps.closeAllCards(),
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
    // ── §5.8's layout MODES (E9-07) ───────────────────────────────────────
    //
    // Three NAMED targets plus one cycle, and the split follows E9-06's:
    // naming a mode is what belongs in a list you read, while cycling is the
    // per-minute gesture and gets the key. The cycle entry is in the palette
    // too — §5.8's invariant is that hiding chrome never removes capability,
    // and the titlebar chip is chrome — but its title spells the ORDER out, so
    // it still says what pressing Enter will do.
    //
    // Generated from LAYOUT_MODES rather than written out three times, so a
    // fourth mode cannot ship with two of its three entries.
    ...LAYOUT_MODES.map(
      (mode): Command => ({
        id: `layout.mode.${mode}`,
        titleKey: `commands.layout.${mode}`,
        categoryKey: CATEGORY_VIEW,
        scope: 'app' as const, // palette-only: the cycle below is the key path
        run: () => deps.setLayoutMode(mode),
      })
    ),
    {
      id: 'layout.cycleMode',
      titleKey: 'commands.cycleLayout',
      categoryKey: CATEGORY_VIEW,
      binding: 'Mod+Shift+L',
      scope: 'app',
      run: () => deps.cycleLayoutMode(),
    },
    {
      // §5.8: "double-click a session header (or ONE COMMAND) toggles maximize".
      // This is that command — and it is the reason the double-click is allowed
      // to be a double-click at all: the gesture has a keyboard equal, so no
      // capability lives in the mouse alone.
      id: 'session.maximize',
      titleKey: 'commands.maximize',
      categoryKey: CATEGORY_VIEW,
      binding: 'Mod+Shift+M',
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.toggleMaximize(ctx.activeCardId);
      },
    },
    // ── §5.8's presentation POLICY (E9-06) ────────────────────────────────
    //
    // Named targets, not a cycle. A palette entry has to say what it will DO
    // before you press Enter — "cycle the presentation policy" tells you only
    // that something will change, and the mouse paths (the titlebar chip, the
    // rail menus) are where cycling belongs.
    //
    // Generated from POLICY_ORDER rather than written out three times, so a
    // fourth policy cannot ship with two of its three entries.
    ...POLICY_ORDER.map(
      (policy): Command => ({
        id: `presentation.policy.${policy}`,
        titleKey: `commands.policy.${policy}`,
        categoryKey: CATEGORY_VIEW,
        scope: 'app' as const, // palette-only: a preference, not a per-minute action
        run: () => deps.setGlobalPolicy(policy),
      })
    ),
    ...POLICY_ORDER.map(
      (policy): Command => ({
        id: `session.policy.${policy}`,
        titleKey: `commands.sessionPolicy.${policy}`,
        categoryKey: CATEGORY_SESSION,
        scope: 'app' as const,
        enabled: hasActive,
        disabledReasonKey: 'commands.disabled.noActiveSession',
        run: (ctx) => {
          if (ctx.activeCardId) deps.setSessionPolicy(ctx.activeCardId, policy);
        },
      })
    ),
    {
      // The way BACK from an override. "Follow the default" has to be a command
      // of its own: without it the only route out of a per-session choice would
      // be picking the value the default happens to have today, which stops
      // being the default the moment the user changes it.
      id: 'session.policy.default',
      titleKey: 'commands.sessionPolicy.default',
      categoryKey: CATEGORY_SESSION,
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.setSessionPolicy(ctx.activeCardId, undefined);
      },
    },
    // The GROUP level exists only as a button on the rail's group header, and
    // `Ctrl+B` hides the rail. §5.8's invariant is that hiding chrome never
    // removes capability, so it has to be here too — acting on the focused
    // session's group, which is the only group the palette can name without
    // inventing a group picker.
    ...POLICY_ORDER.map(
      (policy): Command => ({
        id: `group.policy.${policy}`,
        titleKey: `commands.groupPolicy.${policy}`,
        categoryKey: CATEGORY_SESSION,
        scope: 'app' as const,
        enabled: (ctx) => ctx.activeGroupId !== null,
        disabledReasonKey: 'commands.disabled.noActiveGroup',
        run: (ctx) => {
          if (ctx.activeGroupId) deps.setGroupPolicy(ctx.activeGroupId, policy);
        },
      })
    ),
    {
      id: 'group.policy.default',
      titleKey: 'commands.groupPolicy.default',
      categoryKey: CATEGORY_SESSION,
      scope: 'app',
      enabled: (ctx) => ctx.activeGroupId !== null,
      disabledReasonKey: 'commands.disabled.noActiveGroup',
      run: (ctx) => {
        if (ctx.activeGroupId) deps.setGroupPolicy(ctx.activeGroupId, undefined);
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
