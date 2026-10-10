// Hover a session to see the last thing it was asked (#631).
//
// The owner: hovering a session's tab or its entry in the sessions list should
// show its last prompt, so "we know exactly what's going on in that session"
// without clicking into it.
//
// ONE COMPONENT, ONE INSTANCE PER WINDOW (the main one, and each popout through
// `PopoutSurfaces`), AND THE MOUNT POINTS ONLY CARRY AN ATTRIBUTE.
// A tab, a row in the list and a pill on the strip each say
// `data-last-prompt-for="<card id>"` and nothing else; this listens on the
// document and finds the nearest one under the pointer. So the three surfaces
// cannot drift apart, and none of them gained a handler, a timer or a portal.
//
// LAZY. Nothing is asked until the pointer has rested on one session for
// `LAST_PROMPT_DELAY_MS`; then main is asked once for that session's last
// prompt (it already holds the conversation). Moving along a row of tabs asks
// for nothing.
//
// IT NEVER TAKES A CLICK. The popup is `pointer-events: none`, and it goes away
// the moment you press a button, a key, scroll, or start a drag: a hint must
// not sit between you and the thing you were about to do.
//
// IT DOES NOT OUTSTAY WHAT IT IS ABOUT (found in review). While it is up, the
// element it hangs off is checked a few times a second: gone, or moved (the
// list reordered, the strip scrolled under a still pointer), and the popup
// goes. It also sits BELOW every dialog and menu, so one that opens by itself
// is never painted over.
//
// WHAT IT SAYS WHEN THERE IS NOTHING TO SAY:
//   * a session that is running and has not been asked anything: "No prompts
//     yet";
//   * a session that is not running (never started, or ended): nothing at all.
//     Its conversation is not loaded, and "No prompts yet" would be false for
//     one with a history;
//   * main cannot say (no answer, or the prompt may have scrolled out of what
//     it keeps): nothing.
import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../shared/ipc/refusal';
import { sessionStore } from '../store/session-store';

/** how long the pointer rests on a session before the popup is fetched */
export const LAST_PROMPT_DELAY_MS = 450;
/** how often, while the popup is up, its session's element is looked at again */
export const LAST_PROMPT_WATCH_MS = 200;
/** the attribute a surface carries to take part */
export const LAST_PROMPT_ATTR = 'data-last-prompt-for';

const POPUP_WIDTH = 340;
const GAP = 6;
const EDGE = 8;

interface Shown {
  cardId: string;
  /** where the hovered element is, to hang the popup off it */
  box: { left: number; top: number; bottom: number };
  text: string | null;
  cut: boolean;
  attachmentOnly: boolean;
  from: string | null;
}

type Answer = Pick<Shown, 'text' | 'cut' | 'attachmentOnly' | 'from'>;

function readAnswer(raw: unknown): Answer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // a verdict-shaped refusal is not an answer
  if ('ok' in r && r.ok === false) return null;
  if (!('text' in r)) return null;
  return {
    text: typeof r.text === 'string' && r.text.trim() ? r.text : null,
    cut: r.cut === true,
    attachmentOnly: r.attachmentOnly === true,
    from: typeof r.from === 'string' && r.from ? r.from : null,
  };
}

/**
 * The session element under an event target, if it is one of ours.
 *
 * NOT when the pointer is on something inside it that has a tooltip of its own
 * (the ✕, the pin, the waiting count): two hints at once is worse than one.
 */
function targetOf(target: EventTarget | null): HTMLElement | null {
  // BY SHAPE, NOT `instanceof Element` (#1022's sibling). A node in a
  // popped-out window belongs to THAT window's `Element`, so the main
  // window's `instanceof` says no to every one of them, and this returned
  // null for every tab in a popout however the listeners were attached.
  const node = target as Element | null;
  if (!node || typeof node.closest !== 'function') return null;
  const el = node.closest<HTMLElement>(`[${LAST_PROMPT_ATTR}]`);
  if (!el) return null;
  const titled = node.closest('[title]');
  if (titled && titled !== el && el.contains(titled)) return null;
  return el;
}

const boxOf = (el: Element): Shown['box'] => {
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom) };
};

export function LastPromptHover(props: {
  /**
   * The window to watch and draw in. Absent means the main one. A popped-out
   * window is a document of its own, so it needs an instance of its own
   * (`PopoutSurfaces`): the pointer events never reach this document, and a
   * box drawn here would be in the wrong window.
   */
  win?: Window;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [shown, setShown] = React.useState<Shown | null>(null);
  const win = props.win ?? window;

  React.useEffect(() => {
    let over: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watch: ReturnType<typeof setInterval> | undefined;
    /** bumped on every change of target, so a late answer is for nobody */
    let turn = 0;
    /** is anything on screen, or pending? When not, the listeners do nothing */
    let active = false;

    const drop = (): void => {
      if (!active) return;
      active = false;
      turn += 1;
      over = null;
      if (timer) clearTimeout(timer);
      if (watch) clearInterval(watch);
      timer = undefined;
      watch = undefined;
      setShown(null);
    };

    const ask = (el: HTMLElement, mine: number): void => {
      const cardId = el.getAttribute(LAST_PROMPT_ATTR);
      if (!cardId || !el.isConnected) return;
      const liveId = sessionStore.getState().sessions.find((s) => s.id === cardId)?.liveId;
      // not running: its conversation is not loaded, so there is nothing true to say
      if (!liveId) return;
      // FAIL OPEN: an older preload, or a test's stand-in, has no such channel
      const transcripts = window.switchboard?.transcripts as
        | Partial<typeof window.switchboard.transcripts>
        | undefined;
      if (typeof transcripts?.lastPrompt !== 'function') return;
      void Promise.resolve()
        .then(() => transcripts.lastPrompt!(liveId))
        .catch(() => undefined)
        .then((raw) => {
          if (mine !== turn || !el.isConnected) return;
          const answer = readAnswer(answered(raw));
          if (!answer) return;
          const box = boxOf(el);
          setShown({ cardId, box, ...answer });
          // from here on it is on screen: keep it honest
          watch = setInterval(() => {
            const now = el.isConnected ? boxOf(el) : null;
            if (!now || now.left !== box.left || now.top !== box.top || now.bottom !== box.bottom) {
              drop();
            }
          }, LAST_PROMPT_WATCH_MS);
        });
    };

    const onOver = (e: PointerEvent): void => {
      // a finger has no hover; a press-and-hold must not raise a popup
      if (e.pointerType === 'touch') return;
      const el = targetOf(e.target);
      if (el === over) return;
      drop();
      if (!el) return;
      active = true;
      over = el;
      const mine = turn;
      timer = setTimeout(() => ask(el, mine), LAST_PROMPT_DELAY_MS);
    };
    // leaving the window entirely: `pointerover` will not fire for that
    const onLeaveDocument = (e: PointerEvent): void => {
      if (e.relatedTarget === null) drop();
    };

    const capture = { capture: true, passive: true } as const;
    // THIS window's document, which for a popout is not `document`. Read once:
    // a window that closes takes its document with it, and the cleanup must
    // still be able to name what it attached to.
    let doc: Document;
    try {
      doc = win.document;
    } catch {
      return; // closed under us — nothing to watch
    }
    doc.addEventListener('pointerover', onOver, capture);
    doc.addEventListener('pointerout', onLeaveDocument, capture);
    doc.addEventListener('pointerdown', drop, capture);
    doc.addEventListener('keydown', drop, true);
    doc.addEventListener('wheel', drop, capture);
    doc.addEventListener('scroll', drop, capture);
    doc.addEventListener('dragstart', drop, capture);
    win.addEventListener('blur', drop);
    win.addEventListener('resize', drop);
    return () => {
      drop();
      try {
        doc.removeEventListener('pointerover', onOver, capture);
        doc.removeEventListener('pointerout', onLeaveDocument, capture);
        doc.removeEventListener('pointerdown', drop, capture);
        doc.removeEventListener('keydown', drop, true);
        doc.removeEventListener('wheel', drop, capture);
        doc.removeEventListener('scroll', drop, capture);
        doc.removeEventListener('dragstart', drop, capture);
        win.removeEventListener('blur', drop);
        win.removeEventListener('resize', drop);
      } catch {
        /* the window is gone, and its listeners with it */
      }
    };
  }, [win]);

  if (!shown) return null;

  // Below the session when there is room, above it when there is not; kept
  // inside the window sideways. Measured against the viewport, not guessed.
  let host: Document;
  try {
    host = win.document;
  } catch {
    return null;
  }
  if (!host?.body) return null;
  const root = host.documentElement;
  const vw = root.clientWidth;
  const vh = root.clientHeight;
  const width = Math.min(POPUP_WIDTH, vw - EDGE * 2);
  const left = Math.max(EDGE, Math.min(shown.box.left, vw - width - EDGE));
  // `insetInlineStart` counts from the RIGHT in a right-to-left layout, and
  // `left` above is physical (#642 is the same correction for the model menu)
  const rtl = win.getComputedStyle(root).direction === 'rtl';
  const inlineStart = rtl ? vw - left - width : left;
  const below = vh - shown.box.bottom;
  const placeAbove = below < 120 && shown.box.top > below;
  const body = shown.text ?? t(shown.attachmentOnly ? 'lastPrompt.attachmentOnly' : 'lastPrompt.none');

  return createPortal(
    <div
      // decoration for a pointer: nothing here is announced, and nothing is
      // claimed that is not wired (no element is `aria-describedby` this)
      aria-hidden
      data-testid="last-prompt-hover"
      data-last-prompt-card={shown.cardId}
      data-placement={placeAbove ? 'above' : 'below'}
      style={{
        position: 'fixed',
        insetInlineStart: inlineStart,
        ...(placeAbove
          ? { insetBlockEnd: vh - shown.box.top + GAP }
          : { insetBlockStart: shown.box.bottom + GAP }),
        inlineSize: width,
        boxSizing: 'border-box',
        // BELOW the dialogs and menus (49 to 51): one that opens on its own
        // must never be painted over by a hint
        zIndex: 45,
        // NEVER takes a click: see the header
        pointerEvents: 'none',
        background: 'var(--panel)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 7,
        boxShadow: 'var(--tab-lift)',
        padding: '7px 9px',
        fontFamily: 'var(--font-ui)',
        fontSize: 11.5,
        lineHeight: 1.4,
      }}
    >
      <div
        data-last-prompt-heading
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
          marginBlockEnd: 3,
        }}
      >
        {shown.from
          ? t('lastPrompt.headingFrom', { name: shown.from })
          : t('lastPrompt.heading')}
      </div>
      <div
        data-last-prompt-text
        style={{
          // a few lines, enough to recognise the task
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 5,
          overflow: 'hidden',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          color: shown.text ? 'var(--text)' : 'var(--muted)',
          fontStyle: shown.text ? 'normal' : 'italic',
        }}
      >
        {shown.text && shown.cut ? t('lastPrompt.cut', { text: body }) : body}
      </div>
    </div>,
    host.body
  );
}
