// Window chrome (P1-E3-01): title bar and status bar — layout per
// design_handoff_control_room. The sessions rail outgrew this file and lives
// in ./SessionsRail.tsx (design_handoff_sessions_rail).
import React from 'react';
import { useTranslation } from 'react-i18next';
import { rendererRegistry } from '../extensibility/registry-instance';
import { listStatusBarItems } from '../extensibility/status-bar-items';
import { ContributionBoundary } from '../extensibility/boundary';
import { StatusBarContext } from '../extensibility/contributions';
import { ThemeDefinition } from '../theme/theme';
import { BuildIdentity, commitStamp } from '../../../shared/build-identity';
import type { PresentationPolicy } from '../lib/presentation-policy';
import type { LayoutMode } from '../lib/layout-mode';
import { TRUST_INERT_REASON_KEY } from '../lib/trust-reach';
import { autonomyTooltip } from '../lib/autonomy';
import type { ServiceHealthStatus } from '../../../shared/service-health';
import type { EventDto } from '../model/types';

const barStyle: React.CSSProperties = {
  background: 'var(--titlebar-bg)',
  borderBlockEnd: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  /**
   * 6, not 10, and 10 rather than 12 of inset — MEASURED, not tightened by eye.
   *
   * #885 took eight controls off this row and it fit on Windows with **19px to
   * spare**: natural content 991px in a 1010px bar (`header` children summed,
   * not `scrollWidth`, which equals `clientWidth` whenever a flex row fits and
   * so cannot show you the headroom). 19px is not a margin, it is a rounding
   * error — and the first CI run proved it, failing on **ubuntu-latest only**
   * with the document 38px wider than the window and the same 11 buttons on
   * screen. The runner's fonts are ~5% wider than this machine's, which is
   * about 57px across eleven chips, and no amount of removing controls makes a
   * row safe when it is one font substitution from overflowing.
   *
   * So the pixels come out of the WHITESPACE rather than out of another
   * control: twelve 10px gaps is 120px, 12% of the bar, in a row that is now
   * deliberately dense. 6px gaps plus the 4px of inset reclaim 52px, which puts
   * the Linux figure inside the bar instead of 38px outside it.
   *
   * `e2e/chrome.spec.ts` measures this every run and names the widest
   * overflowing element when it fails, so the next person does not have to
   * infer a subject from a bare number the way this line's author did.
   */
  gap: 6,
  paddingInline: 10,
  fontSize: 12,
  // Never give up height (#274). The window is a 100vh flex COLUMN whose main
  // area is `flex: 1` with a basis of 0, so every pixel of negative free space
  // in a short window lands on the auto-basis children — these two bars among
  // them. `minBlockSize` below floors the damage but is not the promise: it is
  // a number that happens to sit where today's text does, and it says nothing
  // about intent. This line is the promise, and always-visible-notices.test.ts
  // is what keeps it here.
  flexShrink: 0,
  minBlockSize: 34,
};

export function TitleBar(props: {
  version: string;
  /** git stamp of the running build (P2-E15-15) */
  identity: BuildIdentity;
  /** open the About panel — the full build identity */
  onOpenAbout: () => void;
  notifEnabled: boolean;
  onToggleNotif: () => void;
  autonomy: string;
  onCycleAutonomy: () => void;
  /** §5.8's presentation policy — what a submit does to the card (E9-06) */
  presentationPolicy: PresentationPolicy;
  onCyclePresentationPolicy: () => void;
  /** §5.8's layout mode — how the whole workspace is arranged (E9-07) */
  layoutMode: LayoutMode;
  /** a session is blown up to fill the workspace right now (E9-07) */
  layoutMaximized: boolean;
  onCycleLayoutMode: () => void;
  layoutBinding: string;
  autoTrust: boolean;
  onToggleTrust: () => void;
  /** whether the trust setting can change what any session does (#397) — false
   *  greys the chip out, because Direct-mode sessions are never asked */
  trustReaches: boolean;
  /**
   * Task labels, as THREE STATES ON ONE CHIP (P2-E7-06 + #758, §5.11):
   *
   *   auto  `autoLabels` on, `aiLabels` off — show the title the CLI already
   *         wrote into its transcript. Costs nothing.
   *   AI    both on — also let Claude WRITE the label from what the session has
   *         been doing, refreshed as the work drifts. Spends the subscription.
   *   off   both off — the screen-share state (§5.11, litmus #4).
   *
   * ⚠️ ONE CHIP RATHER THAN TWO, AND IT IS NOT A STYLE CALL. The bar has no
   * room: measured at the 1024px CI uses, it already overflows by **675px**
   * with ~11 controls off screen (#879, pre-existing). Adding a tenth chip for
   * #758 destabilised two geometry specs on two different CI runs — a wrapped
   * chip stealing the conversation's pixels, then an off-screen control
   * scrolling the page under a screenshot. Folding the state back into this
   * chip adds ZERO width, which is what the ticket itself proposed as the
   * alternative ("a mode on the existing auto-labels switch").
   *
   * `aiLabels` is optional so a render test that predates #758 still compiles
   * and reads as the `auto` state, which is the truth for it.
   */
  autoLabels: boolean;
  aiLabels?: boolean;
  onCycleLabels: () => void;
  /** §5.9's per-session cues (P2-E14-05a) — on, each card rings its own sound
   *  instead of everything sharing one beep */
  soundsOn: boolean;
  onToggleSounds: () => void;
  /** spoken announcements (P2-E14-05a). The handler is given the localized
   *  sample sentence to say on the way ON — `t` lives here, not in App. */
  speakOn: boolean;
  onToggleSpeak: (sample: string) => void;
  /** sessions-rail visibility — the mouse path for the Ctrl+B command (E9-01) */
  railHidden: boolean;
  onToggleRail: () => void;
  railBinding: string;
  /** the palette's mouse path (E9-02) — the ONE way in from a terminal, where
   *  no binding may fire */
  onOpenPalette: () => void;
  paletteBinding: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <header style={barStyle}>
      <strong style={{ fontWeight: 600 }}>{t('app.title')}</strong>
      <BuildStamp
        version={props.version}
        identity={props.identity}
        onOpenAbout={props.onOpenAbout}
      />
      <span style={{ flex: 1 }} />
      <Chip
        selected={false}
        onClick={props.onOpenPalette}
        title={t('titlebar.paletteHint', { binding: props.paletteBinding })}
      >
        {t('titlebar.palette')}
      </Chip>
      <Chip
        selected={!props.railHidden}
        onClick={props.onToggleRail}
        title={t('titlebar.railHint', { binding: props.railBinding })}
      >
        {t('titlebar.rail')}
      </Chip>
      {/* Folder trust. INERT unless some card will spawn on the Terminal
          (#397): Claude Code raises no trust question at all on the Direct
          transport — measured, and pinned by e2e/real-claude.spec.ts — and
          Direct is the default. `lib/trust-reach.ts` carries the argument, the
          measurement, and why the rule is workspace-wide.

          The stored value is left alone when the chip is inert. Someone who
          chose 🔒 ask trust keeps it, sees it, and gets it back the moment a
          card goes to Terminal; flipping them to auto-trust because we had
          decided the setting was pointless would be a silent change to a
          security preference on their behalf. */}
      <Chip
        selected={props.autoTrust}
        onClick={props.onToggleTrust}
        disabled={!props.trustReaches}
        title={props.trustReaches ? t('titlebar.trustHint') : t(TRUST_INERT_REASON_KEY)}
        testId="auto-trust"
      >
        {props.autoTrust ? t('titlebar.trustOn') : t('titlebar.trustOff')}
      </Chip>
      {/* Auto task labels (P2-E7-06, §5.11). A chip and not a buried setting
          for the same reason as the two below it: the thing it governs is a
          phrase derived from what you asked the agent, rendered on every card
          and pushed into OS toasts — so the person who needs it off needs it
          off NOW, mid screen-share, without hunting. */}
      {/* Three states, one chip — see the prop's note for why it is not two.
          The label states which one is current IN WORDS (§5.32), never colour
          alone, and the tooltip says what the next click does. Cheap → spends →
          neither, so the expensive state is never the one you land on by
          accident. */}
      <Chip
        selected={props.autoLabels}
        onClick={props.onCycleLabels}
        title={t(
          !props.autoLabels
            ? 'titlebar.labelsOffHint'
            : props.aiLabels
              ? 'titlebar.aiLabelsHint'
              : 'titlebar.autoLabelsHint'
        )}
        testId="auto-labels"
      >
        {!props.autoLabels
          ? t('titlebar.autoLabelsOff')
          : props.aiLabels
            ? t('titlebar.aiLabelsOn')
            : t('titlebar.autoLabelsOn')}
      </Chip>
      {/* The two audio channels (P2-E14-05a, §5.9). Chips, beside the labels
          chip and for the same reason: what they govern is NOISE in a shared
          room — the person who needs it off needs it off now, not after
          finding a settings page. Each states on/off in words, never colour
          alone (§5.32). */}
      <Chip
        selected={props.soundsOn}
        onClick={props.onToggleSounds}
        title={t('titlebar.soundsHint')}
        testId="session-sounds"
      >
        {props.soundsOn ? t('titlebar.soundsOn') : t('titlebar.soundsOff')}
      </Chip>
      <Chip
        selected={props.speakOn}
        onClick={() => props.onToggleSpeak(t('titlebar.speakSample'))}
        title={t('titlebar.speakHint')}
        testId="speak-announcements"
      >
        {props.speakOn ? t('titlebar.speakOn') : t('titlebar.speakOff')}
      </Chip>
      {/* The autonomy chip (E6-01). Its TOOLTIP carries what the mode actually
          does (#534) — the names alone never told anyone that full-auto is the
          CLI's bypassPermissions and not a gentler cousin of it, and the copy
          is shared with the composer's shield button and the card badge so
          three controls cannot give three answers. */}
      <Chip
        selected={false}
        onClick={props.onCycleAutonomy}
        title={autonomyTooltip(t, props.autonomy, 'workspace')}
        testId="titlebar-autonomy"
      >
        {t(`autonomy.${props.autonomy}`)}
      </Chip>
      {/* The GLOBAL presentation policy (E9-06, §5.8). A chip and not a buried
          setting because it changes what the workspace does on every prompt —
          "where did my card go?" has to be answerable by looking, and this is
          the answer. Per-session and per-group overrides live in the rail, next
          to the thing they override. */}
      <Chip
        selected={false}
        onClick={props.onCyclePresentationPolicy}
        title={t('policy.chipHint', { policy: t(`policy.${props.presentationPolicy}`) })}
        testId="presentation-policy"
      >
        {t('policy.chip', { policy: t(`policy.${props.presentationPolicy}`) })}
      </Chip>
      {/* The LAYOUT MODE (E9-07, §5.8). Beside the policy chip because the two
          answer neighbouring questions — that one is what happens to ONE card
          when you submit, this one is how the WHOLE workspace is arranged — and
          because "why is everything a strip all of a sudden?" has to be
          answerable by looking up, not by reading a settings page. */}
      <Chip
        /* lit for a MAXIMIZE too, even in grid: the chip's job is to answer
           "why is everything a strip all of a sudden?", and a maximize is one
           of the two ways that happens */
        selected={props.layoutMode !== 'grid' || props.layoutMaximized}
        onClick={props.onCycleLayoutMode}
        title={t('layout.chipHint', {
          mode: t(`layout.${props.layoutMode}`),
          binding: props.layoutBinding,
        })}
        testId="layout-mode"
      >
        {t(props.layoutMaximized ? 'layout.chipMaximized' : 'layout.chip', {
          mode: t(`layout.${props.layoutMode}`),
        })}
      </Chip>
      <Chip selected={props.notifEnabled} onClick={props.onToggleNotif}>
        {props.notifEnabled ? t('titlebar.notifOn') : t('titlebar.notifOff')}
      </Chip>
      {/* ⚠️ NO SETTINGS CHIP, and that is arithmetic rather than taste (#885 /
          #879). Eight controls left this row — five theme, two language, and
          `⑂ fork sessions` — which is 516px of control plus eight 10px gaps,
          and it takes the content from 1577px to ~983px inside the 1009px bar
          the CI width gives us. One chip back is ~80px with its gap, and the
          row overflows again. Settings is reached from the palette (`Ctrl+,`,
          or `▸ commands` for the mouse) and from the About panel, which the
          build stamp on the left opens. */}
    </header>
  );
}

/**
 * Version + commit, always on screen, one click from the whole story
 * (P2-E15-15). It sits where the plain `v0.1.0` label used to, because the
 * question it answers — "are these the bytes I think they are?" — has to be
 * answerable in the first five seconds, before anyone starts diagnosing a bug
 * that a rebuild would have removed.
 *
 * A button, not a label: the tooltip carries branch and build time for a hover,
 * and the click opens the full panel. The `*` is a dirty working tree.
 */
function BuildStamp(props: {
  version: string;
  identity: BuildIdentity;
  onOpenAbout: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const stamp = commitStamp(props.identity);
  return (
    <button
      onClick={props.onOpenAbout}
      title={t('titlebar.buildHint', {
        branch: props.identity.branch ?? t('about.detached'),
        builtAt: props.identity.builtAt
          ? new Date(props.identity.builtAt).toLocaleString()
          : t('about.unknown'),
      })}
      aria-label={t('titlebar.buildLabel')}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        color: 'var(--faint)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      <span>{t('titlebar.version', { version: props.version })}</span>
      {/* raw git data, not a sentence — but "unknown" IS a word, so that one
          path goes through i18n like everything else (§5.21) */}
      <span style={{ color: props.identity.dirty ? 'var(--status-needs-input-ink)' : 'var(--faint)' }}>
        {stamp ?? t('about.unknown')}
      </span>
    </button>
  );
}

export function StatusBar(props: {
  count: number;
  theme: ThemeDefinition;
  /** the provider's service health (E14-07) — the dot's whole input */
  serviceHealth?: ServiceHealthStatus | null;
  cliVersion?: string | null;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  /** §5.14's attention-queue count (P2-E14-01) — the queue's depth */
  attentionCount?: number;
  /** and the accelerator that walks it, for the readout's tooltip */
  attentionBinding?: string;
  /** the kind at the queue's head, so the bar tints like the drawer's tab */
  attentionHottest?: EventDto['kind'] | null;
}): React.JSX.Element {
  // Contributed items (§5.23): the bar owns the strip and the spacer, the
  // items own what they say. An item returning null renders nothing, which is
  // how "no usage yet" stays the item's business rather than the bar's.
  //
  // The theme arrives RESOLVED — id for the contract, name key for the label —
  // so an item never has to reach for the registry singleton to render a word.
  const ctx: StatusBarContext = { ...props, theme: props.theme.id, themeNameKey: props.theme.nameKey };
  const render = (align: 'start' | 'end'): React.JSX.Element[] =>
    listStatusBarItems(rendererRegistry, align).map((i) => (
      <ContributionBoundary key={i.manifest.id} id={i.manifest.id}>
        {i.render(ctx)}
      </ContributionBoundary>
    ));
  return (
    <footer style={{ ...barStyle, borderBlockEnd: 'none', borderBlockStart: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
      {render('start')}
      <span style={{ flex: 1 }} />
      {render('end')}
    </footer>
  );
}

export function Chip(props: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  /**
   * The chip is on screen but cannot do anything (#397). `aria-disabled` and
   * NOT the `disabled` attribute, for the reason the view tabs give in
   * SessionGrid: `disabled` takes a control out of the tab order, and the whole
   * point of leaving an inert chip on screen is that it can still be found. The
   * reason travels in `title`, which is also the element's accessible
   * DESCRIPTION once the name comes from the button's content, so assistive
   * tech reads it out; the command palette greys unmet commands out the same
   * way. (Chromium does not pop a native `title` on keyboard focus, so a
   * sighted keyboard-only user still needs the mouse to read it — the gap an
   * `aria-describedby` + visible tooltip would close, which no surface in this
   * app has yet.)
   *
   * `--muted`, not the `--faint` the palette uses: these chips state what a
   * setting currently IS, and a stored answer you can no longer read is not an
   * answer you were shown. `--faint` is a hairline-hint token and is 2.8:1 on
   * daylight by design (`theme/tokens.drift.test.ts`).
   */
  disabled?: boolean;
  /** a stable e2e handle for a chip whose LABEL is the thing under test */
  testId?: string;
  /**
   * Announce `selected` to assistive tech as well as painting it (#885).
   *
   * OPT-IN, and the reason is §5.32 rather than tidiness. Every chip on the
   * title bar states its state IN WORDS — `🏷 labels off`, `⑂ fork OFF` — so
   * `selected` there is a second, redundant signal and needs no name. The
   * theme and language pickers never did: their labels are `daylight` and
   * `pseudo`, and which one is ON is carried by the background alone. That was
   * survivable on a bar nobody reads twice; on a screen whose entire job is
   * "show me what is stored" it means a screen-reader user cannot tell which
   * theme is active.
   *
   * `aria-pressed` and NOT `role="radio"`, though the choice really is one-of-N.
   * Two reasons, and the first is the one that matters:
   *
   *  - a `role="radio"` group owes the user ARROW-KEY navigation and a roving
   *    tabindex (APG), and a radio group that does not move on ← → is worse to
   *    drive than the plain buttons it replaced. These Tab and activate, which
   *    is exactly what they look like they do;
   *  - it keeps the computed role `button`, so the fifteen
   *    `getByRole('button', { name: 'daylight' })` assertions across the e2e
   *    suite go on naming the same control.
   *
   * The one-of-N-ness is carried by the labelled `role="group"` around them.
   */
  pressed?: boolean;
}): React.JSX.Element {
  return (
    <button
      onClick={() => {
        if (!props.disabled) props.onClick();
      }}
      aria-pressed={props.pressed ? props.selected : undefined}
      aria-disabled={props.disabled ? true : undefined}
      title={props.title}
      data-testid={props.testId}
      style={{
        background: props.selected ? 'var(--chip)' : 'transparent',
        color: props.disabled ? 'var(--muted)' : 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-chip)',
        padding: '2px 9px',
        cursor: props.disabled ? 'default' : 'pointer',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
        /**
         * A CHIP LABEL NEVER WRAPS, and this is a height promise rather than a
         * typographic preference (#274's rule, one level down).
         *
         * The bar is a single nowrap flex row. It carried 19 controls and
         * overflowed by 568px at the 1024px the windows-latest runner uses,
         * until #885 took eight of them into the settings modal — so it FITS
         * now, with about 26px to spare, and `e2e/chrome.spec.ts` holds it
         * there. This rule stays anyway: 26px is not much, a longer translation
         * or one more chip eats it, and the failure mode is the nasty one
         * below. A compressed button with no `white-space` rule wraps its text
         * to a second line, and a two-line chip makes the bar taller than the
         * `minBlockSize: 34` floor above. In a short window the shell column
         * has no spare pixels, so those go straight out of the conversation,
         * which is the only flexible item left.
         *
         * That is the shape of the CI failure on #758: `feed.spec.ts`'s "a bar
         * docking on its own gives the composer its room back" wanted the feed
         * above 52px and measured 48.66px, on a run whose only renderer change
         * was one more chip in this row. Not reproducible on a dev machine,
         * because whether a label wraps at a given width is a question about the
         * runner's font metrics, not just its pixels.
         *
         * `nowrap` alone, deliberately — NOT `flexShrink: 0`. Letting the chips
         * refuse to compress would push the row's tail off screen instead, and
         * several specs assert that chips are in the viewport.
         */
        whiteSpace: 'nowrap',
      }}
    >
      {props.children}
    </button>
  );
}
