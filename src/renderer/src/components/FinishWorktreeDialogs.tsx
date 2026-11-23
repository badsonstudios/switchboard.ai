// Finishing a worktree (E42 step 3, #1638; mockup screen D): the three dialogs
// the worktree's ⋯ menu opens.
//
//   RemoveWorktreeDialog   what removing would lose, Keep the branch, then the
//                          one explicit confirm ("Remove" / "Remove anyway")
//   PullRequestDialog      title and description prefilled, draft as an option,
//                          an existing PR shown instead of a second one
//   UpdateStoppedDialog    "Update from main" stopped (conflicts, or refused
//                          with files): the files, and who resolves them
//
// Main re-checks everything; these only ask. Same frame as the other project
// dialogs, so Escape and the scrim cancel and focus goes back where it was.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  FinishRefusal,
  PullRequestContext,
  RemoveCheck,
  UpdateOutcome,
} from '../../../shared/projects';
import { PR_BODY_MAX, PR_TITLE_MAX } from '../../../shared/projects';
import { ProjectDialogFrame, dialogButton, dialogField, dialogLabel, primaryButton } from './ProjectDialogFrame';

const warnBox: React.CSSProperties = {
  border: '1px solid var(--status-crashed-ink)',
  background: 'color-mix(in srgb, var(--status-crashed-ink) 10%, var(--panel))',
  borderRadius: 6,
  padding: '7px 9px',
  fontSize: 12,
  display: 'grid',
  gap: 4,
};

const fileList: React.CSSProperties = {
  margin: 0,
  paddingInlineStart: 18,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  maxBlockSize: 140,
  overflowY: 'auto',
};

/** A refusal in words: the code's sentence, with git's or gh's own detail. */
export function refusalWords(
  t: (k: string, o?: Record<string, unknown>) => string,
  code: FinishRefusal,
  detail?: string
): string {
  return t(`worktrees.finish.refusal.${code}`, { detail: detail ?? '' });
}

// ── Remove ──────────────────────────────────────────────────────────────────

export interface RemoveWorktreeDialogProps {
  branch: string;
  load: () => Promise<RemoveCheck | null>;
  /** names of the open sessions in this worktree (they are closed first) */
  sessions: readonly string[];
  onConfirm: (opts: { force: boolean; keepBranch: boolean }) => void;
  onCancel: () => void;
}

export function RemoveWorktreeDialog(props: RemoveWorktreeDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const [check, setCheck] = React.useState<RemoveCheck | null | undefined>(undefined);
  const [keep, setKeep] = React.useState(true);
  // read once, when the dialog opens: it is keyed by its worktree, so a new one remounts
  const load = React.useRef(props.load).current;
  React.useEffect(() => {
    let live = true;
    void load()
      .catch(() => null)
      .then((c) => {
        if (!live) return;
        setCheck(c);
        // keep by default, unless git or GitHub says it is merged
        if (c) setKeep(!(c.unmerged === 0 || c.mergedPr === true));
      });
    return () => {
      live = false;
    };
  }, [load]);

  const dirty = check?.dirty ?? null;
  const isDirty = !!dirty && dirty.length > 0;
  const ready = check !== undefined && check !== null;
  const confirm = (): void => {
    if (ready) props.onConfirm({ force: isDirty || dirty === null, keepBranch: keep });
  };
  const shown = (dirty ?? []).slice(0, 6);

  return (
    <ProjectDialogFrame
      testId="remove-worktree-dialog"
      title={t('worktrees.finish.remove.title', { branch: props.branch })}
      onCancel={props.onCancel}
      width={500}
      note={
        check?.links && check.links.length > 0
          ? t('worktrees.finish.remove.links', { list: check.links.join(', ') })
          : undefined
      }
      buttons={
        <>
          <button type="button" data-autofocus onClick={props.onCancel} style={dialogButton}>
            {t('worktrees.finish.remove.cancel')}
          </button>
          <button
            type="button"
            data-remove-worktree-confirm
            disabled={!ready}
            onClick={confirm}
            style={{ ...primaryButton(ready), color: ready ? 'var(--status-crashed-ink, var(--text))' : 'var(--muted)' }}
          >
            {isDirty || dirty === null ? t('worktrees.finish.remove.removeAnyway') : t('worktrees.finish.remove.remove')}
          </button>
        </>
      }
    >
      {check === undefined && <div style={dialogLabel}>{t('worktrees.finish.remove.checking')}</div>}
      {check === null && <div role="alert">{t('worktrees.finish.remove.failed')}</div>}
      {check && (
        <div style={{ display: 'grid', gap: 9 }}>
          {(isDirty || dirty === null || (check.unmerged ?? 0) > 0) && (
            <div data-remove-worktree-warn style={warnBox}>
              {isDirty && (
                <span data-remove-worktree-dirty>
                  {t('worktrees.finish.remove.dirty', {
                    count: dirty.length,
                    files: shown.join(', ') + (dirty.length > shown.length ? ', …' : ''),
                  })}
                </span>
              )}
              {dirty === null && <span>{t('worktrees.finish.remove.dirtyUnknown')}</span>}
              {(check.unmerged ?? 0) > 0 && check.mergedPr !== true && (
                <span data-remove-worktree-unmerged>
                  {t('worktrees.finish.remove.unmerged', { count: check.unmerged, base: check.base ?? 'main' })}
                </span>
              )}
            </div>
          )}
          {check.mergedPr === true && <div style={{ fontSize: 12 }}>{t('worktrees.finish.remove.mergedPr')}</div>}
          {check.branch && (
            <label style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 12 }}>
              <input
                type="checkbox"
                data-remove-worktree-keep
                checked={keep}
                onChange={(e) => setKeep(e.target.checked)}
              />
              <span>
                {t('worktrees.finish.remove.keepBranch', { branch: check.branch })}
                <small style={{ display: 'block', color: 'var(--muted)' }}>
                  {t('worktrees.finish.remove.keepBranchHint')}
                </small>
              </span>
            </label>
          )}
          <div style={{ fontSize: 12, color: 'var(--muted)', display: 'grid', gap: 3 }}>
            {props.sessions.length > 0 && (
              <span data-remove-worktree-sessions>
                {t('worktrees.finish.remove.sessions', { names: props.sessions.join(', ') })}
              </span>
            )}
            <span>{t('worktrees.finish.remove.history')}</span>
          </div>
        </div>
      )}
    </ProjectDialogFrame>
  );
}

// ── Push & open pull request ────────────────────────────────────────────────

export interface PullRequestDialogProps {
  load: () => Promise<PullRequestContext | null>;
  initialTitle: string;
  initialBody: string;
  onSubmit: (req: { title: string; body: string; draft: boolean }) => Promise<string | null>;
  onClose: () => void;
}

export function PullRequestDialog(props: PullRequestDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const [ctx, setCtx] = React.useState<PullRequestContext | null | undefined>(undefined);
  const [title, setTitle] = React.useState(props.initialTitle);
  const [body, setBody] = React.useState(props.initialBody);
  const [draft, setDraft] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // read once, when the dialog opens: it is keyed by its worktree, so a new one remounts
  const load = React.useRef(props.load).current;
  React.useEffect(() => {
    let live = true;
    void load()
      .catch(() => null)
      .then((c) => live && setCtx(c));
    return () => {
      live = false;
    };
  }, [load]);

  const blocked = ctx ? (ctx.gh ? refusalWords(t, ctx.gh, ctx.detail) : !ctx.hasRemote ? refusalWords(t, 'no-remote') : null) : null;
  const can = !!ctx && !blocked && !ctx.existing && !busy && title.trim() !== '';
  const submit = (): void => {
    if (!can) return;
    setBusy(true);
    setError(null);
    void props
      .onSubmit({ title: title.trim(), body, draft })
      .then((err) => {
        if (err) setError(err);
      })
      .finally(() => setBusy(false));
  };

  return (
    <ProjectDialogFrame
      testId="pull-request-dialog"
      title={t('worktrees.finish.pr.title')}
      blurb={ctx ? t('worktrees.finish.pr.blurb', { branch: ctx.branch, base: ctx.base ?? 'main' }) : undefined}
      onCancel={props.onClose}
      onAccept={submit}
      width={540}
      note={busy ? t('worktrees.finish.pr.working') : undefined}
      buttons={
        <>
          <button type="button" onClick={props.onClose} style={dialogButton}>
            {ctx?.existing || blocked ? t('worktrees.finish.pr.close') : t('worktrees.finish.pr.cancel')}
          </button>
          {ctx?.existing ? (
            <button
              type="button"
              data-pr-open-existing
              data-autofocus
              disabled={busy}
              onClick={() => {
                // pushes any new commits to it first; main never opens a second PR
                setBusy(true);
                setError(null);
                void props
                  .onSubmit({ title: title.trim() || ctx.branch, body, draft })
                  .then((err) => {
                    if (err) setError(err);
                  })
                  .finally(() => setBusy(false));
              }}
              style={primaryButton(true)}
            >
              {t('worktrees.finish.pr.openExisting')}
            </button>
          ) : (
            <button type="button" data-pr-submit disabled={!can} onClick={submit} style={primaryButton(can)}>
              {t('worktrees.finish.pr.submit')}
            </button>
          )}
        </>
      }
    >
      {ctx === undefined && <div style={dialogLabel}>{t('worktrees.finish.pr.loading')}</div>}
      {ctx === null && <div role="alert">{refusalWords(t, 'no-worktree')}</div>}
      {ctx && blocked && (
        <div role="alert" data-pr-blocked style={warnBox}>
          {blocked}
        </div>
      )}
      {ctx?.existing && (
        <div data-pr-existing style={{ fontSize: 12, display: 'grid', gap: 6 }}>
          {t('worktrees.finish.pr.existing', { branch: ctx.branch, number: ctx.existing.number })}
          {error && (
            <div role="alert" data-pr-error style={warnBox}>
              {error}
            </div>
          )}
        </div>
      )}
      {ctx && !blocked && !ctx.existing && (
        <div style={{ display: 'grid', gap: 8 }}>
          <label style={{ display: 'grid', gap: 3 }}>
            <span style={dialogLabel}>{t('worktrees.finish.pr.titleLabel')}</span>
            <input
              data-autofocus
              data-pr-title
              value={title}
              maxLength={PR_TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              style={dialogField}
            />
          </label>
          <label style={{ display: 'grid', gap: 3 }}>
            <span style={dialogLabel}>{t('worktrees.finish.pr.bodyLabel')}</span>
            <textarea
              data-pr-body
              value={body}
              rows={8}
              maxLength={PR_BODY_MAX}
              onChange={(e) => setBody(e.target.value)}
              style={{ ...dialogField, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
            />
          </label>
          <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
            <input type="checkbox" data-pr-draft checked={draft} onChange={(e) => setDraft(e.target.checked)} />
            {t('worktrees.finish.pr.draft')}
          </label>
          {error && (
            <div role="alert" data-pr-error style={warnBox}>
              {error}
            </div>
          )}
        </div>
      )}
    </ProjectDialogFrame>
  );
}

// ── Update stopped ──────────────────────────────────────────────────────────

export interface UpdateStoppedDialogProps {
  branch: string;
  /** what stopped: an update from main, or a local merge into main */
  action?: 'update' | 'merge';
  outcome: Extract<UpdateOutcome, { kind: 'conflicts' | 'refused' }>;
  /** the worktree's open session, when there is one to hand the conflicts to */
  sessionName: string | null;
  onAskSession: () => void;
  onAbort: () => void;
  onClose: () => void;
}

export function UpdateStoppedDialog(props: UpdateStoppedDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const o = props.outcome;
  const conflicted = o.kind === 'conflicts' || (o.kind === 'refused' && o.code === 'merge-in-progress');
  const files = o.files ?? [];
  const title =
    o.kind === 'conflicts'
      ? t('worktrees.finish.update.conflictsTitle')
      : props.action === 'merge'
        ? t('worktrees.finish.merge.refusedTitle', { branch: props.branch })
        : t('worktrees.finish.update.refusedTitle', { branch: props.branch });
  const words =
    o.kind === 'conflicts'
      ? t('worktrees.finish.update.conflictsBody', { base: o.base, branch: props.branch })
      : refusalWords(t, o.code, o.detail);
  return (
    <ProjectDialogFrame
      testId="update-stopped-dialog"
      title={title}
      onCancel={props.onClose}
      width={520}
      note={conflicted && !props.sessionName ? t('worktrees.finish.update.noSession') : undefined}
      buttons={
        conflicted ? (
          <>
            <button type="button" data-update-abort onClick={props.onAbort} style={dialogButton}>
              {t('worktrees.finish.update.abort')}
            </button>
            <button type="button" data-update-myself onClick={props.onClose} style={dialogButton}>
              {t('worktrees.finish.update.myself')}
            </button>
            {props.sessionName && (
              <button
                type="button"
                data-autofocus
                data-update-ask-session
                onClick={props.onAskSession}
                style={primaryButton(true)}
              >
                {t('worktrees.finish.update.askSession', { name: props.sessionName })}
              </button>
            )}
          </>
        ) : (
          <button type="button" data-autofocus onClick={props.onClose} style={primaryButton(true)}>
            {t('worktrees.finish.update.close')}
          </button>
        )
      }
    >
      <div style={{ display: 'grid', gap: 7, fontSize: 12 }}>
        <span data-update-words>{words}</span>
        {files.length > 0 && (
          <ul data-update-files style={fileList}>
            {files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </div>
    </ProjectDialogFrame>
  );
}
