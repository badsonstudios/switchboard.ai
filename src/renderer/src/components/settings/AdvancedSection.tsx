// Advanced (#885) — the experiment switch and the two outbound-network
// preferences.
//
// **The fork chip is the eighth control off the title bar, and it is the one
// that closes #879.** Theme + language came to 410px against 568px of overflow,
// which would have left ~86px still off-screen — a real reduction that does not
// actually fix the bug. `⑂ fork sessions` is 106px, the widest control on the
// bar and the one nobody needs daily, and taking it lands the row's content at
// ~983px inside a 1009px bar.
//
// ⚠️ **`chrome.tsx` argued the opposite, and the argument has to be answered
// rather than dropped.** It said an experiment leaning on undocumented CLI
// behaviour "has to be somewhere the user can reach in one click on the day it
// stops working, not behind a page that does not exist". The page exists now,
// and `Ctrl+,` is one keystroke — so the premise of that sentence is what
// changed, not the reasoning.
//
// The two network preferences came from `AboutPanel`, which said of itself that
// it had "become the one place that collects everything this app sends or
// fetches over the network" — a job it took because there was nowhere else.
// `Check for updates…` STAYS there: it performs an action against the build you
// are looking at, and that is About's own question.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { SettingCheckbox, SettingItem } from './controls';

export interface AdvancedSectionProps {
  experimentalFork: boolean;
  onToggleExperimentalFork: () => void;
  /**
   * Update checking (P2-E19-03) and provider status polling (P2-E14-07). Both
   * OPTIONAL, exactly as they were on the About panel: a broken preload bridge
   * must cost this screen nothing, which is the fail-open rule the whole
   * feature is built on.
   */
  autoCheckUpdates?: boolean;
  onToggleAutoCheckUpdates?: (on: boolean) => void;
  statusPolling?: boolean;
  onToggleStatusPolling?: (on: boolean) => void;
}

export function AdvancedSection(props: AdvancedSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      <SettingItem
        item="experimental-fork"
        label={t('settings.experimentalFork')}
        blurb={t('titlebar.forkHint')}
      >
        <SettingCheckbox
          field="experimental-fork"
          checked={props.experimentalFork}
          onChange={props.onToggleExperimentalFork}
        >
          {/* States the word ON or OFF, never colour alone (§5.32) — the same
              promise the chip made. */}
          {props.experimentalFork ? t('titlebar.forkOn') : t('titlebar.forkOff')}
        </SettingCheckbox>
      </SettingItem>

      {props.onToggleAutoCheckUpdates && (
        <SettingItem item="updates" label={t('settings.updates')}>
          <SettingCheckbox
            field="auto-check-updates"
            checked={props.autoCheckUpdates !== false}
            onChange={props.onToggleAutoCheckUpdates}
          >
            {t('about.autoCheck')}
          </SettingCheckbox>
        </SettingItem>
      )}

      {props.onToggleStatusPolling && (
        <SettingItem item="status-polling" label={t('settings.providerStatus')}>
          <SettingCheckbox
            field="status-polling"
            checked={props.statusPolling !== false}
            onChange={props.onToggleStatusPolling}
            title={t('health.settingHint')}
          >
            {t('health.setting')}
          </SettingCheckbox>
        </SettingItem>
      )}
    </>
  );
}
