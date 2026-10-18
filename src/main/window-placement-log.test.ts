// #1277 — every hide / minimize / move / restore of the main window lands in
// the `ui` log with its bounds and display, so the next "my window vanished"
// report can be read off the log instead of guessed at.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Rectangle } from 'electron';
import { PLACEMENT_EVENTS, rectText, watchMainWindowPlacement } from './window-placement-log';

const primary = { x: 0, y: 0, width: 2560, height: 1392 };

class FakeWindow extends EventEmitter {
  bounds: Rectangle = { x: 640, y: 296, width: 1280, height: 800 };
  normal: Rectangle | null = null;
  minimized = false;
  maximized = false;
  visible = true;
  destroyed = false;
  isDestroyed = (): boolean => this.destroyed;
  isMinimized = (): boolean => this.minimized;
  isVisible = (): boolean => this.visible;
  isMaximized = (): boolean => this.maximized;
  isFullScreen = (): boolean => false;
  getBounds = (): Rectangle => this.bounds;
  getNormalBounds = (): Rectangle => this.normal ?? this.bounds;
}

function setup(areas: Rectangle[] = [primary]) {
  const w = new FakeWindow();
  const lines: Array<{ level: 'info' | 'warn'; msg: string; fields?: Record<string, unknown> }> = [];
  const watch = watchMainWindowPlacement(w, {
    log: {
      info: (msg, fields) => lines.push({ level: 'info', msg, fields }),
      warn: (msg, fields) => lines.push({ level: 'warn', msg, fields }),
    },
    workAreas: () => areas,
    displayIdOf: (b) => (b.x >= 0 ? 1 : 2),
    moveSettleMs: 50,
  });
  return { w, lines, watch, areas };
}

afterEach(() => vi.useRealTimers());

describe('watchMainWindowPlacement (#1277)', () => {
  it('logs every discrete transition, with bounds and display', () => {
    const { w, lines } = setup();
    for (const ev of PLACEMENT_EVENTS) w.emit(ev);
    expect(lines.map((l) => l.msg)).toEqual(PLACEMENT_EVENTS.map((ev) => `main window ${ev}`));
    expect(lines[0].fields).toMatchObject({
      bounds: '640,296 1280x800',
      displayId: 1,
      onScreen: true,
      minimized: false,
      maximized: false,
      visible: true,
    });
  });

  it('a minimized window reports the rectangle it comes back to', () => {
    const { w, lines } = setup();
    w.minimized = true;
    w.bounds = { x: -32000, y: -32000, width: 160, height: 28 }; // where Windows parks it
    w.normal = { x: 100, y: 100, width: 1200, height: 800 };
    w.emit('minimize');
    expect(lines[0].fields).toMatchObject({
      bounds: '-32000,-32000 160x28',
      normalBounds: '100,100 1200x800',
      onScreen: true, // judged by where it comes back, not where it is parked
    });
  });

  it('a burst of moves is ONE line, after the burst settles', () => {
    vi.useFakeTimers();
    const { w, lines } = setup();
    for (let i = 0; i < 20; i++) {
      w.bounds = { ...w.bounds, x: 640 + i };
      w.emit(i % 2 ? 'move' : 'resize');
    }
    expect(lines).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(lines.map((l) => l.msg)).toEqual(['main window moved']);
    expect(lines[0].fields?.bounds).toBe('659,296 1280x800');
  });

  it('WARNS when the window lands off every display, and says when it is back — once each', () => {
    vi.useFakeTimers();
    const { w, lines } = setup();
    w.bounds = { x: -2296, y: -21, width: 1996, height: 674 };
    w.emit('move');
    vi.advanceTimersByTime(60);
    w.emit('move');
    vi.advanceTimersByTime(60);
    expect(lines.filter((l) => l.level === 'warn').map((l) => l.msg)).toEqual([
      'main window is off every attached display',
    ]);

    w.bounds = { x: 640, y: 296, width: 1280, height: 800 };
    w.emit('restore');
    expect(lines.at(-1)?.msg).toBe('main window is back on an attached display');
  });

  it('a destroyed window logs nothing and throws nothing', () => {
    const { w, lines } = setup();
    w.destroyed = true;
    expect(() => w.emit('hide')).not.toThrow();
    expect(lines).toEqual([]);
  });

  it('a throwing probe never escapes the event handler', () => {
    const { w } = setup();
    w.getBounds = () => {
      throw new Error('gone');
    };
    expect(() => w.emit('show')).not.toThrow();
  });

  it('recheck: a display detaching under a window that raised nothing is still warned about, once', () => {
    const second = { x: 2560, y: 0, width: 2560, height: 1392 };
    const areas = [primary, second];
    const { w, lines, watch } = setup(areas);
    w.minimized = true;
    w.normal = { x: 3000, y: 100, width: 1200, height: 800 }; // comes back on the second monitor
    watch.recheck();
    expect(lines).toEqual([]); // still on screen: recheck logs no line of its own
    areas.pop(); // the second monitor goes away; the window raises nothing
    watch.recheck();
    watch.recheck();
    expect(lines.map((l) => [l.level, l.msg])).toEqual([['warn', 'main window is off every attached display']]);
    w.destroyed = true;
    expect(() => watch.recheck()).not.toThrow();
  });

  it('rectText is the shape the #864 restore line already uses', () => {
    expect(rectText({ x: -2296, y: -21, width: 1996, height: 674 })).toBe('-2296,-21 1996x674');
  });
});
