// A group's roll-up in words (#1351, #1196): "1 approval · 2 waiting",
// "3 working", "calm". The rule is `rail-view`'s `rollupParts`; this only
// turns its keys into one line, so the left list's header and the strip's group
// box cannot word one group two ways.
import type { TFunction } from 'i18next';
import { rollupParts, type WaitRollup } from './rail-view';

export function rollupWords(t: TFunction, r: WaitRollup): string {
  return rollupParts(r)
    .map((p) => (p.count === undefined ? t(p.key) : t(p.key, { count: p.count })))
    .join(t('rail.rollupJoin'));
}
