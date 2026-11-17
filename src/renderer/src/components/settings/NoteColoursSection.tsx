// Settings ▸ Appearance ▸ Note colours (#1601): a colour for the waiting note
// and one for the session note, each starting at today's colour, each with a
// way back. The words on a note are coloured for you (`inksFor`), so the
// sample beside each picker shows exactly what a note will look like.
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_NOTE_COLOURS,
  inksFor,
  setNoteColour,
  useNoteColours,
  type NoteKind,
} from '../../lib/note-colours';
import { SettingItem } from './controls';

export function NoteColoursSection(): React.JSX.Element {
  const { t } = useTranslation();
  const picked = useNoteColours();
  const fieldId = React.useId();
  const row = (kind: NoteKind): React.JSX.Element => {
    const value = picked[kind] ?? DEFAULT_NOTE_COLOURS[kind];
    const ink = picked[kind] ? inksFor(value).ink : 'var(--note-ink)';
    return (
      <div
        key={kind}
        data-note-colour-row={kind}
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
      >
        <label htmlFor={`${fieldId}${kind}`} style={{ fontSize: 11.5, minInlineSize: 110 }}>
          {t(`noteColours.${kind}`)}
        </label>
        <input
          id={`${fieldId}${kind}`}
          type="color"
          data-note-colour={kind}
          value={value}
          onChange={(e) => setNoteColour(kind, e.currentTarget.value)}
          style={{ inlineSize: 36, blockSize: 22, padding: 0, border: '1px solid var(--border)', background: 'none' }}
        />
        <span
          aria-hidden
          data-note-colour-sample={kind}
          style={{
            background: value,
            color: ink,
            fontSize: 11.5,
            padding: '2px 8px',
            borderRadius: 3,
            // the waiting note keeps its "needs you" edge whatever its colour
            borderBlockEnd: `2px solid ${kind === 'waiting' ? 'var(--status-needs-input)' : picked.session ? inksFor(value).edge : 'var(--note-paper-edge)'}`,
          }}
        >
          {t('noteColours.sample')}
        </span>
        <button
          type="button"
          data-note-colour-reset={kind}
          disabled={!picked[kind]}
          onClick={() => setNoteColour(kind, null)}
          style={{ fontSize: 11 }}
        >
          {t('noteColours.reset')}
        </button>
      </div>
    );
  };
  return (
    <SettingItem item="note-colours" label={t('noteColours.title')} blurb={t('noteColours.blurb')}>
      <div data-settings-block="note-colours" style={{ display: 'grid', gap: 8 }}>
        {row('waiting')}
        {row('session')}
      </div>
    </SettingItem>
  );
}
