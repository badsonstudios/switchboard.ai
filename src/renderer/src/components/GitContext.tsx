// Git context line on a session card (P2-E7-02): branch + dirty-count, from
// GitService. Nothing renders for a non-repo folder.
import React from 'react';
import { useTranslation } from 'react-i18next';

export interface GitStatusDto {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  files: Array<{ path: string; staged: boolean; unstaged: boolean; untracked: boolean }>;
}

export function GitContext(props: { status: GitStatusDto | null }): React.JSX.Element | null {
  const { t } = useTranslation();
  const s = props.status;
  if (!s || !s.isRepo) return null;
  const changed = s.files.length;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minInlineSize: 0 }}>
      <span
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={s.branch}
      >
        {t('git.branch', { branch: s.branch ?? '?' })}
      </span>
      {changed > 0 && (
        // -ink, never the raw hue: this is the dirty-file count as TEXT on the
        // card header, and the hue measured 1.80:1 there on daylight (#246,
        // the same defect #221 fixed one line up in the same header)
        <span style={{ color: 'var(--status-needs-input-ink)' }}>
          {t('git.changed', { n: changed })}
        </span>
      )}
      {!!s.ahead && <span style={{ color: 'var(--faint)' }}>{t('git.ahead', { n: s.ahead })}</span>}
    </span>
  );
}
