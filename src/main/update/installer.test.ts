// Starting the installer (P2-E19-04).
//
// This is the one place the app executes something it downloaded, so the tests
// are about what it REFUSES. The containment check in particular: `startsWith`
// on a path is the classic wrong answer, and `…\switchboard-updates-evil\` is
// exactly the string that gets past it.
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { isStagedInstaller, launchInstaller } from './installer';

const DIR = path.resolve('C:/Users/x/AppData/Local/Temp/switchboard-updates');
const GOOD = path.join(DIR, 'switchboard-Setup-9.9.9.exe');

describe('what may be executed', () => {
  it('accepts a .exe inside the directory we staged it in', () => {
    expect(isStagedInstaller(GOOD, DIR)).toBe(true);
  });

  it('refuses anything outside it — including the near-miss neighbour', () => {
    // `startsWith` would let this one through, which is the entire reason the
    // check is `path.relative`.
    expect(isStagedInstaller(path.resolve(`${DIR}-evil`, 'x.exe'), DIR)).toBe(false);
    expect(isStagedInstaller('C:/Windows/System32/calc.exe', DIR)).toBe(false);
    expect(isStagedInstaller(path.join(DIR, '..', 'elsewhere.exe'), DIR)).toBe(false);
  });

  it('refuses anything that is not an .exe, and anything relative', () => {
    expect(isStagedInstaller(path.join(DIR, 'notes.txt'), DIR)).toBe(false);
    expect(isStagedInstaller(path.join(DIR, 'setup.exe.txt'), DIR)).toBe(false);
    expect(isStagedInstaller('switchboard-Setup-9.9.9.exe', DIR)).toBe(false);
    expect(isStagedInstaller('', DIR)).toBe(false);
    expect(isStagedInstaller(null, DIR)).toBe(false);
    expect(isStagedInstaller(42, DIR)).toBe(false);
  });

  it('the directory itself is not an installer', () => {
    expect(isStagedInstaller(DIR, DIR)).toBe(false);
  });
});

describe('the launch', () => {
  it('runs it SILENTLY, detached, with no shell — and asks it to relaunch us', () => {
    const child = { unref: vi.fn() };
    const spawnImpl = vi.fn(() => child);
    expect(launchInstaller(GOOD, { updateDir: DIR, spawnImpl: spawnImpl as never, platform: 'win32' })).toBe(true);

    const [file, args, options] = spawnImpl.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(file).toBe(GOOD);
    // `/S` is NSIS's silent switch — without it the user gets a wizard they
    // did not ask for from an app that just told them it was updating.
    //
    // `--force-run` is the fix for #525 and is pinned here BY NAME because the
    // bug was invisible in code review: electron-builder's oneClick relaunch is
    // guarded by `${ifNot} ${Silent} ${orIf} ${isForceRun}`, so `/S` alone
    // installs the update and never brings the app back. Delete this argument
    // and the app quits for good on every update — with no failing behaviour
    // anywhere else to catch you. That is what this assertion is for.
    expect(args).toEqual(['/S', '--force-run']);
    expect(options).toMatchObject({ detached: true, stdio: 'ignore', shell: false });
    // Detached AND unref'd: the caller quits next, and a child in our process
    // group would be killed by the very quit it is meant to survive.
    expect(child.unref).toHaveBeenCalled();
  });

  it('does not spawn a path it would not accept', () => {
    const spawnImpl = vi.fn();
    expect(
      launchInstaller('C:/Windows/System32/calc.exe', {
        updateDir: DIR,
        spawnImpl: spawnImpl as never,
        platform: 'win32',
      })
    ).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('does nothing at all off Windows', () => {
    const spawnImpl = vi.fn();
    expect(
      launchInstaller(GOOD, { updateDir: DIR, spawnImpl: spawnImpl as never, platform: 'linux' })
    ).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('a spawn that throws is FALSE, not an exception in the quit path', () => {
    const spawnImpl = vi.fn(() => {
      throw new Error('EACCES');
    });
    expect(launchInstaller(GOOD, { updateDir: DIR, spawnImpl, platform: 'win32' })).toBe(false);
  });
});
