import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import {
  sameClsid,
  stampToastActivator,
  startMenuShortcutPath,
  type ShortcutFields,
  type ShortcutIo,
} from './toast-shortcut';

const CLSID = '{B09A799F-F4F1-40E7-BD3A-A3CF14B0AF11}';
const AUMID = 'com.badsonstudios.switchboard';

function io(link: Omit<ShortcutFields, 'target'> | 'missing', ok = true): ShortcutIo & {
  update: ReturnType<typeof vi.fn>;
} {
  return {
    read: () => {
      if (link === 'missing') throw new Error('no such file');
      return { target: 'C:/x/switchboard.exe', ...link };
    },
    update: vi.fn(() => ok),
  };
}

describe('the Start-menu shortcut names our toast activator (#675)', () => {
  it('lives where the per-user installer puts it', () => {
    expect(startMenuShortcutPath('C:/Users/x/AppData/Roaming', 'switchboard.ai')).toBe(
      path.join('C:/Users/x/AppData/Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'switchboard.ai.lnk')
    );
  });

  it('stamps a shortcut that carries our AUMID and no CLSID (what the installer writes)', () => {
    const shortcut = io({ appUserModelId: AUMID, toastActivatorClsid: '' });
    expect(stampToastActivator(shortcut, 'x.lnk', CLSID, AUMID)).toBe('stamped');
    // ...handing the link's own fields back, so its target survives the update
    expect(shortcut.update).toHaveBeenCalledWith(
      'x.lnk',
      { toastActivatorClsid: CLSID, appUserModelId: AUMID },
      expect.objectContaining({ target: 'C:/x/switchboard.exe' }) as unknown
    );
  });

  it('leaves an already-stamped shortcut alone, braces and case aside', () => {
    const shortcut = io({ appUserModelId: AUMID, toastActivatorClsid: CLSID.slice(1, -1).toLowerCase() });
    expect(stampToastActivator(shortcut, 'x.lnk', CLSID, AUMID)).toBe('already');
    expect(shortcut.update).not.toHaveBeenCalled();
  });

  it("never stamps someone else's shortcut", () => {
    const shortcut = io({ appUserModelId: 'electron.app.Electron' });
    expect(stampToastActivator(shortcut, 'x.lnk', CLSID, AUMID)).toBe('not-ours');
    expect(shortcut.update).not.toHaveBeenCalled();
  });

  it('fails open: no shortcut, a refusal and a throw are outcomes, not crashes', () => {
    expect(stampToastActivator(io('missing'), 'x.lnk', CLSID, AUMID)).toBe('no-shortcut');
    expect(stampToastActivator(io({ appUserModelId: AUMID }, false), 'x.lnk', CLSID, AUMID)).toBe('refused');
    const throwing: ShortcutIo = {
      read: () => ({ target: 'x.exe', appUserModelId: AUMID }),
      update: () => {
        throw new Error('locked');
      },
    };
    expect(stampToastActivator(throwing, 'x.lnk', CLSID, AUMID)).toBe('refused');
  });

  it('compares CLSIDs the way Windows writes them', () => {
    expect(sameClsid('{abc}', 'ABC')).toBe(true);
    expect(sameClsid('', CLSID)).toBe(false);
    expect(sameClsid(undefined, CLSID)).toBe(false);
  });
});
