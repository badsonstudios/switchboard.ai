// #1277 — reachability, not existence. Every state the owner's window could be
// in, decided without a monitor to unplug.
import { describe, it, expect } from 'vitest';
import type { Rectangle } from 'electron';
import { MINIMIZED_IS_REACHABLE, ReachPolicy, ReachProbe, gateUnreachable, unreachableReason } from './window-reach';

const primary = { x: 0, y: 0, width: 2560, height: 1392 };
const left = { x: -2560, y: 0, width: 2560, height: 1392 };
const onPrimary = { x: 640, y: 296, width: 1280, height: 800 };
const onLeft = { x: -2296, y: 0, width: 1996, height: 684 };

function win(o: {
  bounds?: Rectangle;
  normal?: Rectangle;
  visible?: boolean;
  minimized?: boolean;
  destroyed?: boolean;
}): ReachProbe {
  return {
    isDestroyed: () => o.destroyed === true,
    isVisible: () => o.visible !== false,
    isMinimized: () => o.minimized === true,
    getBounds: () => o.bounds ?? onPrimary,
    getNormalBounds: () => o.normal ?? o.bounds ?? onPrimary,
  };
}

const policy: ReachPolicy = { minimizedIsReachable: true, appHiddenByUser: false };

describe('unreachableReason (#1277)', () => {
  it('a visible window on an attached display is reachable', () => {
    expect(unreachableReason(win({}), [], [primary], policy)).toBeNull();
  });

  it('the owner\'s case: alive, but on a monitor that is not attached', () => {
    expect(unreachableReason(win({ bounds: onLeft }), [], [primary], policy)).toBe('off every attached display');
  });

  it('...and the same window IS reachable once that monitor is back', () => {
    expect(unreachableReason(win({ bounds: onLeft }), [], [primary, left], policy)).toBeNull();
  });

  it('a hidden window has no taskbar button: nobody can find it', () => {
    expect(unreachableReason(win({ visible: false }), [], [primary], policy)).toBe('hidden');
  });

  it('macOS Cmd+H is the Mac\'s minimize, and counts like one', () => {
    expect(
      unreachableReason(win({ visible: false }), [], [primary], { ...policy, appHiddenByUser: true })
    ).toBeNull();
  });

  it('...unless the Dock would bring it back off every attached display', () => {
    expect(
      unreachableReason(win({ visible: false, bounds: onLeft }), [], [primary], { ...policy, appHiddenByUser: true })
    ).toBe('hidden with Cmd+H, and it would come back off every attached display');
  });

  it('no displays attached at all (every monitor asleep and detached)', () => {
    expect(unreachableReason(win({}), [], [], policy)).toBe('no display is attached');
  });

  describe('minimized', () => {
    it('is reachable by default — the taskbar button and the toast both reach it', () => {
      expect(MINIMIZED_IS_REACHABLE).toBe(true);
      expect(unreachableReason(win({ minimized: true, visible: false }), [], [primary], policy)).toBeNull();
    });

    it('...unless restoring it would land it off every display', () => {
      expect(
        unreachableReason(win({ minimized: true, normal: onLeft }), [], [primary], policy)
      ).toBe('minimized, and it would come back off every attached display');
    });

    it('is unreachable when the policy says so — the one-line flip', () => {
      expect(
        unreachableReason(win({ minimized: true }), [], [primary], { ...policy, minimizedIsReachable: false })
      ).toBe('minimized');
    });
  });

  describe('popouts', () => {
    it('a visible popout keeps its sessions answerable when the main window is lost', () => {
      const popout = win({ bounds: { x: 100, y: 100, width: 900, height: 700 } });
      expect(unreachableReason(win({ bounds: onLeft }), [popout], [primary], policy)).toBeNull();
    });

    it('a popout that is off-screen too does not help, and the MAIN reason is reported', () => {
      const popout = win({ bounds: onLeft });
      expect(unreachableReason(win({ visible: false }), [popout], [primary], policy)).toBe('hidden');
    });

    it('a destroyed popout does not count', () => {
      const popout = win({ destroyed: true });
      expect(unreachableReason(win({ bounds: onLeft }), [popout], [primary], policy)).toBe(
        'off every attached display'
      );
    });
  });
});

// The two moments only main/index.ts can know about (review: pinned here so a
// revert of either exemption goes red without an e2e).
describe('gateUnreachable (#1277)', () => {
  const lost = (): string => 'off every attached display';

  it('asks the predicate once the window exists, is shown, and the displays are still', () => {
    expect(gateUnreachable({ exists: true, shown: true, settling: false }, lost)).toBe('off every attached display');
  });

  it('a window not shown yet is on its way, not lost', () => {
    expect(gateUnreachable({ exists: true, shown: false, settling: false }, lost)).toBeNull();
  });

  it('mid-hotplug the #864 restore is about to place it', () => {
    expect(gateUnreachable({ exists: true, shown: true, settling: true }, lost)).toBeNull();
  });

  it('no window at all belongs to hasLiveWindow, and the predicate is not even asked', () => {
    let asked = false;
    expect(
      gateUnreachable({ exists: false, shown: true, settling: false }, () => {
        asked = true;
        return 'x';
      })
    ).toBeNull();
    expect(asked).toBe(false);
  });
});
