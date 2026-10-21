// The announcer's voice (#1390) — Settings ▸ Notifications.
//
// Lists the OS's own voices (Chromium's `speechSynthesis`), stores the choice
// through the notification prefs the way `NeedsYouSoundSection` does, and has
// a Preview that speaks one sentence through the SAME announcer and the same
// voice lookup the real announcement uses (`lib/announcer.ts`).
//
// Everything here works with an EMPTY voice list: Chromium answers `[]` until
// `voiceschanged`, and a Linux box without speech-dispatcher stays at `[]`.
// The picker then shows only "System default". A stored voice that is not on
// this machine is shown as its own option, marked as missing, so the user can
// see why the default is speaking rather than have the choice silently vanish.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../../shared/ipc/refusal';
import {
  VoiceLike,
  listVoices,
  onVoicesChanged,
  setVoicePreference,
  sharedAnnouncer,
} from '../../lib/announcer';
import { SettingItem, SettingsButton, itemListStyle } from './controls';

export function SpeakVoiceSection(props: { open: boolean }): React.JSX.Element | null {
  const { t } = useTranslation();
  /** `undefined` until main answers; '' is the OS default */
  const [voice, setVoice] = React.useState<string | undefined>(undefined);
  const [voices, setVoices] = React.useState<VoiceLike[]>([]);
  const api = window.switchboard?.notifications;

  React.useEffect(() => {
    if (!props.open) return;
    setVoices(listVoices());
    return onVoicesChanged(() => setVoices(listVoices()));
  }, [props.open]);

  React.useEffect(() => {
    if (!props.open || !api?.getPrefs) return;
    let live = true;
    api
      .getPrefs()
      .then((raw) => {
        const p = answered(raw);
        if (live && p) setVoice(p.speakVoice ?? '');
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [props.open, api]);

  if (!props.open) return null;

  const choose = (next: string): void => {
    const before = voice ?? '';
    setVoice(next);
    // the announcer takes it at once, so Preview speaks the new voice even
    // before main has answered the write
    setVoicePreference(next);
    api
      ?.setPrefs?.({ speakVoice: next })
      .then((raw) => {
        // main's answer is what is stored; a refused write stored nothing
        const p = answered(raw);
        const stored = p ? (p.speakVoice ?? '') : before;
        setVoice(stored);
        setVoicePreference(stored);
      })
      .catch(() => {
        setVoice(before);
        setVoicePreference(before);
      });
  };

  const current = voice ?? '';
  // The stored voice is not in the list. It always gets an option of its own,
  // so the picker shows what is stored rather than snapping to the first row,
  // but it is only CALLED missing once the list has loaded: Chromium answers
  // an empty list for a moment after start, and every voice is "missing" then.
  const unlisted = current !== '' && !voices.some((v) => v.voiceURI === current || v.name === current);
  const missing = unlisted && voices.length > 0;

  return (
    <div style={itemListStyle}>
      <SettingItem item="speak-voice" label={t('speakVoice.title')} blurb={t('speakVoice.blurb')}>
        <select
          aria-label={t('speakVoice.title')}
          data-settings-field="speak-voice"
          value={current}
          disabled={voice === undefined}
          onChange={(e) => choose(e.target.value)}
          style={{
            justifySelf: 'start',
            maxInlineSize: '100%',
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
            padding: '3px 8px',
            background: 'var(--panel2)',
            color: 'var(--text)',
            border: '1px solid var(--control-edge)',
            borderRadius: 4,
          }}
        >
          <option value="">{t('speakVoice.systemDefault')}</option>
          {unlisted && (
            <option value={current} data-speak-voice-missing={missing || undefined}>
              {missing ? t('speakVoice.missing', { name: current }) : current}
            </option>
          )}
          {voices.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>
              {v.lang ? t('speakVoice.option', { name: v.name, lang: v.lang }) : v.name}
            </option>
          ))}
        </select>
        {missing && (
          <span data-speak-voice-fell-back style={{ fontSize: 11, color: 'var(--muted)' }}>
            {t('speakVoice.fellBack')}
          </span>
        )}
        <div>
          {/* The same announcer, and so the same voice lookup, as the real
              announcement; muted in the automated tests. */}
          <SettingsButton onClick={() => sharedAnnouncer().say(t('speakVoice.sample'))}>
            {t('speakVoice.preview')}
          </SettingsButton>
        </div>
      </SettingItem>
    </div>
  );
}
