// Git context line on a session card (P2-E7-02): the branch, from GitService.
// Nothing renders for a non-repo folder.
//
// NO DIRTY COUNT, SINCE #1145 — and that is a removal, not an omission. This
// line used to end in "·11 changed". The Changes tab, a few pixels to its left
// in the same strip, has carried that number as a badge since the source-control
// sidebar landed, so the header said it twice. The owner asked for the second
// one gone (2026-10-07). The tab's badge is the one changes count; do not put
// one back here.
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
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minInlineSize: 0 }}>
      <span
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={s.branch}
      >
        {t('git.branch', { branch: s.branch ?? '?' })}
      </span>
      {!!s.ahead && <span style={{ color: 'var(--faint)' }}>{t('git.ahead', { n: s.ahead })}</span>}
    </span>
  );
}
