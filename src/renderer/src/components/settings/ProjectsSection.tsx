// Settings ▸ General ▸ Projects (E42 step 2, #1506): where new worktrees go
// when a project does not say (main stores it; one app-managed folder outside
// every repo), and what starting a plain session in a checkout another live
// session is using does (the renderer's busy-folder setting).
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectDefaults } from '../../../../shared/projects';
import { setBusyFolder, useBusyFolder, type BusyFolderChoice } from '../../lib/busy-folder';
import { answered } from '../../../../shared/ipc/refusal';
import { SettingItem } from './controls';

type ProjectsBridge = {
  defaults(): Promise<ProjectDefaults>;
  setDefaults(d: { worktreeRoot: string | null }): Promise<ProjectDefaults | null>;
};

function bridge(): ProjectsBridge | undefined {
  return (window as unknown as { switchboard?: { projects?: ProjectsBridge } }).switchboard?.projects;
}

const CHOICES: BusyFolderChoice[] = ['ask', 'share', 'worktree'];

export function ProjectsSection(props: { open: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const busy = useBusyFolder();
  const [defaults, setDefaults] = React.useState<ProjectDefaults | null>(null);

  React.useEffect(() => {
    if (!props.open) return;
    void bridge()
      ?.defaults()
      .then((d) => setDefaults(answered(d) ?? null))
      .catch(() => undefined);
  }, [props.open]);

  const choose = async (root: string | null): Promise<void> => {
    const next = answered(await bridge()?.setDefaults({ worktreeRoot: root }).catch(() => null));
    if (next) setDefaults(next);
  };
  const browse = async (): Promise<void> => {
    const picked = answered(await window.switchboard.sessions.pickFolder().catch(() => null));
    if (picked) await choose(picked);
  };

  const shown = defaults?.worktreeRoot ?? defaults?.defaultRoot ?? '';
  return (
    <>
      <SettingItem item="worktree-folder" label={t('worktrees.prefs.folderTitle')} blurb={t('worktrees.prefs.folderBlurb')}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            data-settings-field="worktreeFolder"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11, overflowWrap: 'anywhere' }}
          >
            {shown}
          </span>
          <button type="button" data-settings-field="worktreeFolderPick" onClick={() => void browse()} style={{ fontSize: 11 }}>
            {t('worktrees.prefs.change')}
          </button>
          {defaults?.worktreeRoot && (
            <button
              type="button"
              data-settings-field="worktreeFolderReset"
              onClick={() => void choose(null)}
              style={{ fontSize: 11 }}
            >
              {t('worktrees.prefs.reset')}
            </button>
          )}
        </div>
      </SettingItem>
      <SettingItem item="busy-folder" label={t('worktrees.prefs.busyTitle')} blurb={t('worktrees.prefs.busyBlurb')}>
        <select
          data-settings-field="busyFolder"
          aria-label={t('worktrees.prefs.busyTitle')}
          value={busy}
          onChange={(e) => setBusyFolder(e.currentTarget.value as BusyFolderChoice)}
          style={{ maxInlineSize: 340, fontSize: 12 }}
        >
          {CHOICES.map((c) => (
            <option key={c} value={c}>
              {t(`worktrees.prefs.busy.${c}`)}
            </option>
          ))}
        </select>
      </SettingItem>
    </>
  );
}
