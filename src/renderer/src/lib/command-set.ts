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
import { FOCUS_POLICY_ORDER, FocusPolicy } from './focus-policy';
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
  /** move a session a step up or down INSIDE its own group (#559). Answers
   *  whether it actually moved, so a no-op at the end of a group stays silent */
  reorderSession: (cardId: string, dir: 'up' | 'down') => boolean;
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
  /** what a session that finishes or needs you may do to the screen (E9-10) */
  setGlobalFocusPolicy: (policy: FocusPolicy) => void;
  /** override the focus policy for ONE session; `undefined` follows the default */
  setSessionFocusPolicy: (cardId: string, policy: FocusPolicy | undefined) => void;
  /** put the whole workspace in a named layout mode (E9-07) */
  setLayoutMode: (mode: LayoutMode) => void;
  /** next layout mode in the cycle — the one binding (E9-07) */
  cycleLayoutMode: () => void;
  /** blow one session up to fill the workspace, or put the prior layout back */
  toggleMaximize: (cardId: string) => void;
  /** show/hide the sessions rail */
  toggleRail: () => void;
  /** open or shut the events drawer (P2-E14-01, Shape B) */
  toggleEventsDrawer: () => void;
  /** open the command palette (E9-02) */
  openPalette: () => void;
  /** open the find bar on a card (E17-02, §5.31) */
  /** open the find bar on a card — or, since #533, on a `doc-` viewer panel */
  openFind: (targetId: string) => void;
  /** wrap the tab strip onto more rows, or keep it to one (#84) */
  toggleTabRows: () => void;
  /** show a diff in two columns or one — every Changes tab at once (#532) */
  toggleDiffLayout: () => void;
  /** jump to the next session waiting on a human (E9-03 attention queue) */
  jumpToNextAttention: () => void;
  /** show the build identity — version, commit, branch, build age (E15-15) */
  openAbout: () => void;
  /** ask the release host whether there is a newer build (E19-03) */
  checkForUpdates: () => void;
  /** pick a file and open it in a §5.30 document viewer (E16-02) */
  openFile: () => void;
  /** close every docked §5.30 viewer at once, sparing popped-out ones (#543) */
  closeAllDocuments: () => void;
  /** set up phone push / webhooks — the credential surface (E14-06, §5.29) */
  openPushSetup: () => void;
  /** set the quiet-hours window — when nothing person-facing fires (E14-05b) */
  openQuietHours: () => void;
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
      // Ctrl+F over the FOCUSED session (§5.31).
      //
      // THE SECOND 'typing-ok' COMMAND, and the first since E9-02 — a
      // deliberate amendment to "the palette is the only one", made for the
      // same reason the palette got the exemption. The rule's actual content
      // is *never steal a keystroke a text surface should get*, and `Mod+F` is
      // not a text-editing key on any platform we ship: it is Ctrl+F on
      // Windows and Linux, where a textarea does nothing with it, and Cmd+F on
      // macOS (Ctrl+F is the emacs forward-char there, and we do not bind it).
      // Without this, the headline gesture of §5.31 would silently do nothing
      // from the composer — which is where the caret sits for most of a
      // session, and therefore where "two hours in, you know it printed that
      // path" is actually typed.
      //
      // The TERMINAL is untouched by this: `dispatch` refuses every scope
      // inside an xterm, and that rule does not bend. So Ctrl+F pressed in a
      // focused terminal still does not reach us — and E17-03, which shipped
      // the Terminal's find provider, DECIDED NOT to claim it in
      // `shared/terminal-accelerators` either: that file's growth rule lists
      // Ctrl+F among the keys a line editor owns, and the shipped claude binary
      // binds it to `scroll:fullPageDown`. The reasoning is written out at the
      // bottom of `extensibility/find-providers.ts`; the route from inside a
      // terminal is Ctrl+Shift+P → "Find in session", and the terminal's
      // scrollback is searched by Ctrl+F pressed anywhere else on the card.
      //
      // SURFACE-scoped, not card-scoped (#533). Every other command in this
      // file acts on a session, so "the focused card, or nothing" is the whole
      // of its context; find acts on whatever is being READ, and since §5.30 a
      // document viewer is one of those — its own dockview panel, with no
      // session behind it and no card id to answer with. So this takes either,
      // and is disabled only when neither is focused rather than silently
      // opening a bar over nothing.
      //
      // THE DOCUMENT WINS when both are live, and that is not arbitrary: the
      // only way both are is that the user is typing in a popped-out VIEWER
      // window while a card is active back in the grid (`activeDocumentId`
      // asks the focused window first). The document is the thing in front of
      // them; opening the bar on the card would put it in a window they are not
      // looking at — which is the bug in mirror image.
      id: 'find.open',
      titleKey: 'commands.openFind',
      categoryKey: CATEGORY_VIEW,
      binding: 'Mod+F',
      scope: 'typing-ok',
      enabled: (ctx: CommandContext) => hasActive(ctx) || !!ctx.activeDocumentId,
      disabledReasonKey: 'commands.disabled.noFindTarget',
      run: (ctx: CommandContext) => {
        const target = ctx.activeDocumentId ?? ctx.activeCardId;
        if (target) deps.openFind(target);
      },
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
    {
      // Phone push + webhooks (E14-06). Filed under Attention rather than Help
      // because that is the question it answers — "how does a session reach
      // me?" — and palette-only, unbound, like About: it is a setup gesture
      // done once, not something to give a chord to. The About panel carries
      // the mouse path, beside the app's other outbound-network switches.
      id: 'attention.pushSetup',
      titleKey: 'commands.pushSetup',
      categoryKey: CATEGORY_ATTENTION,
      scope: 'app',
      run: () => deps.openPushSetup(),
    },
    {
      // Quiet hours (E14-05b). Under Attention beside push for the same reason
      // — it answers "how, and when, does a session reach me?" — and
      // palette-only, unbound: a window you set once does not earn a chord, and
      // the title bar's eleven chips are not getting a twelfth.
      id: 'attention.quietHours',
      titleKey: 'commands.quietHours',
      categoryKey: CATEGORY_ATTENTION,
      scope: 'app',
      run: () => deps.openQuietHours(),
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
    // ── #559's MANUAL RAIL ORDER ──────────────────────────────────────────
    //
    // A PAIR here where pinning is a single toggle, and for the same reason the
    // ladder is a pair: this is a STEP, not a state, so there is no one gesture
    // that could carry both directions. The chords sit beside the ladder's
    // (Mod+Shift+Arrow moves the card through §5.8's presentation rungs;
    // Mod+Alt+Arrow moves the ROW through its group) — near neighbours because
    // they are the two things an arrow key could plausibly mean here, and
    // distinct modifiers because confusing them would collapse a card the user
    // was trying to file.
    //
    // The rail's context menu carries the same two commands (§5.32's fifth
    // rule: the keyboard equivalent belongs in the surface's existing menu).
    // These exist ON TOP of that, exactly as Mod+Alt+P exists on top of the
    // menu's Pin item — one keystroke instead of a menu walk, for the gesture
    // you repeat while arranging a workspace.
    //
    // NOTE ON THE LIVE REGION. §5.32's rule (b) — say what happened, because a
    // drop is confirmed by the eye and nothing else — is discharged by the MENU
    // path, which is the equivalent the rule is about; the rail owns that region
    // and announces the new position from it. These CHORDS are silent, like
    // `session.pin`'s and the ladder's beside them: a chord is not the
    // accessible path, it is the fast one, and giving it a voice would mean a
    // second announcer outside the surface that knows what the list looks
    // like. If that ever changes, it should change for all three at once.
    ...(['up', 'down'] as const).map((dir) => ({
      id: `session.reorder.${dir}`,
      titleKey: dir === 'up' ? 'commands.reorderUp' : 'commands.reorderDown',
      categoryKey: CATEGORY_SESSION,
      binding: dir === 'up' ? 'Mod+Alt+ArrowUp' : 'Mod+Alt+ArrowDown',
      scope: 'app' as const,
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx: CommandContext) => {
        if (ctx.activeCardId) deps.reorderSession(ctx.activeCardId, dir);
      },
    })),
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
    // ── §5.8's FOCUS-STEALING policy (E9-10) ──────────────────────────────
    //
    // Named targets and no cycle, for E9-06's reason: a palette entry has to
    // say what it will DO before you press Enter. No binding either — this is a
    // preference you set once, and the four modes would want four of them.
    //
    // The GLOBAL entries sit in the Attention category rather than View: this
    // setting is about what an attention event is allowed to do, and it is the
    // neighbour of Ctrl+Space, not of the layout modes.
    ...FOCUS_POLICY_ORDER.map(
      (policy): Command => ({
        id: `attention.focusPolicy.${policy}`,
        titleKey: `commands.focusPolicy.${policy}`,
        categoryKey: CATEGORY_ATTENTION,
        scope: 'app' as const,
        run: () => deps.setGlobalFocusPolicy(policy),
      })
    ),
    ...FOCUS_POLICY_ORDER.map(
      (policy): Command => ({
        id: `session.focusPolicy.${policy}`,
        titleKey: `commands.sessionFocusPolicy.${policy}`,
        categoryKey: CATEGORY_ATTENTION,
        scope: 'app' as const,
        enabled: hasActive,
        disabledReasonKey: 'commands.disabled.noActiveSession',
        run: (ctx) => {
          if (ctx.activeCardId) deps.setSessionFocusPolicy(ctx.activeCardId, policy);
        },
      })
    ),
    {
      // The way BACK from a per-session override — see session.policy.default
      // for why picking today's default value is not the same thing.
      id: 'session.focusPolicy.default',
      titleKey: 'commands.sessionFocusPolicy.default',
      categoryKey: CATEGORY_ATTENTION,
      scope: 'app',
      enabled: hasActive,
      disabledReasonKey: 'commands.disabled.noActiveSession',
      run: (ctx) => {
        if (ctx.activeCardId) deps.setSessionFocusPolicy(ctx.activeCardId, undefined);
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
      // §5.30's `Open file…`. In the VIEW category and not SESSION, because a
      // document viewer belongs to no session — it is a surface the workspace
      // holds, like the rail.
      //
      // BOUND HERE, AND DELIBERATELY NOT IN THE MENU (#569). The File menu shows
      // Ctrl+O beside this item but registers nothing: an application-menu
      // accelerator is claimed by the BROWSER process and never reaches the
      // page, and **the hosted CLI binds `ctrl+o` itself** — it is
      // `app:toggleTranscript`, and Claude Code prints "ctrl+o to see" in its
      // own compaction and stop-hook notices (read off the shipped binary, per
      // the standing rule). Claiming it up there would answer the CLI's own
      // instruction with a file dialog, which is P7 broken in one keystroke.
      //
      // Held by the registry instead, the chord goes through `dispatch`, which
      // refuses a TERMINAL target before it looks at anything else — so typing
      // Ctrl+O into a session's terminal still reaches the CLI, and every other
      // surface gets the file browser.
      //
      // `typing-ok` because this is not a chord you press by accident: an
      // editor's Ctrl+O works while the caret is in a text field, and the File
      // menu's click rides this same command — a menu click is not typing, and
      // gating it on focus made File > Open File do NOTHING with the composer
      // focused, which is the single most likely moment to reach for it.
      id: 'view.openFile',
      titleKey: 'commands.openFile',
      categoryKey: CATEGORY_VIEW,
      binding: 'Mod+O',
      scope: 'typing-ok',
      run: () => deps.openFile(),
    },
    {
      // The answer to accretion #530 left open (#543). Removing the peek slot
      // made every file its own tab, which is what the owner asked for and
      // which has no ceiling: thirty files read over a morning are thirty tabs,
      // closed one ✕ at a time. This is the bulk gesture, and it is the
      // cheapest possible one on purpose — anything smarter (LRU, tab groups)
      // waits for evidence that this is not enough.
      //
      // PALETTE-ONLY AND UNBOUND, exactly like `session.closeAll`: a command
      // that shuts thirty panels is not one to reach by mistyping a chord, and
      // the title is what makes it findable.
      //
      // The title NAMES ITS OWN EXEMPTION, which is the pattern
      // `commands.closeAllSessions` already set with "(keeps pinned ones)".
      // Here the spared ones are the popped-out viewers — see
      // `lib/document-panels`' `closableDocuments` for the reasoning — and the
      // count below is of the closable ones only, so with a single document
      // open in its own window this greys out and says why rather than running
      // and appearing broken.
      id: 'view.closeAllDocuments',
      titleKey: 'commands.closeAllDocuments',
      categoryKey: CATEGORY_VIEW,
      scope: 'app',
      enabled: (ctx) => (ctx.closableDocumentCount ?? 0) > 0,
      disabledReasonKey: 'commands.disabled.noDocuments',
      run: () => deps.closeAllDocuments(),
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
      // The keyboard half of P2-E14-01. The drawer is collapsed by default, so
      // §5.8's invariant — collapsing chrome never removes capability — is only
      // kept if there is a route in that does not need a mouse. There are two:
      // this chord, and the palette entry this same command provides.
      //
      // Scope 'app', like every other view toggle: Ctrl+E is `end-of-line` in
      // readline and the terminal owns every key it can see. That is not a hole
      // in the promise — the palette is reachable from inside a terminal
      // (Ctrl+Shift+P is claimed above the page, #90), and it lists this.
      //
      // Categorised under Attention rather than View: what it opens is the
      // queue, and "what needs me?" is the question a user is asking when they
      // go looking for it.
      id: 'view.events',
      titleKey: 'commands.toggleEvents',
      categoryKey: CATEGORY_ATTENTION,
      binding: 'Mod+E',
      scope: 'app',
      run: () => deps.toggleEventsDrawer(),
    },
    {
      id: 'view.tabRows',
      titleKey: 'commands.toggleTabRows',
      categoryKey: CATEGORY_VIEW,
      scope: 'app', // palette-only: a preference, not a per-minute action
      run: () => deps.toggleTabRows(),
    },
    {
      // #532's keyboard route. In VIEW and not SESSION even though a Changes
      // tab belongs to a card: the preference is the workspace's, and every
      // open Changes tab changes with it — a card-scoped command would promise
      // otherwise. Palette-only and unbound, like the tab-rows toggle above:
      // it is a habit you set once, and the visible control on the tab is
      // where you set it the other 99% of the time.
      id: 'view.diffLayout',
      titleKey: 'commands.toggleDiffLayout',
      categoryKey: CATEGORY_VIEW,
      scope: 'app',
      run: () => deps.toggleDiffLayout(),
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
    {
      // The keyboard route to the update check (E19-03). Palette-only and
      // unbound for the same reasons as About — and here for the same reason
      // too: the menu item is easy to miss, and §5.8 says the palette is where
      // everything the app can do is reachable.
      id: 'help.checkForUpdates',
      titleKey: 'commands.checkForUpdates',
      categoryKey: CATEGORY_HELP,
      scope: 'app',
      run: () => deps.checkForUpdates(),
    },
  ];
}
