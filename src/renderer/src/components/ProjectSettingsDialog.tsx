// "Project settings" (E42 step 2, #1506; mockup screen E in `mockups/projects.html`).
//
// What a fresh worktree is missing, in three plain steps: copy small files,
// optionally share big git-ignored folders by link, then run a command. Plus
// where new worktrees start from and where they go. Saved in the app, never in
// the repo. Main checks every entry (a shared folder must be ignored by git,
// every path must stay inside the repo) and says what it would not keep; the
// dialog stays open to show that.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectBranches, ProjectSettingProblem } from '../../../shared/projects';
import type { RailProject } from '../model/types';
import { ProjectDialogFrame, dialogButton, dialogField, dialogLabel, primaryButton } from './ProjectDialogFrame';

export interface ProjectSettingsPatch {
  baseRef: string | null;
  worktreeRoot: string | null;
  copyFiles: string[];
  sharedDirs: string[];
  setupCommand: string | null;
}

export interface ProjectSettingsDialogProps {
  project: RailProject;
  /** the app-wide folder (Settings), shown as what "empty" means */
  appRoot: string | null;
  loadBranches: () => Promise<ProjectBranches | null>;
  pickFolder: () => Promise<string | null>;
  /** answers the problems main found (empty: all kept), or null when it refused */
  onSave: (patch: ProjectSettingsPatch) => Promise<ProjectSettingProblem[] | null>;
  onClose: () => void;
}

const lines = (s: string): string[] =>
  s
    .split(/\r?\n|,/)
    .map((x) => x.trim())
    .filter((x) => x !== '');

export function ProjectSettingsDialog(props: ProjectSettingsDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const { project } = props;
  const [base, setBase] = React.useState(project.baseRef ?? '');
  const [root, setRoot] = React.useState(project.worktreeRoot ?? '');
  const [copy, setCopy] = React.useState((project.copyFiles ?? []).join('\n'));
  const [share, setShare] = React.useState((project.sharedDirs ?? []).join('\n'));
  const [setup, setSetup] = React.useState(project.setupCommand ?? '');
  const [defaultBase, setDefaultBase] = React.useState<string | null>(null);
  const [bases, setBases] = React.useState<string[]>([]);
  const [problems, setProblems] = React.useState<string[]>([]);
  const word = (p: ProjectSettingProblem): string => t(`worktrees.problem.${p.code}`, { entry: p.entry ?? '' });
  const [saving, setSaving] = React.useState(false);
  const listId = React.useId();

  React.useEffect(() => {
    let live = true;
    void props
      .loadBranches()
      .catch(() => null)
      .then((b) => {
        if (!live || !b) return;
        setDefaultBase(b.defaultBase);
        setBases([...new Set([...b.remote, ...b.local])]);
      });
    return () => {
      live = false;
    };
    // read once per open
  }, []);

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    const found = await props
      .onSave({
        baseRef: base.trim() || null,
        worktreeRoot: root.trim() || null,
        copyFiles: lines(copy),
        sharedDirs: lines(share),
        setupCommand: setup.trim() || null,
      })
      .catch(() => null);
    setSaving(false);
    if (found === null) {
      setProblems([t('worktrees.settings.refused')]);
      return;
    }
    if (found.length > 0) {
      setProblems(found.map(word));
      return;
    }
    props.onClose();
  };

  const area: React.CSSProperties = { ...dialogField, fontFamily: 'var(--font-mono)', resize: 'vertical', minBlockSize: 38 };

  return (
    <ProjectDialogFrame
      testId="project-settings-dialog"
      title={t('worktrees.settings.title', { name: project.name })}
      blurb={t('worktrees.settings.blurb')}
      onCancel={props.onClose}
      onAccept={() => void save()}
      width={540}
      note={t('worktrees.settings.savedInApp')}
      buttons={
        <>
          <button type="button" data-project-settings-cancel onClick={props.onClose} style={dialogButton}>
            {t('worktrees.settings.cancel')}
          </button>
          <button
            type="button"
            data-project-settings-save
            disabled={saving}
            onClick={() => void save()}
            style={primaryButton(!saving)}
          >
            {t('worktrees.settings.save')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={dialogLabel}>{t('worktrees.settings.base')}</span>
          <input
            data-autofocus
            data-project-settings-base
            value={base}
            list={`${listId}-bases`}
            spellCheck={false}
            maxLength={200}
            placeholder={defaultBase ? t('worktrees.settings.baseDefault', { base: defaultBase }) : undefined}
            onChange={(e) => setBase(e.target.value)}
            style={{ ...dialogField, fontFamily: 'var(--font-mono)' }}
          />
          <datalist id={`${listId}-bases`}>
            {bases.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={dialogLabel}>{t('worktrees.settings.root')}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              data-project-settings-root
              aria-label={t('worktrees.settings.root')}
              value={root}
              spellCheck={false}
              placeholder={props.appRoot ?? undefined}
              onChange={(e) => setRoot(e.target.value)}
              style={{ ...dialogField, flex: 1, fontFamily: 'var(--font-mono)' }}
            />
            <button
              type="button"
              data-project-settings-browse
              onClick={() => void props.pickFolder().then((f) => f && setRoot(f))}
              style={dialogButton}
            >
              {t('worktrees.settings.browse')}
            </button>
          </div>
        </div>
      </div>

      <label style={{ display: 'grid', gap: 4 }}>
        <span style={dialogLabel}>{t('worktrees.settings.copy')}</span>
        <textarea
          data-project-settings-copy
          value={copy}
          rows={2}
          spellCheck={false}
          placeholder={t('worktrees.settings.copyHint')}
          onChange={(e) => setCopy(e.target.value)}
          style={area}
        />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={dialogLabel}>{t('worktrees.settings.share')}</span>
        <textarea
          data-project-settings-share
          value={share}
          rows={2}
          spellCheck={false}
          placeholder={t('worktrees.settings.shareHint')}
          onChange={(e) => setShare(e.target.value)}
          style={area}
        />
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t('worktrees.settings.shareNote')}</span>
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span style={dialogLabel}>{t('worktrees.settings.setup')}</span>
        <input
          data-project-settings-setup
          value={setup}
          spellCheck={false}
          maxLength={1000}
          placeholder={t('worktrees.settings.setupHint')}
          onChange={(e) => setSetup(e.target.value)}
          style={{ ...dialogField, fontFamily: 'var(--font-mono)' }}
        />
        <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t('worktrees.settings.setupNote')}</span>
      </label>

      {problems.length > 0 && (
        <div
          role="alert"
          data-project-settings-problems
          style={{
            fontSize: 11.5,
            border: '1px solid var(--control-edge)',
            borderRadius: 6,
            padding: '6px 9px',
            display: 'grid',
            gap: 2,
          }}
        >
          <span style={{ fontWeight: 600 }}>{t('worktrees.settings.problems')}</span>
          {problems.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      )}
    </ProjectDialogFrame>
  );
}
