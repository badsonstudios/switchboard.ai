// The needs-you cue's switch (#1267) — Settings ▸ Notifications.
//
// The one notification channel that ships ON, so it is the one that most
// needs an obvious OFF. Self-contained, the way `AisSection` is: it reads and
// writes the notification prefs through the bridge itself rather than adding
// two more props to thread through the dialog. A missing bridge draws the row
// disabled rather than a box that does nothing when ticked.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { NEEDS_YOU_SOUND } from '../../../../shared/sounds';
import { answered } from '../../../../shared/ipc/refusal';
import { sharedAnnouncer } from '../../lib/announcer';
import { SettingCheckbox, SettingItem, SettingsButton, itemListStyle } from './controls';

export function NeedsYouSoundSection(props: { open: boolean }): React.JSX.Element | null {
  const { t } = useTranslation();
  /** null until main answers; the row is disabled until then */
  const [on, setOn] = React.useState<boolean | null>(null);
  const api = window.switchboard?.notifications;

  React.useEffect(() => {
    if (!props.open || !api?.getPrefs) return;
    let live = true;
    api
      .getPrefs()
      .then((raw) => {
        // a refusal is not an answer: leave the row disabled rather than guess
        const p = answered(raw);
        // absent is ON — the store's own reading of an older file
        if (live && p) setOn(p.needsYouSound !== false);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [props.open, api]);

  if (!props.open) return null;

  const set = (next: boolean): void => {
    setOn(next);
    api
      ?.setPrefs?.({ needsYouSound: next })
      .then((raw) => {
        // main's answer is what is stored; a refused write stored nothing, so
        // the box goes back rather than claiming a setting that is not saved
        const p = answered(raw);
        setOn(p ? p.needsYouSound !== false : !next);
      })
      .catch(() => setOn(!next));
  };

  return (
    <div style={itemListStyle}>
      <SettingItem
        item="needs-you-sound"
        label={t('needsYou.title')}
        blurb={t('needsYou.blurb')}
      >
        <SettingCheckbox
          field="needs-you-sound"
          checked={on === true}
          disabled={on === null}
          onChange={set}
        >
          {t('needsYou.enable')}
        </SettingCheckbox>
        <div>
          {/* Hear it before deciding. Played here in the window, the way the
              per-session cue preview is; muted in the automated tests. */}
          <SettingsButton onClick={() => sharedAnnouncer().play(NEEDS_YOU_SOUND.id)}>
            {t('needsYou.preview')}
          </SettingsButton>
        </div>
      </SettingItem>
    </div>
  );
}
