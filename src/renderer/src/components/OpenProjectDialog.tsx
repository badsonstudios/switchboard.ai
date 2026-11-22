// "Open project" (E42 step 1, #1637; mockup screen B in `mockups/projects.html`).
//
// Pick a repo folder; main answers what it is as a project (its worktrees, and
// whether it is already open). Opening starts no session and moves nothing:
// sessions already working in the repo show under the project because
// membership is derived from their folders, which is what the "N open sessions
// move into the project" line says out loud.
//
// The same modal contract as `NameSessionDialog`: the modal layer, Escape and a
// click on the scrim cancel, focus goes back where it came from.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useModalLayer } from '../lib/modal-layer';
import { pathKey, type ProjectInspection } from '../../../shared/projects';

export interface OpenProjectDialogProps {
  /** main's folder picker; null when the user cancelled it */
  pickFolder: () => Promise<string | null>;
  inspect: (folder: string) => Promise<ProjectInspection | null>;
  /** session folders' repo keys, to count the sessions that will show under it */
  sessionRepoKeys: readonly (string | undefined)[];
  /** names of projects already open, by id, for the "already open" line */
  projectNames: ReadonlyMap<string, string>;
  /** Open (or Show, for a repo that already is a project) */
  onConfirm: (folder: string, name: string) => void;
  onCancel: () => void;
}

type Found =
  | { state: 'none' }
  | { state: 'reading'; folder: string }
  | { state: 'not-repo'; folder: string }
  | { state: 'repo'; folder: string; info: ProjectInspection };

export function OpenProjectDialog(props: OpenProjectDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const { top, lift } = useModalLayer(true, dialog);
  const [found, setFound] = React.useState<Found>({ state: 'none' });
  const [name, setName] = React.useState('');
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const asked = React.useRef(0);

  React.useLayoutEffect(() => {
    const doc = dialog.current?.ownerDocument ?? document;
    returnFocusTo.current = doc.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, []);

  const browse = async (): Promise<void> => {
    const folder = await props.pickFolder().catch(() => null);
    if (!folder) return;
    const seq = ++asked.current;
    setFound({ state: 'reading', folder });
    // fail-open: a failed read is "not a repo", never a stuck dialog
    const info = await props.inspect(folder).catch(() => null);
    if (seq !== asked.current) return; // a later pick overtook this one
    if (!info) {
      setFound({ state: 'not-repo', folder });
      return;
    }
    setFound({ state: 'repo', folder, info });
    setName(info.existingProjectId ? props.projectNames.get(info.existingProjectId) ?? info.suggestedName : info.suggestedName);
  };

  const cancel = (): void => {
    const view = dialog.current?.ownerDocument.defaultView ?? window;
    props.onCancel();
    const el = returnFocusTo.current;
    view.requestAnimationFrame(() => el?.focus?.());
  };

  const existing = found.state === 'repo' ? found.info.existingProjectId : undefined;
  const ready = found.state === 'repo' && (!!existing || name.trim().length > 0);
  const accept = (): void => {
    if (found.state === 'repo' && ready) props.onConfirm(found.folder, name.trim());
  };
  const sessionsHere =
    found.state === 'repo'
      ? props.sessionRepoKeys.filter((k) => k === pathKey(found.info.commonDir)).length
      : 0;

  const button: React.CSSProperties = {
    background: 'var(--chip)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-chip)',
    padding: '4px 12px',
    cursor: 'pointer',
    fontFamily: 'var(--font-ui)',
    fontSize: 11.5,
  };
  const field: React.CSSProperties = {
    background: 'var(--panel2)',
    color: 'var(--text)',
    border: '1px solid var(--control-edge)',
    borderRadius: 4,
    padding: '5px 7px',
    fontSize: 12,
    fontFamily: 'var(--font-ui)',
  };
  const label: React.CSSProperties = { fontSize: 11, color: 'var(--muted)' };

  return (
    <div
      onMouseDown={cancel}
      data-no-maximize
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51 + lift,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '12vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal={top ? 'true' : undefined}
        inert={!top}
        aria-label={t('projects.dialog.title')}
        data-testid="open-project-dialog"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        style={{
          inlineSize: 'min(480px, 94vw)',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          outline: 'none',
        }}
      >
        <div
          style={{
            padding: '11px 14px',
            borderBlockEnd: '1px solid var(--border)',
            background: 'var(--panel2)',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600 }}>{t('projects.dialog.title')}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBlockStart: 3 }}>
            {t('projects.dialog.blurb')}
          </div>
        </div>

        <div style={{ padding: '12px 14px', display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={label}>{t('projects.dialog.folder')}</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span
                data-open-project-folder
                title={found.state === 'none' ? undefined : found.folder}
                style={{
                  ...field,
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontFamily: found.state === 'none' ? 'var(--font-ui)' : 'var(--font-mono)',
                  color: found.state === 'none' ? 'var(--muted)' : 'var(--text)',
                }}
              >
                {found.state === 'none' ? t('projects.dialog.pick') : found.folder}
              </span>
              <button type="button" data-open-project-browse onClick={() => void browse()} style={button}>
                {t('projects.dialog.browse')}
              </button>
            </div>
          </div>

          <div role="status" data-open-project-status={found.state} style={{ fontSize: 11.5, minBlockSize: 15 }}>
            {found.state === 'reading' && <span style={{ color: 'var(--muted)' }}>{t('projects.dialog.reading')}</span>}
            {found.state === 'not-repo' && t('projects.dialog.notRepo')}
            {found.state === 'repo' && existing && t('projects.dialog.already', { name })}
          </div>

          {found.state === 'repo' && (
            <>
              {!existing && (
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={label}>{t('projects.dialog.name')}</span>
                  <input
                    data-open-project-name
                    value={name}
                    maxLength={60}
                    spellCheck={false}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        accept();
                      }
                    }}
                    style={field}
                  />
                </label>
              )}
              <div style={{ display: 'grid', gap: 4 }}>
                <span style={label}>{t('projects.dialog.found', { count: found.info.worktrees.length })}</span>
                <div
                  data-open-project-worktrees
                  style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}
                >
                  {found.info.worktrees.map((w, i) => (
                    <div
                      key={w.path}
                      style={{
                        display: 'flex',
                        gap: 8,
                        padding: '4px 8px',
                        borderBlockStart: i === 0 ? undefined : '1px solid var(--border)',
                        fontSize: 11.5,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={w.path}
                      >
                        {t('projects.dialog.worktreeRow', {
                          branch: w.branch ?? (w.head ?? '').slice(0, 7),
                          path: w.path,
                        })}
                      </span>
                      {w.primary && <span style={{ color: 'var(--muted)' }}>{t('projects.primary')}</span>}
                    </div>
                  ))}
                </div>
              </div>
              {sessionsHere > 0 && !existing && (
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  {t('projects.dialog.openSessions', { count: sessionsHere })}
                </div>
              )}
            </>
          )}
        </div>

        <div
          style={{
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, fontSize: 10.5, color: 'var(--muted)' }}>{t('projects.dialog.later')}</span>
          <button type="button" data-open-project-cancel onClick={cancel} style={button}>
            {t('projects.dialog.cancel')}
          </button>
          <button
            type="button"
            data-open-project-ok
            disabled={!ready}
            onClick={accept}
            style={{
              ...button,
              color: ready ? 'var(--text)' : 'var(--muted)',
              cursor: ready ? 'pointer' : 'default',
              fontWeight: 600,
              padding: '4px 14px',
            }}
          >
            {existing ? t('projects.dialog.show') : t('projects.dialog.open')}
          </button>
        </div>
      </div>
    </div>
  );
}
