// Settings ▸ General ▸ Editor (#1608): which editor "Open folder in editor"
// uses. Detect (the default), one of the known editors, or a program of your
// own. Main stores the choice and says what it resolves to; this only shows
// it, so "Opens with" is main's answer, not a guess made here.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { chooseEditor, pickCustomEditor, refreshEditor, useEditorState } from '../../lib/editor';
import { SettingItem } from './controls';

const KNOWN = ['code', 'cursor', 'zed', 'codium'] as const;

export function EditorSection(props: { open: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const state = useEditorState();
  const fieldId = React.useId();
  // ask main again each time the dialog opens: an editor may have been installed
  React.useEffect(() => {
    if (props.open) void refreshEditor();
  }, [props.open]);
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
        onChange={(e) => void chooseEditor(e.currentTarget.value)}
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
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              type="button"
              data-settings-field="editorPick"
              onClick={() => void pickCustomEditor()}
              style={{ fontSize: 11 }}
            >
              {t('editor.pick')}
            </button>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, overflowWrap: 'anywhere' }}>
              {state?.customPath ?? ''}
            </span>
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
