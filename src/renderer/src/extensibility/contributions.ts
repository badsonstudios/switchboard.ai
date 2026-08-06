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
