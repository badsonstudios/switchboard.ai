// The busy-folder prompt (E42 step 2, #1506; mockup screen F). See
// `lib/busy-folder.ts` for when it is asked and why it never makes a worktree
// by itself: "New worktree" opens the new-worktree dialog, prefilled.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectDialogFrame, dialogButton, primaryButton } from './ProjectDialogFrame';

export interface BusyFolderDialogProps {
  /** the other sessions' names (one or more) */
  others: readonly string[];
  /** one of them is working right now */
  working: boolean;
  branch: string | null;
  dirty: number | null;
  recommendWorktree: boolean;
  onChoose: (choice: 'worktree' | 'share', remember: boolean) => void;
  onCancel: () => void;
}

export function BusyFolderDialog(props: BusyFolderDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const [remember, setRemember] = React.useState(false);
  const title =
    props.others.length === 1
      ? props.working
        ? t('worktrees.busy.titleWorking', { name: props.others[0] })
        : t('worktrees.busy.titleOne', { name: props.others[0] })
      : t('worktrees.busy.titleMany', { count: props.others.length });
  const facts = [
    props.branch ? t('worktrees.busy.onBranch', { branch: props.branch }) : null,
    props.dirty !== null ? t('worktrees.busy.dirty', { count: props.dirty }) : null,
    props.working ? t('worktrees.busy.workingNow') : null,
  ].filter((x): x is string => !!x);
  const choose = (c: 'worktree' | 'share'): void => props.onChoose(c, remember);
  const rec = props.recommendWorktree ? 'worktree' : 'share';

  const option = (c: 'worktree' | 'share'): React.JSX.Element => (
    <div style={{ display: 'flex', gap: 8, padding: '6px 9px', alignItems: 'baseline', fontSize: 12 }}>
      <b>{c === 'worktree' ? t('worktrees.busy.worktree') : t('worktrees.busy.share')}</b>
      <span style={{ flex: 1, color: 'var(--muted)', fontSize: 11 }}>
        {c === 'worktree' ? t('worktrees.busy.worktreeHint') : t('worktrees.busy.shareHint')}
      </span>
      {rec === c && <span style={{ color: 'var(--muted)', fontSize: 10.5 }}>{t('worktrees.busy.recommended')}</span>}
    </div>
  );

  return (
    <ProjectDialogFrame
      testId="busy-folder-dialog"
      title={title}
      blurb={
        <>
          {facts.length > 0 && <span style={{ display: 'block' }}>{facts.join(' · ')}</span>}
          {t('worktrees.busy.why')}
        </>
      }
      onCancel={props.onCancel}
      onAccept={() => choose(rec)}
      width={480}
      note={
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 11 }}>
          <input
            type="checkbox"
            data-busy-folder-remember
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          {t('worktrees.busy.remember')}
        </label>
      }
      buttons={
        <>
          <button
            type="button"
            data-busy-folder-share
            data-autofocus={rec === 'share' ? true : undefined}
            onClick={() => choose('share')}
            style={rec === 'share' ? primaryButton(true) : dialogButton}
          >
            {t('worktrees.busy.shareButton')}
          </button>
          <button
            type="button"
            data-busy-folder-worktree
            data-autofocus={rec === 'worktree' ? true : undefined}
            onClick={() => choose('worktree')}
            style={rec === 'worktree' ? primaryButton(true) : dialogButton}
          >
            {t('worktrees.busy.worktreeButton')}
          </button>
        </>
      }
    >
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
        {option('worktree')}
        <div style={{ borderBlockStart: '1px solid var(--border)' }}>{option('share')}</div>
      </div>
    </ProjectDialogFrame>
  );
}
