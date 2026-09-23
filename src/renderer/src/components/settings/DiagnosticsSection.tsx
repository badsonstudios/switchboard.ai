// Diagnostics (#923) — E21's one switch, and the file it produces.
//
// The section exists because of a specific failure: every performance number
// this project holds was measured on the dev desktop under a synthetic 4x CPU
// throttle, never on the work laptop where the app actually bogs down. Real
// work was reverted on the strength of that proxy. So this is not a developer
// toy left in the build — it is the instrument, and the person it is for is the
// owner of the slow laptop.
//
// **Two tiers, one switch.** Long tasks, input-to-paint and main-process
// event-loop delay are always on and are not represented here at all: the
// platform measures them already, so a switch for them would offer a choice
// with nothing on the other side of it. This control governs only the expensive
// half — per-keystroke sampling, layout-read detection and block counts — and
// when it is off that half is genuinely absent rather than skipped.
//
// The blurb says what the file contains and what it does not, on the screen
// rather than in the manual, because the moment someone is deciding whether to
// switch on a thing called "capture" is the moment the answer matters.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { SettingCheckbox, SettingItem, SettingsButton } from './controls';

export interface DiagnosticsSectionProps {
  perfCapture: boolean;
  onTogglePerfCapture: (on: boolean) => void;
  /**
   * Reveal the capture file in the OS file manager.
   *
   * OPTIONAL, like the two network switches next door and for the same reason:
   * a broken preload bridge must cost this screen nothing. Absent means the row
   * is not drawn, rather than drawn and dead.
   */
  onRevealCapture?: () => void;
  /**
   * Whether a capture file exists yet. `false` greys the reveal button — and
   * unlike a switch, a button that opens a folder genuinely has nothing to do
   * before the first capture, which is a state worth showing rather than
   * hiding.
   */
  hasCapture?: boolean;
}

export function DiagnosticsSection(props: DiagnosticsSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <SettingItem
        item="perf-capture"
        label={t('settings.perfCapture')}
        blurb={t('settings.perfCaptureBlurb')}
      >
        <SettingCheckbox
          field="perf-capture"
          checked={props.perfCapture}
          onChange={props.onTogglePerfCapture}
        >
          {/* The word ON or OFF, never colour alone (§5.32). */}
          {props.perfCapture ? t('settings.perfCaptureOn') : t('settings.perfCaptureOff')}
        </SettingCheckbox>
      </SettingItem>

      {props.onRevealCapture && (
        <SettingItem
          item="perf-capture-file"
          label={t('settings.perfCaptureFile')}
          blurb={t('settings.perfCaptureFileBlurb')}
        >
          <div>
            <SettingsButton onClick={props.onRevealCapture} disabled={props.hasCapture === false}>
              {t('settings.perfCaptureReveal')}
            </SettingsButton>
          </div>
        </SettingItem>
      )}
    </>
  );
}
