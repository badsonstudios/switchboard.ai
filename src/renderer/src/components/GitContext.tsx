// Git context line on a session card (P2-E7-02): branch + dirty-count, from
// GitService. Nothing renders for a non-repo folder.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GitStatusDto } from '../lib/git-status';

export function GitContext(props: { status: GitStatusDto | null }): React.JSX.Element | null {
  const { t } = useTranslation();
  const s = props.status;
  // ⚠️ **`unreadable` DRAWS NOTHING, AND SKIPPING THAT CHECK WOULD HAVE MADE
  // THIS WORSE THAN IT WAS (#785).** The guard and status branches answer
  // `isRepo: true` with no branch and no files, so the old `!s.isRepo` test
  // alone would have let a damaged repository through to render `⎇ ?` and a
  // silent zero dirty-count — a confident wrong answer this very change
  // invented. Silence on a card header is not a wrong answer; the Changes tab
  // is where the user asked the question, and it is where the reason goes.
  if (!s || !s.isRepo || s.unreadable) return null;
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
