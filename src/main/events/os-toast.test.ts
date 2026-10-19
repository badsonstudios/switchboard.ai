// The toast mute (#1338): muted skips ONLY the show, and only off a packaged build.
import { describe, expect, it, vi } from 'vitest';
import { MUTE_TOASTS_ENV, showOsToast, toastsMuted } from './os-toast';

describe('toastsMuted', () => {
  it('is on for any non-empty value in a non-packaged build', () => {
    expect(toastsMuted({ [MUTE_TOASTS_ENV]: '1' }, false)).toBe(true);
    expect(toastsMuted({ [MUTE_TOASTS_ENV]: 'yes' }, false)).toBe(true);
  });

  it('is off when absent or empty — empty is how a spec turns it back off', () => {
    expect(toastsMuted({}, false)).toBe(false);
    expect(toastsMuted({ [MUTE_TOASTS_ENV]: '' }, false)).toBe(false);
  });

  it('can never silence the shipped app', () => {
    expect(toastsMuted({ [MUTE_TOASTS_ENV]: '1' }, true)).toBe(false);
  });

  // the fixture spells the name out (it imports nothing from main); this is
  // the other half of that pair, so a rename here fails until both move
  it('is the variable name the e2e fixture sets', () => {
    expect(MUTE_TOASTS_ENV).toBe('SWITCHBOARD_MUTE_TOASTS');
  });
});

describe('showOsToast', () => {
  it('shows the toast when not muted, and says it was not muted', () => {
    const toast = { show: vi.fn() };
    expect(showOsToast(toast, { muted: false })).toEqual({ muted: false });
    expect(toast.show).toHaveBeenCalledTimes(1);
  });

  it('muted: does not show it, and says so — the answer the log line carries', () => {
    const toast = { show: vi.fn() };
    expect(showOsToast(toast, { muted: true })).toEqual({ muted: true });
    expect(toast.show).not.toHaveBeenCalled();
  });
});
