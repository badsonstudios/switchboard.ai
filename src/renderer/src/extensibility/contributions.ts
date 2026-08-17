// The RENDERER's contribution vocabulary (§5.23, AR-P0-2). Mirror image of
// src/main/extensibility/contributions.ts: same registry class from
// src/shared, a contracts map of its own.
//
// Why this exists at all: §5.23 lists nine first-party extensions and eight of
// them are renderer contributions — view tabs, feed block renderers, status bar
// items, themes. Before this there was no renderer-side seam whatsoever, so the
// Phase-4 gate ("2–3 dissimilar internal consumers on the seams") was
// unreachable by construction: the count was 1 and could not grow.
//
// `command-set` is the first, and it is not a new abstraction — lib/commands.ts
// was already a contribution point in everything but name (register a thing,
// resolve it by id, never import the contributor). P2-E15-03 adds `panel`,
// `feed-block-renderer` and `status-bar-item` to this map.
// Every import here is type-only, deliberately: this module is on the store's
// dependency path (presentation state names a PanelId), and the store has to
// stay testable without pulling React and a 700-line component in behind it.
import type React from 'react';
import type { CapabilityManifest } from '../../../shared/extensibility/registry';
import type { BindingDiagnostics, BindingState } from '../../../shared/transcripts';
import type { Command } from '../lib/commands';
import type { CommandDeps } from '../lib/command-set';
import type { FeedBlockDto } from '../lib/feed';
import type { ThemeDefinition, ThemeId } from '../theme/theme';
import type { ServiceHealthStatus } from '../../../shared/service-health';
import type { EventDto } from '../model/types';

/**
 * A set of commands. Built lazily from deps rather than supplied as a list:
 * every command closes over app callbacks (focus a card, open the palette),
 * which do not exist at registration time.
 */
export interface CommandSetContribution {
  manifest: CapabilityManifest;
  build(deps: CommandDeps): Command[];
}

// A type alias, not `interface ... extends ContributionMap` — see the twin
// comment in main's contributions.ts for why that distinction is load-bearing.
//
// Precedence, because the registry dedupes CONTRIBUTION ids and not the
// commands inside them: sets are flattened in registration order, and both
// `dispatch` and `bindingFor` take the FIRST match. So command ids and
// accelerators must be unique across sets; earlier registration wins, and
// App logs a warning when it sees a collision.
export type RendererContributions = {
  'command-set': CommandSetContribution;
  panel: PanelContribution;
  'feed-block-renderer': FeedBlockRendererContribution;
  'status-bar-item': StatusBarItemContribution;
  theme: ThemeContribution;
  'find-provider': FindProviderContribution;
};

/**
 * A theme (§5.20, P2-E15-05).
 *
 * The fifth point and the only DATA-ONLY one: every other contribution here
 * hands over a function — build these commands, render this block — and this
 * one hands over a value. That is the shape a plugin manifest can carry
 * without executing anything, which is why §5.23's tier-1 (sandboxed) trust
 * level exists at all, and why it is worth having in the roster before Phase 4
 * has to design for it.
 */
export interface ThemeContribution {
  manifest: CapabilityManifest;
  /** ascending; decides picker order */
  order: number;
  theme: ThemeDefinition;
}

// ---------------------------------------------------------------------------
// P2-E15-03: the three renderer points that make the seam a real one. They are
// deliberately DISSIMILAR — the Phase-4 gate asks for dissimilar consumers, and
// three variations on one shape would prove nothing about the contract.
// ---------------------------------------------------------------------------

/**
 * A panel id. Persisted per card in the ui blob and named by commands, so it
 * is a contract rather than a display string — and an OPEN one, since the ids
 * are whatever is registered at the `panel` point.
 */
export type PanelId = string;

/**
 * The panel a card falls back to: the Session view.
 *
 * Named rather than spelled 'feed' at five call sites — it is the default tab,
 * the toggle-back target, and the answer when a persisted id resolves to
 * nothing. The string itself is a persisted contract (see above).
 *
 * It lives HERE rather than beside the panels themselves because the store's
 * presentation state defaults to it, and `panels.tsx` imports the real view
 * components — importing that from the state layer would put React back on the
 * store's dependency path (P2-E15-07's lesson, kept).
 */
export const DEFAULT_PANEL_ID: PanelId = 'feed';

/** Build a manifest. One helper so every contribution declares the same shape. */
export function manifestFor(id: string, displayName: string, capability: string): CapabilityManifest {
  return { id, displayName, version: '1.0.0', capabilities: [capability] };
}

/** What a session panel is given to render itself. */
export interface PanelContext {
  /** the LIVE session id — churns on resume, so never persist it */
  sessionId: string;
  /** durable key for per-card preferences */
  cardId?: string;
  /**
   * The session's title, as the card header shows it (#196). On the context
   * rather than inside one panel because it describes the SESSION: any panel
   * that names a landmark needs it, and several cards are visible at once, so
   * a panel-level landmark with a fixed name is N identical entries in a
   * screen reader's landmark list.
   */
  title?: string;
  /** is this panel the active tab in a visible card? */
  visible: boolean;
  /**
   * Bumped whenever dockview has TOUCHED this panel's placement (#555).
   *
   * The host owns the dockview relationship, and dockview reattaches a panel's
   * DOM subtree for things that are not renders: activating a group re-runs
   * `openPanel`, and a move between groups relocates the whole tree. React sees
   * none of it — the same elements come back, so nothing re-renders — but the
   * browser drops the `scrollTop` of every scroll container inside them on the
   * way through, and no scroll, resize or visibility event fires to say so.
   *
   * A panel that holds a scroll position therefore cannot discover this by
   * itself: measured (#555), an `IntersectionObserver` never fires for the
   * round trip and a `ResizeObserver` never fires because the panel comes back
   * at exactly the size it left. So the host, which DOES get the event, says
   * "your placement moved" and the panel restores whatever it was keeping.
   *
   * A counter rather than a boolean or a timestamp: consecutive moves must each
   * be distinguishable, and the value only ever has to be compared with the
   * previous one.
   */
  dockEpoch: number;
  /** the session's working folder; absent for a session with none */
  folder?: string;
  /** the ACTIVE theme's id — an open set, so never switch on it */
  theme: ThemeId;
  /**
   * light or dark. Separate from `theme` because a panel embedding something
   * with two skins (Monaco) needs an answer that stays correct when a third
   * theme lands — `theme === 'daylight'` silently means "not light" for every
   * theme but one.
   */
  colorScheme: 'light' | 'dark';
  /**
   * Which transport hosts this session (P2-E18-08b). A stream session has NO
   * PTY, so a panel built around one has to say so rather than render an empty
   * black rectangle.
   */
  transport?: 'pty' | 'stream';
  status?: string;
  autonomy?: string;
  model?: string;
  /** transcript binding state and what the watcher observed getting there
   *  (P2-E15-10). On the context rather than inside the Session panel because
   *  it describes the SESSION, not one view of it — a future panel that also
   *  reads the transcript needs the same answer. */
  binding?: BindingState;
  bindingDiag?: BindingDiagnostics | null;
  /** an approval was answered moments ago and the status has not caught up
   *  yet (#125) — a panel showing "the CLI is waiting on you" must not say so
   *  in the gap between the click and the resolved event */
  recentlyDecided?: boolean;
  /** count of changed files, for a tab badge */
  changed: number;
  /**
   * The held request, if the CLI delegated one to us.
   *
   * `reason` found by #261's dropped-prop audit: the Session panel's consumer
   * declares it and `ApprovalBar` RENDERS it — it is the stream transport's
   * whole "the CLI tells you why" payoff (P2-E18-07) — but this context, the
   * seam a contributed panel is written against, did not. It survives at
   * runtime only because SessionGrid assigns a variable here, so excess-property
   * checking never fires; a panel written against this type could not reach it.
   * Same shape as the bug this audit came from, one level up.
   */
  approval?: {
    requestId: string;
    tool: string;
    input: Record<string, unknown>;
    /** the CLI's own prose for WHY — stream transport only */
    reason?: string;
  } | null;
  approvalQueued?: number;
  /**
   * This session has a held request and §5.8's grouped prompt is the one
   * showing it (P2-E9-11) — so `approval` is null here on purpose, and a panel
   * must NOT conclude that the CLI is waiting on something switchboard cannot
   * answer. It is being answered, one surface up.
   */
  approvalBatched?: boolean;
  onDecide?: (decision: 'allow' | 'deny', allowAll?: boolean) => void;
  onCycleAutonomy?: () => void;
  /** switch the card to another panel by id */
  setView: (id: PanelId) => void;
}

/**
 * A tab in a session card's view strip (§5.10).
 *
 * `id` is PERSISTED (`viewTab.<cardId>` in the ui blob) and referenced by the
 * E9-01 commands, so it is a stable contract, not a display detail.
 */
export interface PanelContribution {
  manifest: CapabilityManifest;
  id: PanelId;
  titleKey: string;
  /** ascending; Terminal is deliberately last (owner call 2026-07-22) */
  order: number;
  /**
   * Clickable? A false greys the tab but STILL SHOWS IT — §5.8: the user can
   * always see what exists, even when it isn't available yet. There is
   * deliberately no "hide it entirely" option: a tab that vanishes teaches the
   * user the app is unpredictable, and a greyed one teaches them why.
   */
  enabled?(ctx: PanelContext): boolean;
  /** a count shown next to the title (Changes shows changed-file count) */
  badge?(ctx: PanelContext): number | null;
  /**
   * Keep the panel mounted and hidden when another tab is active, instead of
   * unmounting it. Terminal needs this — unmounting throws away the xterm
   * view. Everything else mounts on demand.
   */
  keepMounted?: boolean;
  render(ctx: PanelContext): React.ReactNode;
}

/**
 * One renderer for one shape of transcript block (§5.10).
 *
 * ORDER IS LOAD-BEARING: bash, edit and the generic tool row all match
 * `kind === 'tool'`, and the first match wins — exactly as the hand-written
 * ternary chain did. A renderer that matches everything (the markdown
 * fallback) must therefore sort last.
 *
 * ONE RULE ABOUT TEXT, because find writes into what you render (#520). The
 * Session view marks the searched term by splitting the text nodes of the block
 * it jumped to, and it only splits text React does not TRACK: an element whose
 * lone child is a string, or anything below a `dangerouslySetInnerHTML`
 * container. So render a block's body text as `<pre>{text}</pre>` — one string
 * child — and it gets marked. Compose it out of several children
 * (`<span>{a}{b}</span>`) and it is skipped, deliberately and safely.
 *
 * The shape to avoid is the one that LOOKS like the first and is the second:
 * `<span>{label}{flag && <b/>}</span>` renders one DOM child when `flag` is
 * false while React still tracks the text node. Marking that one is a lost
 * update, or a `removeChild` on a detached node mid-conversation. If a
 * renderer's body text is conditional, give the text its own element. The rule
 * and its reasoning live in `lib/feed-marks.ts`.
 */
export interface FeedBlockRendererContribution {
  manifest: CapabilityManifest;
  order: number;
  matches(block: FeedBlockDto): boolean;
  render(block: FeedBlockDto): React.ReactNode;
}

/** What a status bar item is given to render itself. */
export interface StatusBarContext {
  count: number;
  /** the ACTIVE theme's id — the contract */
  theme: ThemeId;
  /** and its display name, already resolved (§5.21: translate, don't print an id) */
  themeNameKey: string;
  cliVersion?: string | null;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  /**
   * The provider's service health as main last reported it (P2-E14-07, §5.14).
   * Optional: a bar rendered before the first push — or in a test that does not
   * care — simply has no dot.
   */
  serviceHealth?: ServiceHealthStatus | null;
  /**
   * How many sessions are waiting on a human — §5.14's fourth status-bar
   * readout, built with P2-E14-01 because that item is what took the always-on
   * Events column away. `lib/queue.ts` is the authority; this is its depth, the
   * same number the drawer's tab shows.
   *
   * Optional for the same reason `serviceHealth` is: a bar rendered by a test
   * that does not care simply has no count.
   */
  attentionCount?: number;
  /** the accelerator that walks that queue, already formatted (e.g. 'Ctrl+Space') */
  attentionBinding?: string;
  /**
   * The kind at the HEAD of that queue — the worst thing waiting — so the bar
   * can be tinted by the same fact the drawer's tab is tinted by. Without it
   * the two readouts sit inches apart saying the same number in different
   * colours, which makes the status inks stop being a vocabulary.
   */
  attentionHottest?: EventDto['kind'] | null;
}

/** An item in the workspace status bar (§5.10). */
export interface StatusBarItemContribution {
  manifest: CapabilityManifest;
  /** left of the spacer or right of it */
  align: 'start' | 'end';
  order: number;
  /** returning null renders nothing — the usage item has no total yet */
  render(ctx: StatusBarContext): React.ReactNode | null;
}

// ---------------------------------------------------------------------------
// P2-E17-02: `find-provider` — the sixth renderer point (§5.31, §5.23).
//
// WHY A POINT AND NOT AN `if`. §5.31's load-bearing sentence is that
// `webContents.findInPage` is the WRONG PRIMITIVE: it searches the whole
// webContents, so in a four-card grid Ctrl+F would match text in the three
// sessions you are not looking at. One keybinding dispatching to the FOCUSED
// panel's provider is what makes the answer correct by construction rather
// than by a filter someone has to remember to write. A guard test pins that
// `findInPage` appears nowhere in the tree.
//
// WHY IT IS DISSIMILAR from the five points above — the Phase-4 gate asks for
// dissimilar consumers, and this one is the first point whose contributions
// **do not all do the same job**. Of the two that ship, one searches with our
// bar and one hands the whole interaction to a surface that already had a find
// (Monaco). See `mode` below.
// ---------------------------------------------------------------------------

/**
 * What the bar asks for.
 *
 * DELIBERATELY NO `regex` FLAG, and this is a decision rather than an
 * oversight: the E17-01 engine runs a user-supplied pattern on the MAIN
 * thread, where a backtracking one is unbounded — its author measured `(a+)+$`
 * holding the process for 146 seconds, i.e. every terminal in the workspace
 * dead. `unsafeRegexShape` + a deadline bound the accidents, neither is a
 * proof, and the engine's own header names the condition for exposing the
 * switch: move the scan to a terminable worker first. So v1 ships case and
 * whole-word — which are the two a browser's find bar has anyway — and the
 * regex toggle waits for the worker. (The wire type still carries `regex`; the
 * bar simply never sets it.)
 */
export interface FindQuery {
  term: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

/**
 * One match, as the BAR understands it — deliberately not `TranscriptHit`.
 *
 * The transcript engine is one provider of three; a hit from Monaco or from
 * xterm's scrollback has no `blockIndex` and no transcript `seq`. What every
 * provider can honestly supply is: text to show, where the match sits inside
 * it, and whether the surface can actually take you there.
 */
export interface FindHit {
  /**
   * Stable within one result set — React key and step target.
   *
   * NOT what comes back to the provider: the bar searches several providers at
   * once and NAMESPACES these ids by provider so two result sets cannot collide
   * as React keys (`lib/find-groups.ts`). A provider must therefore route
   * `reveal` through `ref`, never by parsing the id it is handed.
   */
  id: string;
  /** context around the match, for the results list */
  snippet: string;
  /** where the match starts inside `snippet`, and how long it is */
  matchStart: number;
  matchLength: number;
  /**
   * Can the surface scroll to this match IN PLACE?
   *
   * False is the §5.31 v1 boundary made explicit: the block is no longer in
   * the renderer's view buffer (or the engine could not line the file up with
   * it), so the hit is READABLE in the results list and nothing more. The bar
   * must not render a jump affordance for it — an affordance that does nothing
   * is the same lie as searching the DOM, one interaction later.
   */
  jumpable: boolean;
  /**
   * We KNOW this match is older than the loaded view (as opposed to "we could
   * not tell"). Only this one earns the "earlier than the loaded view" marker;
   * the honest answer to the other cases is silence.
   */
  earlierThanLoaded: boolean;
  /** i18n key + params for the row's small print (kind, field, time) */
  metaKey?: string;
  metaParams?: Record<string, string | number>;
  /** the provider's own way back to this match. Opaque to the bar. */
  ref?: unknown;
}

/**
 * Something the bar must SAY instead of showing a bare count.
 *
 * A partial scan reported as "12" is a wrong total told confidently, which is
 * the failure mode §5.31 exists to avoid.
 */
export interface FindNotice {
  key: string;
  params?: Record<string, string | number>;
  /** `error` means the count is not a count at all */
  tone: 'error' | 'info';
}

export interface FindResults {
  hits: FindHit[];
  /** matches found in total; `hits` may be capped */
  total: number;
  truncated: boolean;
  /**
   * `total` is a FLOOR — "at least this many" — because the provider stopped
   * counting before it reached the end (P2-E17-03).
   *
   * A provider with a hard ceiling on what it can count must set this rather
   * than report the ceiling as a total: the bar renders "1000+" for it. A
   * capped number presented as a count is the wrong-total-told-confidently
   * failure §5.31 exists to avoid, one layer down from a partial scan.
   */
  totalIsFloor?: boolean;
  notice?: FindNotice;
}

/**
 * The LIVE surface a mounted panel publishes for its provider
 * (`lib/find-surfaces.ts`).
 *
 * The seam does not type the payload past `kind`, on purpose: the only code
 * that reads a surface is the provider that published it, and a discriminated
 * union here would mean every new registrant edits this file — the exact
 * coupling a contribution point exists to remove. Narrow on `kind` and cast,
 * as `find-providers.ts` does.
 */
export interface FindSurface {
  readonly kind: string;
}

/** What a provider is handed on every call. */
export interface FindContext {
  /** the LIVE session id — churns on resume, never persist it */
  sessionId: string;
  /** durable key for the card this panel belongs to */
  cardId?: string;
  /** the mounted panel's published surface, or null if it has not published */
  surface: FindSurface | null;
  /** the APP's current language tag, for a provider that formats a date or a
   *  number into a hit's small print. Not the OS's — a surface that mixed the
   *  two would be quietly inconsistent with every other string on screen. */
  locale?: string;
}

/**
 * How the bar and the provider divide the work.
 *
 * `bar` — switchboard owns the term, the count, Enter/Shift+Enter and the
 *   results list; the provider only searches and reveals.
 * `delegated` — the surface HAS a find of its own and we hand off to it. Our
 *   bar does not open. §5.31 names Monaco's find specifically as a thing not
 *   to reimplement, and half-reimplementing it (our chrome, its search) would
 *   be the worse of the two options: two bars' worth of keybindings over one
 *   editor.
 */
export type FindMode = 'bar' | 'delegated';

/**
 * A find provider for one panel (§5.31, §5.23).
 *
 * `panelId` is the join to `PanelContribution.id`, which is how Ctrl+F reaches
 * "whatever the focused card is showing" without naming a single view.
 */
export interface FindProviderContribution {
  manifest: CapabilityManifest;
  /** the panel whose focused instance this provider serves */
  panelId: PanelId;
  /**
   * i18n key for the group label in the bar's count ("Session", "Terminal
   * (scrollback only)").
   *
   * REQUIRED since P2-E17-03, which is the item that started reading it: one
   * Ctrl+F now searches every `bar` registrant on the focused card and reports
   * them as separate groups (§5.31's first decision). A group with no name is
   * a number the user cannot attribute — and the label is where the depth of a
   * surface gets declared, which is why the Terminal's says "scrollback only".
   */
  labelKey: string;
  /** ascending; decides group order once the bar counts more than one view */
  order: number;
  mode: FindMode;
  /**
   * The mode for THIS surface, when one registrant can be both (#533).
   *
   * Optional, and three of the four registrants do not define it: a Session
   * view is a Session view. The document viewer is not — its header toggles
   * between rendered markdown, which our bar marks and steps, and a Monaco
   * source body, which §5.31 says to hand over whole. One panel, one provider,
   * and which body is on screen is a runtime question; `mode` is the answer
   * when this is absent or throws, so the static declaration stays the contract
   * and this is the exception it may claim.
   *
   * Read through `findMode()` (find-providers), never directly — like every
   * other predicate at this point it is called through the boundary.
   */
  modeFor?(ctx: FindContext): FindMode;
  /**
   * Why find cannot run here RIGHT NOW — an i18n key, or null when it can.
   *
   * The greyed bar's whole job is to say WHICH surface it cannot search and
   * why, so this returns a reason rather than a boolean. §5.8's rule about
   * greyed-not-hidden, applied one level down from the tab strip.
   */
  unavailableKey(ctx: FindContext): string | null;
  /** `delegated` only: open the surface's own find. False if it could not. */
  delegate?(ctx: FindContext, query: FindQuery): boolean;
  /** `bar` only: run a query. Never throws — see the point's fail-open rule. */
  search?(ctx: FindContext, query: FindQuery): Promise<FindResults>;
  /**
   * `bar` only: scroll to a hit, expanding whatever the view was hiding.
   * Returns whether it actually moved.
   *
   * `query` is the search the hit came from, handed back so a surface can
   * DECORATE what it reveals (#520 — the Session view marks the term in the
   * block it lands in, which is what the Terminal group has done through the
   * search addon since #516). A provider that only scrolls ignores it.
   */
  reveal?(ctx: FindContext, hit: FindHit, query: FindQuery): boolean;
  /** `bar` only: drop highlights when the bar closes */
  clear?(ctx: FindContext): void;
}
