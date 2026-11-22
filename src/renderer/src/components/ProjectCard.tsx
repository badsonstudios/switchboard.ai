// A project's card in the Sessions list (E42 step 1, #1637; mockup screen A in
// `mockups/projects.html`).
//
// One card per repo. Inside it, one section per worktree (a branch in its own
// folder; the primary checkout is one of them), and inside each section the
// sessions working there, drawn by the rail's own row renderer so a session
// looks and behaves exactly as it does anywhere else in the list.
//
// Membership is derived from folders (`lib/groups` → `railOrder`), so nothing
// here moves a session in or out of a project: dropping sessions on the card is
// not offered, and every row keeps its own drag (reorder within its worktree).
//
// The ⊕ on a worktree starts a session in that worktree's folder through the
// ordinary new-session flow. Step 2 (#1506): the header's ＋ opens the
// new-worktree dialog, and a worktree being built shows here as a row with its
// progress, until its session starts (or it fails, and says so here, without
// touching any other session).
//
// Step 3 (#1638, mockup screen D): each worktree shows where it stands against
// the base (`↑ahead ↓behind +added −removed`), and its ⋯ menu carries the end
// of its life: Update from main, Push & open pull request…, Merge into main
// locally (only when the repo has no remote), and Remove worktree….
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RailProject, RailSession } from '../model/types';
import type { ProjectWorktreeRows } from '../lib/groups';
import { baseBranchName, pathKey, type ProjectStats, type WorktreeJob } from '../../../shared/projects';
import { RailGroupMenu, RailGroupMenuItem } from './RailGroupMenu';
import { drawnGroupColour, useGroupColours } from '../lib/group-colours';
import { useWorktreeJobs } from '../lib/worktree-jobs';

export interface ProjectCardProps {
  project: RailProject;
  sections: ReadonlyArray<ProjectWorktreeRows<RailSession>>;
  /** the rail's own rows for one bucket (pins, drag, menus and all) */
  renderRows: (members: readonly RailSession[], bucket: string, surface: string) => React.JSX.Element[];
  collapsed: boolean;
  onToggle: () => void;
  needing: ReadonlySet<string>;
  palette: readonly string[];
  /** start a session in this folder (the ordinary flow: it asks for a name) */
  onNewSessionIn: (folder: string) => void;
  onRename: (name: string) => void;
  onRecolor: (color: string) => void;
  onSetHidden: (hiddenWorktrees: string[]) => void;
  onRemove: () => void;
  // ── step 2 (#1506) ──
  /** this project's worktree builds */
  jobs?: readonly WorktreeJob[];
  onNewWorktree?: () => void;
  onSettings?: () => void;
  /** "Open folder in editor" on a worktree; absent when no editor resolves */
  onOpenInEditor?: (folder: string) => void;
  onStartJob?: (jobId: string) => void;
  onDismissJob?: (jobId: string) => void;
  onDiscardJob?: (jobId: string) => void;
  // ── step 3 (#1638) ──
  /** ahead/behind and line counts per worktree, and whether the repo has a remote */
  stats?: ProjectStats | null;
  onUpdateWorktree?: (folder: string) => void;
  onOpenPr?: (folder: string) => void;
  onMergeLocal?: (folder: string) => void;
  onRemoveWorktree?: (folder: string) => void;
}

/** How far along each step is, for the bar under a worktree being built. */
const STEP_SHARE: Partial<Record<WorktreeJob['phase'], number>> = {
  creating: 20,
  copying: 45,
  linking: 60,
  setup: 75,
  ready: 100,
};

const SURFACE = 'var(--rail-card)';

/** "C:/Projects/sb-wt-1" → "sb-wt-1" */
function leaf(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

const tagStyle = (dashed: boolean): React.CSSProperties => ({
  fontFamily: 'var(--font-ui)',
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: '0.05em',
  lineHeight: 1,
  padding: '2px 3px',
  borderRadius: 3,
  border: `1px ${dashed ? 'dashed' : 'solid'} var(--muted)`,
  color: 'var(--muted)',
  flexShrink: 0,
});

export function ProjectCard(props: ProjectCardProps): React.JSX.Element {
  const { t } = useTranslation();
  const { project } = props;
  // a project's colour is the user's choice, like a group's: it follows
  // Settings > Appearance > Group colours (#1637 review)
  const color = drawnGroupColour('group', project.color, useGroupColours());
  const [menu, setMenu] = React.useState<{
    x: number;
    y: number;
    label: string;
    items: RailGroupMenuItem[];
  } | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(project.name);

  const members = props.sections.flatMap((s) => s.members);
  const needHere = members.filter((m) => props.needing.has(m.id)).length;
  const worktreeCount = props.sections.filter((s) => s.info).length;
  // only the hidden ones actually left out: a hidden worktree with a session
  // in it is still drawn, so "Show N hidden" must not promise it
  const shown = new Set(props.sections.map((s) => pathKey(s.path)));
  const hiddenCount = (project.worktrees ?? []).filter(
    (w) => project.hiddenWorktrees.includes(pathKey(w.path)) && !shown.has(pathKey(w.path))
  ).length;
  const bodyId = `project-body-${project.id}`;
  const made = new Set(project.made ?? []);
  const allJobs = useWorktreeJobs();
  const jobs = props.jobs ?? allJobs.filter((j) => j.projectId === project.id);

  const openMenuAt = (
    e: React.MouseEvent<HTMLElement>,
    label: string,
    items: RailGroupMenuItem[]
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    // a keyboard-opened menu carries no pointer: anchor to the control
    const kb = e.clientX === 0 && e.clientY === 0;
    setMenu({ x: kb ? box.left : e.clientX, y: kb ? box.bottom : e.clientY, label, items });
  };

  const projectItems = (): RailGroupMenuItem[] => [
    ...(props.onNewWorktree
      ? [{ id: 'new-worktree', label: t('worktrees.menu.new'), can: true, run: props.onNewWorktree }]
      : []),
    ...(props.onSettings
      ? [{ id: 'settings', label: t('worktrees.menu.settings'), can: true, run: props.onSettings }]
      : []),
    {
      id: 'rename',
      divider: !!(props.onNewWorktree || props.onSettings),
      label: t('projects.rename'),
      can: true,
      run: () => {
        setDraft(project.name);
        setEditing(true);
      },
    },
    ...(hiddenCount > 0
      ? [
          {
            id: 'show-hidden',
            label: t('projects.showHidden', { count: hiddenCount }),
            can: true,
            divider: true,
            run: () => props.onSetHidden([]),
          },
        ]
      : []),
    {
      id: 'remove',
      label: t('projects.remove'),
      can: true,
      divider: hiddenCount === 0,
      run: props.onRemove,
    },
  ];

  const statsFor = (folder: string) => props.stats?.worktrees.find((w) => pathKey(w.path) === pathKey(folder));
  const baseName = props.stats?.base ? baseBranchName(props.stats.base) : 'main';

  /** Update / PR / local merge / remove (#1638): only for a worktree on a branch git can see. */
  const finishItems = (s: ProjectWorktreeRows<RailSession>): RailGroupMenuItem[] => {
    const info = s.info;
    if (!info || !props.onUpdateWorktree) return [];
    const onBranch = !!info.branch && !info.prunable;
    const behind = statsFor(s.path)?.behind;
    const noRemote = props.stats?.hasRemote === false;
    return [
      {
        id: 'update',
        divider: true,
        label: t('worktrees.finish.menu.update', { base: baseName }),
        ...(behind ? { hint: t('worktrees.finish.menu.behind', { n: behind }) } : {}),
        // the primary checkout is on main itself: nothing to update it from
        can: onBranch && !(info.primary && info.branch === baseName),
        run: () => props.onUpdateWorktree?.(s.path),
      },
      ...(props.onOpenPr && !noRemote
        ? [
            {
              id: 'pr',
              label: t('worktrees.finish.menu.pr'),
              can: onBranch && !info.primary,
              run: () => props.onOpenPr?.(s.path),
            },
          ]
        : []),
      ...(props.onMergeLocal && noRemote
        ? [
            {
              id: 'merge-local',
              label: t('worktrees.finish.menu.mergeLocal', { base: baseName }),
              hint: t('worktrees.finish.menu.mergeLocalHint'),
              can: onBranch && !info.primary,
              run: () => props.onMergeLocal?.(s.path),
            },
          ]
        : []),
      ...(props.onRemoveWorktree && !info.primary
        ? [
            {
              id: 'remove-worktree',
              divider: true,
              danger: true,
              label: t('worktrees.finish.menu.remove'),
              can: true,
              run: () => props.onRemoveWorktree?.(s.path),
            },
          ]
        : []),
    ];
  };

  const worktreeItems = (s: ProjectWorktreeRows<RailSession>): RailGroupMenuItem[] => [
    {
      id: 'new-session',
      label: t('projects.newSessionHere'),
      // git says a prunable worktree's folder is gone: nothing to start in
      can: !s.info?.prunable,
      run: () => props.onNewSessionIn(s.path),
    },
    {
      id: 'open-editor',
      label: t('worktrees.menu.openInEditor'),
      can: !!props.onOpenInEditor && !s.info?.prunable,
      run: () => props.onOpenInEditor?.(s.path),
    },
    {
      id: 'hide',
      label: t('projects.hide'),
      // the primary checkout is the project; a worktree with sessions in it
      // would only reappear, because a session is never hidden
      can: !!s.info && !s.info.primary && s.members.length === 0,
      run: () =>
        props.onSetHidden([...new Set([...project.hiddenWorktrees, pathKey(s.path)])]),
    },
    ...finishItems(s),
  ];

  const commitRename = (): void => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== project.name) props.onRename(name);
  };

  return (
    <div
      data-project-card={project.id}
      style={{
        background: SURFACE,
        border: '1px solid var(--group-frame)',
        borderInlineStart: `3px solid ${color}`,
        borderRadius: 8,
        boxShadow: 'var(--group-lift)',
        marginBlockEnd: 9,
      }}
    >
      <div
        data-project-header
        onClick={props.onToggle}
        onContextMenu={(e) => openMenuAt(e, t('projects.menuLabel', { name: project.name }), projectItems())}
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto auto minmax(0, 1fr) auto auto',
          alignItems: 'center',
          columnGap: 7,
          rowGap: 2,
          padding: '7px 9px',
          cursor: 'pointer',
          userSelect: 'none',
          borderBlockEnd: props.collapsed ? undefined : '1px solid var(--border)',
          background: `color-mix(in srgb, ${color} 9%, ${SURFACE})`,
          borderStartEndRadius: 7,
          borderEndEndRadius: props.collapsed ? 7 : 0,
        }}
      >
        <button
          className="rail-x"
          aria-expanded={!props.collapsed}
          aria-controls={bodyId}
          aria-label={project.name}
          onClick={(e) => {
            e.stopPropagation();
            props.onToggle();
          }}
          style={{ fontSize: 8, width: 12, transform: props.collapsed ? 'rotate(-90deg)' : undefined }}
        >
          {t('projects.caret')}
        </button>
        <button
          className="rail-x"
          data-project-colour
          // the group dot's gesture (E12): click to move to the next colour
          title={t('rail.recolorGroup')}
          aria-label={t('rail.recolorGroup')}
          onClick={(e) => {
            e.stopPropagation();
            if (props.palette.length === 0) return;
            const i = props.palette.indexOf(project.color.toLowerCase());
            props.onRecolor(props.palette[(i + 1) % props.palette.length]);
          }}
          style={{ width: 12, display: 'grid', placeItems: 'center' }}
        >
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: color }} />
        </button>
        {editing ? (
          <input
            autoFocus
            data-project-rename
            value={draft}
            maxLength={60}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') setEditing(false);
            }}
            style={{ font: 'inherit', fontWeight: 600, minWidth: 0 }}
          />
        ) : (
          <span
            data-project-name
            title={t('projects.renameHint', { name: project.name })}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraft(project.name);
              setEditing(true);
            }}
            style={{
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {project.name}
          </span>
        )}
        {props.onNewWorktree ? (
          <button
            className="rail-x"
            data-project-new-worktree
            title={t('worktrees.newButtonHint')}
            aria-label={t('worktrees.newButtonHint')}
            onClick={(e) => {
              e.stopPropagation();
              props.onNewWorktree?.();
            }}
            style={{ fontSize: 12 }}
          >
            {t('worktrees.newButton')}
          </button>
        ) : (
          <span />
        )}
        <button
          className="rail-x"
          data-project-menu
          title={t('projects.menuButton')}
          aria-label={t('projects.menuButton')}
          aria-haspopup="menu"
          onClick={(e) => openMenuAt(e, t('projects.menuLabel', { name: project.name }), projectItems())}
          style={{ fontSize: 12, letterSpacing: 1 }}
        >
          {t('projects.moreIcon')}
        </button>
        <span
          style={{
            gridColumn: '3 / 6',
            fontSize: 10.5,
            color: 'var(--muted)',
            display: 'flex',
            gap: 8,
            minWidth: 0,
          }}
        >
          <span>{t('projects.counts', { worktrees: worktreeCount, sessions: members.length })}</span>
          {needHere > 0 && (
            <span data-project-need style={{ color: 'var(--status-needs-ink, var(--muted))' }}>
              {t('urgency.needYou', { n: needHere })}
            </span>
          )}
        </span>
      </div>

      <div id={bodyId} hidden={props.collapsed} style={{ padding: '3px 4px 4px' }}>
        {project.worktrees === null && (
          <div style={{ padding: '4px 7px', fontSize: 11, color: 'var(--muted)' }}>
            {t('projects.unreadable')}
          </div>
        )}
        {props.sections.map((s, i) => {
          const name = s.info
            ? s.info.branch ?? t('projects.detached', { head: (s.info.head ?? '').slice(0, 7) })
            : t('projects.unplaced');
          return (
            <div
              key={s.bucket}
              data-project-worktree={s.path || 'unplaced'}
              style={{ borderBlockStart: i === 0 ? undefined : '1px dashed var(--border)', paddingBlock: 2 }}
            >
              <div
                onContextMenu={(e) =>
                  s.info
                    ? openMenuAt(e, t('projects.worktreeMenuLabel', { name }), worktreeItems(s))
                    : undefined
                }
                title={s.info ? s.path : t('projects.unplacedHint')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 5px 2px',
                  fontSize: 11,
                }}
              >
                <span
                  data-worktree-branch
                  style={{
                    fontFamily: s.info ? 'var(--font-mono)' : 'var(--font-ui)',
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: s.info ? undefined : 'var(--muted)',
                  }}
                >
                  {name}
                  {s.info && !s.info.primary && s.info.branch && leaf(s.path) !== s.info.branch && (
                    <span style={{ color: 'var(--muted)' }}>
                      {t('projects.folderSuffix', { folder: leaf(s.path) })}
                    </span>
                  )}
                </span>
                {s.info && <WorktreeNumbers stats={statsFor(s.path)} base={props.stats?.base ?? null} />}
                {s.info?.primary && (
                  <span data-worktree-primary title={t('projects.primaryHint')} style={tagStyle(false)}>
                    {t('projects.primary')}
                  </span>
                )}
                {s.info && !s.info.primary && !made.has(pathKey(s.path)) && (
                  // made outside Switchboard: the ones the app made are
                  // recorded on the project (#1506) and go without the tag
                  <span data-worktree-found title={t('projects.foundHint')} style={tagStyle(true)}>
                    {t('projects.found')}
                  </span>
                )}
                {s.info && (
                  <>
                    <button
                      className="rail-x"
                      data-worktree-new-session
                      title={t('projects.newSessionHere')}
                      aria-label={t('projects.newSessionHere')}
                      disabled={!!s.info.prunable}
                      onClick={() => props.onNewSessionIn(s.path)}
                      style={{ fontSize: 10 }}
                    >
                      {t('projects.newSessionHereIcon')}
                    </button>
                    <button
                      className="rail-x"
                      data-worktree-menu
                      title={t('projects.worktreeMenuButton')}
                      aria-label={t('projects.worktreeMenuButton')}
                      aria-haspopup="menu"
                      onClick={(e) => openMenuAt(e, t('projects.worktreeMenuLabel', { name }), worktreeItems(s))}
                      style={{ fontSize: 11 }}
                    >
                      {t('projects.moreIcon')}
                    </button>
                  </>
                )}
              </div>
              {s.members.length > 0 ? (
                <div style={{ paddingInlineStart: 8 }}>{props.renderRows(s.members, s.bucket, SURFACE)}</div>
              ) : (
                <div
                  data-worktree-empty
                  style={{ padding: '2px 7px 5px 13px', fontSize: 11, color: 'var(--muted)', fontStyle: 'italic' }}
                >
                  {t('projects.emptyWorktree')}
                </div>
              )}
            </div>
          );
        })}
        {jobs.map((j) => (
          <JobRow
            key={j.id}
            job={j}
            onStart={() => props.onStartJob?.(j.id)}
            onDismiss={() => props.onDismissJob?.(j.id)}
            onDiscard={() => props.onDiscardJob?.(j.id)}
          />
        ))}
      </div>

      {menu && (
        <RailGroupMenu
          x={menu.x}
          y={menu.y}
          label={menu.label}
          items={menu.items}
          testId="project-menu"
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * `↑2 ↓3 +120 −8` beside a worktree's branch (#1638). Zeros are left out, and
 * so is anything git could not say: no number beats a wrong one.
 */
function WorktreeNumbers(props: {
  stats: ProjectStats['worktrees'][number] | undefined;
  base: string | null;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const s = props.stats;
  if (!s || !props.base) return null;
  const ab = (s.ahead ?? 0) > 0 || (s.behind ?? 0) > 0;
  const lines = (s.added ?? 0) > 0 || (s.removed ?? 0) > 0;
  if (!ab && !lines) return null;
  return (
    <span
      data-worktree-numbers
      title={t('worktrees.finish.stats.hint', {
        ahead: s.ahead ?? 0,
        behind: s.behind ?? 0,
        added: s.added ?? 0,
        removed: s.removed ?? 0,
        base: props.base,
      })}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--muted)',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        display: 'inline-flex',
        gap: 5,
      }}
    >
      {ab && <span data-worktree-ahead-behind>{t('worktrees.finish.stats.aheadBehind', { ahead: s.ahead ?? 0, behind: s.behind ?? 0 })}</span>}
      {lines && <span data-worktree-lines>{t('worktrees.finish.stats.lines', { added: s.added ?? 0, removed: s.removed ?? 0 })}</span>}
    </span>
  );
}

/** A worktree being built (mockup screen A, the row at the bottom). */
function JobRow(props: {
  job: WorktreeJob;
  onStart: () => void;
  onDismiss: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { job } = props;
  const failed = job.phase === 'failed' || job.phase === 'setup-failed';
  const share = STEP_SHARE[job.phase];
  const words =
    job.phase === 'setup' && job.detail
      ? t('worktrees.job.setupLine', { line: job.detail })
      : job.phase === 'failed'
        ? t('worktrees.job.failed', { detail: job.detail ?? '' })
        : job.phase === 'setup-failed'
          ? t('worktrees.job.setupFailed', { detail: job.detail ?? '' })
          : t(`worktrees.job.${job.phase}`);
  const warnings = job.warnings.map((w) => t(`worktrees.warning.${w.code}`, { entry: w.entry }));
  const link: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid var(--control-edge)',
    borderRadius: 4,
    color: 'var(--text)',
    fontSize: 10.5,
    padding: '1px 6px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
  };
  return (
    <div
      data-worktree-job={job.phase}
      title={job.path}
      style={{ borderBlockStart: '1px dashed var(--border)', padding: '4px 5px 5px', fontSize: 11 }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {job.branch}
        </span>
        <span
          role="status"
          data-worktree-job-words
          style={{
            color: failed ? 'var(--status-crashed-ink, var(--muted))' : 'var(--muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: failed ? 'normal' : 'nowrap',
            flex: 1,
            minWidth: 0,
          }}
        >
          {words}
        </span>
      </div>
      {share !== undefined && (
        <div
          aria-hidden
          style={{ height: 3, background: 'var(--panel2)', borderRadius: 2, margin: '4px 1px 0', overflow: 'hidden' }}
        >
          <div style={{ height: '100%', width: `${share}%`, background: 'var(--status-working)' }} />
        </div>
      )}
      {warnings.length > 0 && (
        <div data-worktree-job-warnings style={{ color: 'var(--muted)', marginBlockStart: 3, display: 'grid', gap: 1 }}>
          {warnings.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
      )}
      {failed && (
        <div style={{ display: 'flex', gap: 5, marginBlockStart: 4, flexWrap: 'wrap' }}>
          {job.phase === 'setup-failed' && (
            <button type="button" data-worktree-job-start onClick={props.onStart} style={link}>
              {t('worktrees.job.startAnyway')}
            </button>
          )}
          <button type="button" data-worktree-job-dismiss onClick={props.onDismiss} style={link}>
            {job.phase === 'setup-failed' ? t('worktrees.job.keep') : t('worktrees.job.dismiss')}
          </button>
          {job.phase === 'setup-failed' && (
            <button type="button" data-worktree-job-discard onClick={props.onDiscard} style={link}>
              {t('worktrees.job.discard')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
