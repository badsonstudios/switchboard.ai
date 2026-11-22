// "New worktree" (E42 step 2, #1506; mockup screen C in `mockups/projects.html`).
//
// The project's ＋ and Ctrl+Shift+N. One dialog: what the work is for, its
// branch (a new one from a base, or one that already exists), and whether to
// run the project's setup. "Create & start" closes it at once; main builds the
// worktree in the background, the card shows each step, and the session starts
// in it when it is ready. Nothing is made until the button is pressed.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { suggestBranch, type ProjectBranches, type NewWorktreeRequest } from '../../../shared/projects';
import type { RailProject } from '../model/types';
import { ProjectDialogFrame, dialogButton, dialogField, dialogLabel, primaryButton } from './ProjectDialogFrame';

export interface NewWorktreeDialogProps {
  project: RailProject;
  loadBranches: () => Promise<ProjectBranches | null>;
  /** what the work is for, when the dialog was opened from somewhere that knows */
  initialPurpose?: string;
  onCreate: (req: NewWorktreeRequest) => void;
  onCancel: () => void;
  onOpenSettings?: () => void;
}

/** The rules `isBranchName` keeps in main, so the button dims before main refuses. */
export function branchProblem(b: string): 'empty' | 'chars' | null {
  if (b.trim() === '') return 'empty';
  if (!/^[A-Za-z0-9_./-]+$/.test(b) || b.startsWith('-') || b.startsWith('/') || b.includes('..') || b.includes('//'))
    return 'chars';
  if (b.endsWith('/') || b.endsWith('.') || b.endsWith('.lock')) return 'chars';
  return null;
}

export function NewWorktreeDialog(props: NewWorktreeDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const { project } = props;
  const [branches, setBranches] = React.useState<ProjectBranches | null>(null);
  const [purpose, setPurpose] = React.useState(props.initialPurpose ?? '');
  const [branch, setBranch] = React.useState(props.initialPurpose ? suggestBranch(props.initialPurpose) : '');
  const [branchEdited, setBranchEdited] = React.useState(false);
  const [base, setBase] = React.useState(project.baseRef ?? '');
  const [runSetup, setRunSetup] = React.useState(true);
  const listId = React.useId();

  React.useEffect(() => {
    let live = true;
    void props
      .loadBranches()
      .catch(() => null)
      .then((b) => {
        if (!live || !b) return;
        setBranches(b);
        setBase((cur) => cur || project.baseRef || b.defaultBase || '');
      });
    return () => {
      live = false;
    };
    // read once per open
  }, []);

  const existing = !!branches?.local.includes(branch);
  // git will not check one branch out in two folders
  const checkedOut = (project.worktrees ?? []).some((w) => w.branch === branch);
  const problem = branchProblem(branch);
  const ready = problem === null && !checkedOut;
  const hasSetup = !!project.setupCommand;

  const accept = (): void => {
    if (!ready) return;
    props.onCreate({
      projectId: project.id,
      branch,
      newBranch: !existing,
      ...(!existing && base.trim() ? { base: base.trim() } : {}),
      title: purpose.trim() || branch,
      runSetup: hasSetup && runSetup,
    });
  };

  const steps: string[] = [];
  if (project.copyFiles?.length) steps.push(t('worktrees.new.stepCopy', { list: project.copyFiles.join(', ') }));
  if (project.sharedDirs?.length) steps.push(t('worktrees.new.stepShare', { list: project.sharedDirs.join(', ') }));

  const bases = [...new Set([...(branches?.defaultBase ? [branches.defaultBase] : []), ...(branches?.remote ?? []), ...(branches?.local ?? [])])];

  return (
    <ProjectDialogFrame
      testId="new-worktree-dialog"
      title={t('worktrees.new.title', { name: project.name })}
      blurb={t('worktrees.new.blurb')}
      onCancel={props.onCancel}
      onAccept={accept}
      note={
        props.onOpenSettings ? (
          <button
            type="button"
            data-new-worktree-settings
            onClick={props.onOpenSettings}
            style={{ ...dialogButton, background: 'transparent', border: 'none', padding: 0, color: 'var(--muted)', textDecoration: 'underline' }}
          >
            {t('worktrees.new.settingsLink')}
          </button>
        ) : undefined
      }
      buttons={
        <>
          <button type="button" data-new-worktree-cancel onClick={props.onCancel} style={dialogButton}>
            {t('worktrees.new.cancel')}
          </button>
          <button type="button" data-new-worktree-ok disabled={!ready} onClick={accept} style={primaryButton(ready)}>
            {t('worktrees.new.create')}
            <span style={{ fontSize: 10, color: 'var(--muted)', marginInlineStart: 6 }}>{t('worktrees.new.createKey')}</span>
          </button>
        </>
      }
    >
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={dialogLabel}>{t('worktrees.new.purpose')}</span>
        <input
          data-autofocus
          data-new-worktree-purpose
          value={purpose}
          maxLength={120}
          placeholder={t('worktrees.new.purposeHint')}
          onChange={(e) => {
            setPurpose(e.target.value);
            if (!branchEdited) setBranch(suggestBranch(e.target.value));
          }}
          style={dialogField}
        />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={dialogLabel}>{t('worktrees.new.branch')}</span>
          <input
            data-new-worktree-branch
            value={branch}
            list={`${listId}-local`}
            spellCheck={false}
            maxLength={200}
            onChange={(e) => {
              setBranch(e.target.value);
              setBranchEdited(true);
            }}
            style={{ ...dialogField, fontFamily: 'var(--font-mono)' }}
          />
          <datalist id={`${listId}-local`}>
            {(branches?.local ?? []).map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={dialogLabel}>{t('worktrees.new.base')}</span>
          <input
            data-new-worktree-base
            value={existing ? '' : base}
            disabled={existing}
            placeholder={existing ? t('worktrees.new.baseExisting') : branches ? undefined : t('worktrees.new.reading')}
            list={`${listId}-bases`}
            spellCheck={false}
            maxLength={200}
            onChange={(e) => setBase(e.target.value)}
            style={{ ...dialogField, fontFamily: 'var(--font-mono)' }}
          />
          <datalist id={`${listId}-bases`}>
            {bases.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
      </div>
      <div role="status" data-new-worktree-status style={{ fontSize: 11, color: 'var(--muted)', minBlockSize: 14 }}>
        {checkedOut
          ? t('worktrees.new.checkedOut', { branch })
          : problem === 'chars'
            ? t('worktrees.new.badBranch')
            : existing
              ? t('worktrees.new.usesExisting', { branch })
              : problem === null
                ? t('worktrees.new.makesNew', { branch, base: base || t('worktrees.new.head') })
                : null}
      </div>
      {steps.length > 0 && (
        <div data-new-worktree-steps style={{ fontSize: 11, color: 'var(--muted)' }}>
          {steps.join(' · ')}
        </div>
      )}
      {hasSetup && (
        <label style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12 }}>
          <input
            type="checkbox"
            data-new-worktree-setup
            checked={runSetup}
            onChange={(e) => setRunSetup(e.target.checked)}
            style={{ marginBlockStart: 2 }}
          />
          <span>
            {t('worktrees.new.runSetup', { command: project.setupCommand })}
            <span style={{ display: 'block', fontSize: 10.5, color: 'var(--muted)' }}>{t('worktrees.new.runSetupHint')}</span>
          </span>
        </label>
      )}
    </ProjectDialogFrame>
  );
}
