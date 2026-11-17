// Settings ▸ General ▸ Editor (#1608): which editor "Open folder in editor"
// uses. Detect (the default), one of the known editors, or a program of your
// own. Main stores the choice and says what it resolves to; this only shows
// it, so "Opens with" is main's answer, not a guess made here.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { chooseEditor, refreshEditor, useEditorState } from '../../lib/editor';
import { SettingItem } from './controls';

const KNOWN = ['code', 'cursor', 'zed', 'codium'] as const;

export function EditorSection(props: { open: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const state = useEditorState();
  const fieldId = React.useId();
  const [custom, setCustom] = React.useState('');
  // ask main again each time the dialog opens: an editor may have been installed
  React.useEffect(() => {
    if (props.open) void refreshEditor();
  }, [props.open]);
  React.useEffect(() => {
    setCustom(state?.customPath ?? '');
  }, [state?.customPath]);
  const choice = state?.choice ?? 'auto';
  const installed = state?.installed ?? [];
  const autoLabel =
    installed.length > 0 ? t('editor.autoFound', { name: t(`editor.${installed[0]}`) }) : state ? t('editor.autoNone') : t('editor.auto');
  return (
    <SettingItem item="editor" label={t('editor.title')} blurb={t('editor.blurb')}>
      <select
        id={`${fieldId}choice`}
        data-settings-field="editor"
        aria-label={t('editor.title')}
        value={choice}
        onChange={(e) => void chooseEditor(e.currentTarget.value, e.currentTarget.value === 'custom' ? custom : undefined)}
        style={{ maxInlineSize: 340, fontSize: 12 }}
      >
        <option value="auto">{autoLabel}</option>
        {KNOWN.map((id) => (
          <option key={id} value={id}>
            {installed.includes(id) || !state ? t(`editor.${id}`) : t('editor.notInstalled', { name: t(`editor.${id}`) })}
          </option>
        ))}
        <option value="custom">{t('editor.custom')}</option>
      </select>
      {choice === 'custom' && (
        <div style={{ display: 'grid', gap: 4 }}>
          <label htmlFor={`${fieldId}path`} style={{ fontSize: 11.5 }}>
            {t('editor.customLabel')}
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id={`${fieldId}path`}
              data-settings-field="editorPath"
              value={custom}
              onChange={(e) => setCustom(e.currentTarget.value)}
              spellCheck={false}
              style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
            />
            <button type="button" onClick={() => void chooseEditor('custom', custom.trim())} style={{ fontSize: 11 }}>
              {t('editor.save')}
            </button>
          </div>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('editor.customHint')}</span>
        </div>
      )}
      {state && (
        <span data-editor-resolved style={{ fontSize: 11, color: state.resolved ? 'var(--muted)' : 'var(--status-crashed-ink)' }}>
          {state.resolved
            ? t('editor.willOpen', { path: state.resolved })
            : choice === 'custom'
              ? t('editor.customBad')
              : t('editor.noEditor')}
        </span>
      )}
    </SettingItem>
  );
}
