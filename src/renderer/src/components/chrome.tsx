// Window chrome (P1-E3-01): title bar, sessions rail, status bar — layout per
// design_handoff_control_room. Real identity kit / live badges arrive with
// E3-03/E3-05; rows here reflect the grid's current cards.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ThemePreference } from '../theme/theme';
import { LanguageChoice } from '../i18n';
import { IdentityChip } from './IdentityChip';
import { formatTokens, formatUsd } from '../lib/usage';
import { computeAutoGroups } from '../lib/groups';
import { uiGet, uiSet } from '../lib/ui-state';
import { getDraggedCard, setDraggedCard } from '../lib/drag-context';

const barStyle: React.CSSProperties = {
  background: 'var(--titlebar-bg)',
  borderBlockEnd: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  paddingInline: 12,
  fontSize: 12,
  minBlockSize: 34,
};

export function TitleBar(props: {
  version: string;
  pref: ThemePreference;
  onTheme: (p: ThemePreference) => void;
  lang: LanguageChoice;
  onLang: (l: LanguageChoice) => void;
  notifEnabled: boolean;
  onToggleNotif: () => void;
  autonomy: string;
  onCycleAutonomy: () => void;
  autoTrust: boolean;
  onToggleTrust: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <header style={barStyle}>
      <strong style={{ fontWeight: 600 }}>{t('app.title')}</strong>
      <span style={{ color: 'var(--faint)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
        {t('titlebar.version', { version: props.version })}
      </span>
      <span style={{ flex: 1 }} />
      <Chip selected={props.autoTrust} onClick={props.onToggleTrust}>
        {props.autoTrust ? t('titlebar.trustOn') : t('titlebar.trustOff')}
      </Chip>
      <Chip selected={false} onClick={props.onCycleAutonomy}>
        {t(`autonomy.${props.autonomy}`)}
      </Chip>
      <Chip selected={props.notifEnabled} onClick={props.onToggleNotif}>
        {props.notifEnabled ? t('titlebar.notifOn') : t('titlebar.notifOff')}
      </Chip>
      {(['system', 'nordic', 'daylight'] as const).map((p) => (
        <Chip key={p} selected={p === props.pref} onClick={() => props.onTheme(p)}>
          {t(`theme.${p}`)}
        </Chip>
      ))}
      {(['en', 'pseudo'] as const).map((l) => (
        <Chip key={l} selected={l === props.lang} onClick={() => props.onLang(l)}>
          {t(`language.${l}`)}
        </Chip>
      ))}
    </header>
  );
}

export interface RailSession {
  id: string;
  title: string;
  folder?: string;
  accent?: string;
  badge?: string;
  status?: string;
  /** persistent-group membership (E12); undefined = ungrouped */
  groupId?: string;
  /** repo/folder auto-group key (E12-05); same key = same emergent group */
  autoKey?: string;
  /** the live session under this card, when running (events map by this) */
  liveId?: string;
  /** freeform task label (shown under the title in the Events panel) */
  taskLabel?: string;
}

export interface RailGroup {
  id: string;
  name: string;
  color: string;
}

const STATUS_TOKEN: Record<string, string> = {
  starting: 'var(--status-idle)',
  working: 'var(--status-working)',
  'needs-input': 'var(--status-needs-input)',
  'needs-permission': 'var(--status-needs-permission)',
  idle: 'var(--status-idle)',
  done: 'var(--status-done)',
  crashed: 'var(--status-crashed)',
  suspended: 'var(--faint)',
};

export function SessionsRail(props: {
  sessions: RailSession[];
  groups: RailGroup[];
  onRename: (id: string, title: string) => void;
  onFocus: (id: string) => void;
  onDiff: (s: RailSession) => void;
  /** palette for the recolor cycle — persisted data owned by the main process */
  palette: string[];
  onCreateGroup: (name: string) => void;
  onRenameGroup: (id: string, name: string) => void;
  onRecolorGroup: (id: string, color: string) => void;
  onDeleteGroup: (id: string) => void;
  /** open a NEW session inside this group (E12-03) */
  onOpenInGroup: (id: string) => void;
  /** move a session between groups / to ungrouped (E12-04, rail DnD) */
  onMoveToGroup: (cardId: string, groupId: string | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState('');
  const [editingGroup, setEditingGroup] = React.useState<string | null>(null);
  const [groupDraft, setGroupDraft] = React.useState('');
  // collapsed group ids — persisted UI state (E12-08; localStorage resets
  // per launch in packaged builds because the loopback origin's port churns)
  const [collapsed, setCollapsed] = React.useState<Set<string>>(
    () => new Set(uiGet<string[]>('railCollapsed', []))
  );
  const toggleCollapsed = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      uiSet('railCollapsed', [...next]);
      return next;
    });
  };

  const DND_TYPE = 'application/x-switchboard-card';
  const sessionRow = (s: RailSession): React.JSX.Element => (
    <div
      key={s.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_TYPE, s.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => props.onFocus(s.id)}
      onDoubleClick={() => {
        setEditing(s.id);
        setDraft(s.title);
      }}
          style={{
            position: 'relative',
            padding: '6px 8px 6px 12px',
            borderRadius: 'var(--radius-chip)',
            marginBlockEnd: 2,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              position: 'absolute',
              insetInlineStart: 0,
              insetBlockStart: 0,
              insetBlockEnd: 0,
              inlineSize: 3,
              background: s.accent ?? 'var(--faint)',
              borderRadius: 2,
            }}
          />
          {editing === s.id ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditing(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  props.onRename(s.id, draft);
                  setEditing(null);
                }
                if (e.key === 'Escape') setEditing(null);
              }}
              style={{
                inlineSize: '100%',
                background: 'var(--panel2)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: 12,
                fontFamily: 'var(--font-ui)',
              }}
            />
          ) : (
            <>
              <span style={{ flex: 1, minInlineSize: 0 }}>
                <IdentityChip title={s.title} accent={s.accent} badge={s.badge} />
                {s.taskLabel && (
                  <div
                    style={{
                      color: 'var(--muted)',
                      fontSize: 9.5,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      marginBlockStart: 1,
                    }}
                  >
                    {s.taskLabel}
                  </div>
                )}
              </span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDiff(s);
                }}
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                {t('diff.open')}
              </span>
              <span
                aria-label={s.status}
                title={s.status}
                style={{
                  inlineSize: 7,
                  blockSize: 7,
                  borderRadius: '50%',
                  background: STATUS_TOKEN[s.status ?? ''] ?? 'var(--faint)',
                  flexShrink: 0,
                }}
              />
            </>
          )}
        </div>
  );

  const grouped = new Map<string, RailSession[]>();
  for (const g of props.groups) grouped.set(g.id, []);
  const ungrouped: RailSession[] = [];
  for (const s of props.sessions) {
    if (s.groupId && grouped.has(s.groupId)) grouped.get(s.groupId)!.push(s);
    else ungrouped.push(s);
  }
  // emergent repo/folder auto-groups among the ungrouped (E12-05)
  const autoGroups = computeAutoGroups(ungrouped);
  const autoMemberIds = new Set(autoGroups.flatMap((g) => g.memberIds));
  const byId = new Map(ungrouped.map((s) => [s.id, s]));
  const loose = ungrouped.filter((s) => !autoMemberIds.has(s.id));

  return (
    <nav
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DND_TYPE) || getDraggedCard()) e.preventDefault();
      }}
      onDrop={(e) => {
        // a drop on the rail background (not a group header) ungroups
        e.preventDefault();
        const cardId = e.dataTransfer.getData(DND_TYPE) || getDraggedCard();
        setDraggedCard(null);
        if (cardId) props.onMoveToGroup(cardId, null);
      }}
      style={{
        inlineSize: 200,
        background: 'var(--panel)',
        borderInlineEnd: '1px solid var(--border)',
        paddingInline: 7,
        paddingBlock: 8,
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBlockEnd: 8 }}>
        <span
          style={{
            fontSize: 9,
            letterSpacing: 1.3,
            fontWeight: 600,
            color: 'var(--faint)',
            textTransform: 'uppercase',
            flex: 1,
          }}
        >
          {t('rail.eyebrow')}
        </span>
        <button
          onClick={() => props.onCreateGroup(t('rail.newGroup'))}
          title={t('rail.addGroupHint')}
          style={railBtn}
        >
          {t('rail.addGroup')}
        </button>
      </div>
      {props.groups.map((g) => {
        const members = grouped.get(g.id) ?? [];
        const isCollapsed = collapsed.has(g.id);
        return (
          <div
            key={g.id}
            style={{
              // groups read as sections — ruled off from each other (Dan #8)
              borderBlockEnd: '1px solid var(--border)',
              marginBlockEnd: 6,
              paddingBlockEnd: 4,
            }}
          >
            <div
              onClick={() => toggleCollapsed(g.id)}
              onDragOver={(e) => {
                // accept rail-row drags (our type) AND dockview tab drags
                // (published via drag-context — Dan's E12-04 eyeball find)
                if (e.dataTransfer.types.includes(DND_TYPE) || getDraggedCard()) e.preventDefault();
              }}
              onDrop={(e) => {
                e.stopPropagation(); // don't bubble to the nav's ungroup drop
                e.preventDefault(); // claim it from dockview's own drop targets
                const cardId = e.dataTransfer.getData(DND_TYPE) || getDraggedCard();
                setDraggedCard(null);
                if (cardId) props.onMoveToGroup(cardId, g.id);
              }}
              title={isCollapsed ? t('rail.expand') : t('rail.collapse')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 4px',
                cursor: 'pointer',
                borderRadius: 'var(--radius-chip)',
              }}
            >
              <span style={{ fontSize: 8, color: 'var(--faint)', inlineSize: 8 }}>
                {isCollapsed ? '▸' : '▾'}
              </span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  if (props.palette.length === 0) return;
                  const i = props.palette.indexOf(g.color);
                  props.onRecolorGroup(g.id, props.palette[(i + 1) % props.palette.length]);
                }}
                title={t('rail.recolorGroup')}
                style={{
                  inlineSize: 8,
                  blockSize: 8,
                  borderRadius: '50%',
                  background: g.color,
                  flexShrink: 0,
                  cursor: 'pointer',
                }}
              />
              {editingGroup === g.id ? (
                <input
                  autoFocus
                  value={groupDraft}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setGroupDraft(e.target.value)}
                  onBlur={() => setEditingGroup(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      props.onRenameGroup(g.id, groupDraft);
                      setEditingGroup(null);
                    }
                    if (e.key === 'Escape') setEditingGroup(null);
                  }}
                  style={{
                    inlineSize: '100%',
                    background: 'var(--panel2)',
                    color: 'var(--text)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    fontSize: 11,
                    fontFamily: 'var(--font-ui)',
                  }}
                />
              ) : (
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingGroup(g.id);
                    setGroupDraft(g.name);
                  }}
                  title={t('rail.renameGroup')}
                  style={{
                    flex: 1,
                    minInlineSize: 0,
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--text)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {g.name}
                </span>
              )}
              {members.length > 0 && (
                <span style={{ fontSize: 9, color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                  {members.length}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  props.onOpenInGroup(g.id);
                }}
                title={t('rail.openInGroup')}
                style={{ ...railBtn, paddingInline: 3 }}
              >
                {t('rail.openInGroupIcon')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDeleteGroup(g.id);
                }}
                title={t('rail.deleteGroup')}
                style={{ ...railBtn, paddingInline: 3 }}
              >
                {t('rail.deleteGroupIcon')}
              </button>
            </div>
            {!isCollapsed && (
              <div style={{ paddingInlineStart: 10 }}>
                {members.length === 0 ? (
                  <div style={{ color: 'var(--faint)', fontSize: 10, padding: '2px 4px 6px' }}>
                    {t('rail.groupEmpty')}
                  </div>
                ) : (
                  members.map(sessionRow)
                )}
              </div>
            )}
          </div>
        );
      })}
      {autoGroups.map((ag) => {
        const key = `auto:${ag.key}`;
        const isCollapsed = collapsed.has(key);
        const name = ag.key.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ag.key;
        return (
          <div key={key}>
            <div
              onClick={() => toggleCollapsed(key)}
              title={t('rail.autoGroupHint')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 4px',
                cursor: 'pointer',
                borderRadius: 'var(--radius-chip)',
              }}
            >
              <span style={{ fontSize: 8, color: 'var(--faint)', inlineSize: 8 }}>
                {isCollapsed ? '▸' : '▾'}
              </span>
              <span
                style={{
                  inlineSize: 8,
                  blockSize: 8,
                  borderRadius: '50%',
                  border: '1px dashed var(--faint)',
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  flex: 1,
                  minInlineSize: 0,
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--muted)',
                  fontStyle: 'italic',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {name}
              </span>
              <span style={{ fontSize: 9, color: 'var(--faint)', fontFamily: 'var(--font-mono)' }}>
                {ag.memberIds.length}
              </span>
            </div>
            {!isCollapsed && (
              <div style={{ paddingInlineStart: 10 }}>
                {ag.memberIds.map((id) => byId.get(id)).filter(Boolean).map((s) => sessionRow(s!))}
              </div>
            )}
          </div>
        );
      })}
      {props.groups.length === 0 && props.sessions.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 11 }}>{t('rail.empty')}</div>
      )}
      {loose.map(sessionRow)}
    </nav>
  );
}

const railBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--faint)',
  cursor: 'pointer',
  fontSize: 10,
  fontFamily: 'var(--font-ui)',
  padding: '1px 4px',
  borderRadius: 4,
};

export function StatusBar(props: {
  count: number;
  theme: string;
  cliVersion?: string | null;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <footer style={{ ...barStyle, borderBlockEnd: 'none', borderBlockStart: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)' }}>
      <span>{t('statusbar.sessions', { count: props.count })}</span>
      {!!props.totalOutputTokens && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          {t('statusbar.usage', {
            tokens: formatTokens(props.totalOutputTokens),
            cost: formatUsd(props.totalCostUsd ?? 0),
          })}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {props.cliVersion && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          {t('preflight.version', { version: props.cliVersion })}
        </span>
      )}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>
        {t('statusbar.theme', { theme: props.theme })}
      </span>
    </footer>
  );
}

export function Chip(props: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      style={{
        background: props.selected ? 'var(--chip)' : 'transparent',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-chip)',
        padding: '2px 9px',
        cursor: 'pointer',
        fontFamily: 'var(--font-ui)',
        fontSize: 11,
      }}
    >
      {props.children}
    </button>
  );
}
