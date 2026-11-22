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
// Step 1 creates and deletes nothing. The ⊕ on a worktree starts a session in
// that worktree's folder through the ordinary new-session flow; making new
// worktrees is step 2 (#1506).
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { RailProject, RailSession } from '../model/types';
import type { ProjectWorktreeRows } from '../lib/groups';
import { pathKey } from '../../../shared/projects';
import { RailGroupMenu, RailGroupMenuItem } from './RailGroupMenu';

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
}

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
  const hiddenCount = (project.worktrees ?? []).filter((w) =>
    project.hiddenWorktrees.includes(pathKey(w.path))
  ).length;
  const bodyId = `project-body-${project.id}`;

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
    {
      id: 'rename',
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

  const worktreeItems = (s: ProjectWorktreeRows<RailSession>): RailGroupMenuItem[] => [
    {
      id: 'new-session',
      label: t('projects.newSessionHere'),
      can: true,
      run: () => props.onNewSessionIn(s.path),
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
        borderInlineStart: `3px solid ${project.color}`,
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
          gridTemplateColumns: 'auto auto minmax(0, 1fr) auto',
          alignItems: 'center',
          columnGap: 7,
          rowGap: 2,
          padding: '7px 9px',
          cursor: 'pointer',
          userSelect: 'none',
          borderBlockEnd: props.collapsed ? undefined : '1px solid var(--border)',
          background: `color-mix(in srgb, ${project.color} 9%, ${SURFACE})`,
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
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: project.color }} />
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
            gridColumn: '3 / 5',
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
                {s.info?.primary && (
                  <span data-worktree-primary title={t('projects.primaryHint')} style={tagStyle(false)}>
                    {t('projects.primary')}
                  </span>
                )}
                {s.info && !s.info.primary && (
                  // Every linked worktree today was made outside Switchboard:
                  // the app makes none until step 2 (#1506), which will
                  // record the ones it makes and drop this tag from them.
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
