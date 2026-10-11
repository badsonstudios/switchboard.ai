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
// **The shape is TABS since #1199**, one per subject, in the same single
// window. It was one scrolling column until fourteen settings had piled up in
// it. What the column was chosen for is kept: every panel is mounted the whole
// time (the inactive ones are `hidden`), so nothing a section fetched or had
// typed into it is lost by looking at another tab, and "open at a section" is
// "open on its tab".
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
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  stepSettingsSection,
  type SettingsSection,
} from '../lib/settings-sections';
import { SettingsButton } from './settings/controls';
import { ThemeSection } from './settings/ThemeSection';
import { TaskLabelSizeSection } from './settings/TaskLabelSizeSection';
import { SessionsPlacementSection } from './settings/SessionsPlacementSection';
import type { SessionsPlacement } from '../lib/sessions-placement';
import { WorkingLookSection } from './settings/WorkingLookSection';
import type { WorkingLook } from '../lib/working-look';
import { ContextMeterSection } from './settings/ContextMeterSection';
import type { ContextMeterForm } from '../lib/context-meter';
import { QuietHoursSection } from './settings/QuietHoursSection';
import { PushSection } from './settings/PushSection';
import { AdvancedSection } from './settings/AdvancedSection';
import { DispatchRetireSection } from './settings/DispatchRetireSection';
import type { DispatchRetirePolicy } from '../lib/dispatch-ephemeral';
import { DiagnosticsSection } from './settings/DiagnosticsSection';

export interface SettingsDialogProps {
  open: boolean;
  /**
   * Open on this section's tab. `null` means the tab last shown.
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
  /** where the sessions are listed (#1143). REQUIRED for `dispatchRetire`'s
   *  reason below: it is renderer state with a default of its own, so an
   *  omission could only be a caller that forgot. */
  sessionsPlacement: SessionsPlacement;
  onSetSessionsPlacement: (placement: SessionsPlacement) => void;
  /** how a working session looks in the list and on the strip (#718) */
  workingLook: WorkingLook;
  onSetWorkingLook: (look: WorkingLook) => void;
  /** how the context meter under the prompt box is drawn (#715) */
  contextMeter: ContextMeterForm;
  onSetContextMeter: (form: ContextMeterForm) => void;

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
  /** §5.15's ephemerality (#951). REQUIRED, unlike the two optional switches
   *  below: the value is renderer state with a default of its own, so there is no
   *  bridge that can be missing — an omission here would only be a caller that
   *  forgot, and a missing radio group is a setting the user cannot change. */
  dispatchRetire: DispatchRetirePolicy;
  onSetDispatchRetire: (policy: DispatchRetirePolicy) => void;
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

/** the tab last shown, for this run of the app (see `tab` below) */
let lastTab: SettingsSection = DEFAULT_SETTINGS_SECTION;

/** Tests only: a module variable outlives the test that set it. */
export function resetSettingsTabForTests(): void {
  lastTab = DEFAULT_SETTINGS_SECTION;
}

export function SettingsDialog(props: SettingsDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const ids = React.useId();

  // A LAYOUT effect, so the dialog has the keyboard in the same commit that
  // shows it (#1171). As a passive effect it ran a task later, and an Escape
  // pressed in between went to the prompt box. `lib/modal-dismiss.ts` has the
  // measurement.
  React.useLayoutEffect(() => {
    if (!props.open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

  /**
   * WHICH TAB IS SHOWING (#1199).
   *
   * It opens on the section it was asked for (a palette entry such as "Quiet
   * hours" names one), otherwise on the tab you were last on in this run, and
   * the first time on Appearance. LAST-USED rather than always the first tab:
   * settings are changed in bursts (try a theme, look, come back), and being
   * returned to the top of a different tab each time is the scroll this item
   * exists to remove.
   */
  const [tab, setTab] = React.useState<SettingsSection>(lastTab);
  const body = React.useRef<HTMLDivElement | null>(null);
  // A LAYOUT effect: the component stays mounted while the window is shut, so
  // `tab` is whatever the last opening showed. Corrected after paint, the
  // window would flash that tab before the one it was opened for.
  React.useLayoutEffect(() => {
    if (!props.open) return;
    const next = props.section ?? lastTab;
    // "the tab you were last on" includes one a palette entry took you to
    lastTab = next;
    setTab(next);
  }, [props.open, props.section]);
  // EVERY TAB STARTS AT ITS TOP. The six panels share one scroller, so without
  // this the place you had scrolled to on one tab would be where you landed on
  // the next. Before paint, so there is no jump to see.
  React.useLayoutEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [tab, props.open]);
  const choose = (next: SettingsSection): void => {
    lastTab = next;
    setTab(next);
  };
  const tabs = React.useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});

  if (!props.open) return null;

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  /**
   * One tab's panel.
   *
   * EVERY PANEL IS ALWAYS MOUNTED, and the ones not showing are `hidden`. A
   * section keeps what you typed into it when you look at another tab (the
   * credential boxes under Phone push have a Save, so there is something to
   * lose), and each one's own effects run once per opening rather than once
   * per visit. `hidden` takes it out of the tab order and the accessibility
   * tree, which is all "not showing" has to mean.
   */
  const heading = (id: SettingsSection, children: React.ReactNode): React.JSX.Element => (
    <section
      role="tabpanel"
      // a literal id is on an allow-list for a reason (two dialogs, one id);
      // these are derived from the dialog's own
      id={`${ids}-panel-${id}`}
      aria-labelledby={`${ids}-tab-${id}`}
      data-settings-section={id}
      hidden={tab !== id}
    >
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
          // ONE height for every tab (#1199): a window that grows and shrinks
          // under the pointer as you move along the tabs moves the tabs too.
          // A column of three: the title and tabs, the part that scrolls, and
          // Done. Only the middle scrolls, so the tabs and the way out are
          // always where they were.
          blockSize: 'min(640px, 84vh)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
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
            flexShrink: 0,
            borderBlockEnd: '1px solid var(--border)',
            background: 'var(--panel2)',
          }}
        >
          <div style={{ padding: '11px 16px 6px', fontSize: 13, fontWeight: 600 }}>
            {t('settings.title')}
          </div>
          {/* THE TABS (#1199). A real tab list: one tab stop, the arrow keys
              move along it (and wrap), Home and End go to the ends, and the
              panel follows the tab that has focus, which is the pattern for
              tabs whose panels are already there. */}
          <div
            role="tablist"
            // its own name: the dialog around it is already "Settings"
            aria-label={t('settings.tabsLabel')}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 2, paddingInline: 10 }}
          >
            {SETTINGS_SECTIONS.map((id) => {
              const on = tab === id;
              return (
                <button
                  key={id}
                  ref={(el) => {
                    tabs.current[id] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${ids}-tab-${id}`}
                  aria-selected={on}
                  aria-controls={`${ids}-panel-${id}`}
                  data-settings-tab={id}
                  tabIndex={on ? 0 : -1}
                  className="settings-tab"
                  onClick={() => choose(id)}
                  onKeyDown={(e) => {
                    // a chord is somebody else's shortcut, not a move along the tabs
                    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
                    const next = stepSettingsSection(
                      id,
                      e.key,
                      getComputedStyle(e.currentTarget).direction === 'rtl'
                    );
                    if (!next) return;
                    e.preventDefault();
                    choose(next);
                    tabs.current[next]?.focus();
                  }}
                >
                  {t(`settings.section.${id}`)}
                </button>
              );
            })}
          </div>
        </div>
        <div
          ref={body}
          data-settings-body
          style={{ flex: '1 1 auto', minBlockSize: 0, overflowY: 'auto' }}
        >
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
              show="theme"
              pref={props.pref}
              themes={props.themes}
              onTheme={props.onTheme}
              lang={props.lang}
              onLang={props.onLang}
            />
            <SessionsPlacementSection
              placement={props.sessionsPlacement}
              onSet={props.onSetSessionsPlacement}
            />
            <WorkingLookSection look={props.workingLook} onSet={props.onSetWorkingLook} />
            <ContextMeterSection form={props.contextMeter} onSet={props.onSetContextMeter} />
            <TaskLabelSizeSection
              size={props.taskLabelSize}
              onSet={props.onSetTaskLabelSize}
            />
          </div>
        )}

        {/* The things you set once: what language, and the two things the app
            does over the network on its own. */}
        {heading(
          'general',
          <div style={{ display: 'grid', gap: 16, padding: '14px 16px' }}>
            <ThemeSection
              show="language"
              pref={props.pref}
              themes={props.themes}
              onTheme={props.onTheme}
              lang={props.lang}
              onLang={props.onLang}
            />
            <AdvancedSection
              show="network"
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

        {/* Room is left here on purpose: what a session may do on its own
            (the autonomy defaults, the focus-stealing rule) belongs on this
            tab when it gets a control of its own. */}
        {heading(
          'sessions',
          <div style={{ display: 'grid', gap: 16, padding: '14px 16px' }}>
            <DispatchRetireSection
              policy={props.dispatchRetire}
              onSet={props.onSetDispatchRetire}
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
            <p data-settings-diagnostics-pointer style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>
              {t('settings.diagnosticsPointer')}
            </p>
          </div>
        )}

        {heading(
          'advanced',
          <div style={{ display: 'grid', gap: 16, padding: '14px 16px' }}>
            <AdvancedSection
              show="fork"
              experimentalFork={props.experimentalFork}
              onToggleExperimentalFork={props.onToggleExperimentalFork}
            />
          </div>
        )}

        </div>
        <div
          style={{
            flexShrink: 0,
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
