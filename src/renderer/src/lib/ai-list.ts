// The AIs the switch menu lists (#1294), from #1291's `ais:*` surface.
//
// FAIL-OPEN to "no list": a window whose preload has no `ais` (a test
// bridge), a refusal, or a rejected call all give `null`, and the menu then
// shows the card's own AI and says the list is not available — it never shows
// a session on "nothing", and never offers a switch it cannot back.
import React from 'react';
import { answered } from '../../../shared/ipc/refusal';
import type { AiItemLike } from './ai-switch-view';

/** `?.` throughout: a bridge without the surface is a supported state. */
function bridge(): Partial<Pick<NonNullable<Window['switchboard']['ais']>, 'list' | 'onChanged'>> | undefined {
  return (window.switchboard as Partial<Window['switchboard']> | undefined)?.ais;
}

/** Is this the shape `ais:list` answers? Checked, because it crossed a process boundary. */
export function readAiList(v: unknown): AiItemLike[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter(
    (x): x is AiItemLike =>
      !!x &&
      typeof x === 'object' &&
      typeof (x as AiItemLike).entry?.id === 'string' &&
      typeof (x as AiItemLike).entry?.name === 'string' &&
      typeof (x as AiItemLike).registered === 'boolean'
  );
}

/** The AI list, refreshed when it changes (a detection run, a login). Null = not known. */
export function useAiList(enabled: boolean): AiItemLike[] | null {
  const [items, setItems] = React.useState<AiItemLike[] | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    const ais = bridge();
    if (!ais?.list) return;
    let alive = true;
    ais.list().then(
      (raw) => {
        if (alive) setItems(readAiList(answered(raw)));
      },
      () => {
        /* no list: the menu says so */
      }
    );
    const off = ais.onChanged?.((snap) => {
      if (alive && snap && typeof snap === 'object') setItems(readAiList((snap as { items?: unknown }).items));
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [enabled]);
  return items;
}
