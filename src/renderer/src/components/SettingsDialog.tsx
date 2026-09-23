// Settings (#885) — the one place every set-it-once preference lives.
//
// **Why this exists.** `QuietHoursDialog.tsx` predicted it in its own header:
// the title bar had eleven chips and "a twelfth would be a settings screen
// assembled one control at a time by whoever shipped last, which is how a title
// bar becomes a toolbar nobody can read." Three such dialogs had accumulated by
// #877, and the bar was measurably out of room — 19 controls, 1577px of content
// in a 1009px bar, 568px of overflow at the 1024px CI uses (#879).
//
// **What moved, and what deliberately did not.** Eight controls left the bar:
// five theme buttons, two language buttons and `⑂ fork sessions`. The fast
// off-switches stayed — labels, session sounds, speak announcements,
// auto-trust, notifications — because the rule that earns a chip is "the person
// who needs it off needs it off NOW", mid screen-share, without hunting (§5.11
// litmus #4). Burying one of those would be a regression this item caused
// rather than a tidy-up.
//
// **The MCP manager is NOT here**, though it was in the "absorb the existing
// dialogs" decision. It is session-scoped and read-only — an inspector (§5.19),
// not a preference — so a global settings modal would misstate its scope, and
// absorbing it would strand `/mcp` typed in the composer (#633).
//
// **The shape is ONE SCROLLING COLUMN, not a nav/content split.** A split makes
// "open at the right section" crisper, but it also mounts one section at a
// time — and the three absorbed dialogs' e2e specs find their controls by
// `data-quiet-field` / `data-push-field` / `data-task-label-size` with the
// surface merely open. A column keeps those true, and "open at section" becomes
// a scroll, which is honest about what it is.
//
// The modal shape — scrim, click-away, focus capture, Escape — is
// `QuietHoursDialog.tsx`'s, which was `PushSetupDialog.tsx`'s, which was
// `AboutPanel.tsx`'s. Declared ONCE here now, for all of it: three near-copies
// of the same nine lines was the other half of the problem this closes.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ThemeDefinition, ThemePreference } from '../theme/theme';
import { LanguageChoice } from '../i18n';
import type { QuietState } from '../../../shared/quiet-hours';
import type { PushConfig, PushSecretKey, PushSendResult, PushService } from '../../../shared/push';
import type { TaskLabelSize } from '../../../shared/task-label-size';
import type { SettingsSection } from '../lib/settings-sections';
import { SettingsButton } from './settings/controls';
import { ThemeSection } from './settings/ThemeSection';
import { TaskLabelSizeSection } from './settings/TaskLabelSizeSection';
import { QuietHoursSection } from './settings/QuietHoursSection';
import { PushSection } from './settings/PushSection';
import { AdvancedSection } from './settings/AdvancedSection';
import { DiagnosticsSection } from './settings/DiagnosticsSection';

export interface SettingsDialogProps {
  open: boolean;
  /**
   * Scroll this section into view when the modal opens. `null` means the top.
   *
   * This is what keeps muscle memory working: `Ctrl+Shift+P` → *quiet hours*
   * still lands on the quiet-hours controls rather than on a screen where you
   * have to go and find them again.
   */
  section?: SettingsSection | null;
  onClose: () => void;

  // ── Appearance ──────────────────────────────────────────────────────────
  pref: ThemePreference;
  themes: readonly ThemeDefinition[];
  onTheme: (p: ThemePreference) => void;
  lang: LanguageChoice;
  onLang: (l: LanguageChoice) => void;
  taskLabelSize: TaskLabelSize;
  onSetTaskLabelSize: (size: TaskLabelSize) => void;

  // ── Attention ───────────────────────────────────────────────────────────
  quiet: QuietState | null;
  onSetQuietWindow: (window: { start: string; end: string } | null) => void;
  push: PushConfig | null;
  pushWrite?: { key: string; problem: string } | null;
  onSetPushPrefs: (patch: {
    push?: boolean;
    webhook?: boolean;
    service?: PushService;
    ntfyServer?: string;
  }) => void;
  onSetPushSecret: (key: PushSecretKey, value: string) => void;
  onTestPush: (channel: 'push' | 'webhook') => Promise<PushSendResult>;

  // ── Advanced ────────────────────────────────────────────────────────────
  experimentalFork: boolean;
  onToggleExperimentalFork: () => void;
  autoCheckUpdates?: boolean;
  onToggleAutoCheckUpdates?: (on: boolean) => void;
  statusPolling?: boolean;
  onToggleStatusPolling?: (on: boolean) => void;

  // ── Diagnostics (#923) ───────────────────────────────────────
  perfCapture: boolean;
  onTogglePerfCapture: (on: boolean) => void;
  /** optional for the fail-open reason the two switches above give */
  onRevealCapture?: () => void;
  hasCapture?: boolean;
}

export function SettingsDialog(props: SettingsDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const sections = React.useRef<Partial<Record<SettingsSection, HTMLElement | null>>>({});

  React.useEffect(() => {
    if (!props.open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

  /**
   * Jump to the requested section on the way in.
   *
   * `scrollIntoView` and NOT focus: moving focus to a heading would take it off
   * the dialog container, which is where the Escape handler lives, and the
   * first thing someone does to a settings screen they opened by accident is
   * press Escape. The container keeps focus; the scroll says where to look.
   */
  React.useEffect(() => {
    if (!props.open) return;
    const target = props.section ? sections.current[props.section] : null;
    // `block: 'start'` inside the scroller, not `smooth`: an animation here is
    // a race for every test that reads a position, and it buys nothing on a
    // surface you opened deliberately.
    target?.scrollIntoView?.({ block: 'start' });
  }, [props.open, props.section]);

  if (!props.open) return null;

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const heading = (id: SettingsSection, children: React.ReactNode): React.JSX.Element => (
    <section
      ref={(el) => {
        sections.current[id] = el;
      }}
      data-settings-section={id}
      style={{
        borderBlockStart: '1px solid var(--border)',
        // The header strip below is `position: sticky`, so `block: 'start'`
        // would align a section's top with the SCROLLPORT's top — which is
        // underneath it. Opening at Attention would hide the word "ATTENTION".
        scrollMarginBlockStart: 44,
      }}
    >
      <h2
        style={{
          margin: 0,
          padding: '10px 16px 0',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {t(`settings.section.${id}`)}
      </h2>
      {children}
    </section>
  );

  return (
    <div
      onMouseDown={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '8vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        style={{
          inlineSize: 'min(560px, 94vw)',
          maxBlockSize: '84vh',
          overflowY: 'auto',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          outline: 'none',
        }}
      >
        <div
          style={{
            position: 'sticky',
            insetBlockStart: 0,
            padding: '11px 16px',
            borderBlockEnd: '1px solid var(--border)',
            background: 'var(--panel2)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {t('settings.title')}
        </div>
        {/* What the screen promises, including the ONE exception to it. Every
            control here writes through on the interaction — except the
            credential boxes in Phone push, which have a Save because the value
            goes straight to the OS store and the renderer must not keep a
            second copy. Saying "nothing here has a Save button" would be a
            pleasing sentence and a lie about the one field where losing your
            input costs you something. */}
        <p style={{ margin: 0, padding: '10px 16px 0', fontSize: 11.5, color: 'var(--muted)' }}>
          {t('settings.intro')}
        </p>

        {heading(
          'appearance',
          <div style={{ display: 'grid', gap: 16, padding: '14px 16px' }}>
            <ThemeSection
              pref={props.pref}
              themes={props.themes}
              onTheme={props.onTheme}
              lang={props.lang}
              onLang={props.onLang}
            />
            <TaskLabelSizeSection
              size={props.taskLabelSize}
              onSet={props.onSetTaskLabelSize}
            />
          </div>
        )}

        {heading(
          'attention',
          <>
            <QuietHoursSection
              open={props.open}
              state={props.quiet}
              onSet={props.onSetQuietWindow}
            />
            <PushSection
              open={props.open}
              config={props.push}
              write={props.pushWrite ?? null}
              onSetPrefs={props.onSetPushPrefs}
              onSetSecret={props.onSetPushSecret}
              onTest={props.onTestPush}
            />
          </>
        )}

        {heading(
          'advanced',
          <div style={{ display: 'grid', gap: 16, padding: '14px 16px' }}>
            <AdvancedSection
              experimentalFork={props.experimentalFork}
              onToggleExperimentalFork={props.onToggleExperimentalFork}
              {...(props.autoCheckUpdates !== undefined
                ? { autoCheckUpdates: props.autoCheckUpdates }
                : {})}
              {...(props.onToggleAutoCheckUpdates
                ? { onToggleAutoCheckUpdates: props.onToggleAutoCheckUpdates }
                : {})}
              {...(props.statusPolling !== undefined
                ? { statusPolling: props.statusPolling }
                : {})}
              {...(props.onToggleStatusPolling
                ? { onToggleStatusPolling: props.onToggleStatusPolling }
                : {})}
            />
          </div>
        )}

        {heading(
          'diagnostics',
          <div style={{ display: 'grid', gap: 16, padding: '14px 16px' }}>
            <DiagnosticsSection
              perfCapture={props.perfCapture}
              onTogglePerfCapture={props.onTogglePerfCapture}
              {...(props.onRevealCapture ? { onRevealCapture: props.onRevealCapture } : {})}
              {...(props.hasCapture !== undefined ? { hasCapture: props.hasCapture } : {})}
            />
          </div>
        )}

        <div
          style={{
            position: 'sticky',
            insetBlockEnd: 0,
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '10px 16px',
            borderBlockStart: '1px solid var(--border)',
            background: 'var(--panel)',
          }}
        >
          {/* A VISIBLE WAY OUT. Every control on this screen writes through on
              the click — there is nothing to save, so Done only closes, and
              saying anything stronger would be a lie about what it does. */}
          <SettingsButton onClick={close}>{t('settings.close')}</SettingsButton>
        </div>
      </div>
    </div>
  );
}
