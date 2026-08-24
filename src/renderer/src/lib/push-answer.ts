// What the push dialog shows after a WRITE answers (#677, extracting #650's
// fix from `App.tsx` so it has a regression net).
//
// The logic was correct where it sat — inside `applyPushAnswer`'s `.then` in
// `App.tsx` — but unpinnable there: the promise arrives as a PARAMETER, so the
// refusal scanner cannot trace it to the bridge (a documented blind spot of
// `scripts/refusal-truthiness.js`), and there is no `App.test.tsx` to host a
// runtime pin because the callback lives inside a ~2,000-line component. The
// identical defect class IS pinned where it was testable (`DocumentViewer`);
// this move gives this site the same net. `App.tsx` keeps the setters and the
// `.catch`; everything that INTERPRETS the answer lives here.
import { answered } from '../../../shared/ipc/refusal';
import { unavailablePushConfig } from '../../../shared/push';
import type { PushConfig, PushWriteResult } from '../../../shared/push';

/** What the dialog renders beside the field that was written. The problem
 *  word is the wire's own union, so a typo'd word fails typecheck here rather
 *  than rendering a missing i18n key (the exact #650 defect class). */
export interface PushWriteNotice {
  key: string;
  problem: NonNullable<PushWriteResult['problem']>;
}

export interface AppliedPushAnswer {
  config: PushConfig;
  /** `null` when the write landed — nothing to say beside the field. */
  write: PushWriteNotice | null;
}

/**
 * Interpret one `push:setPrefs` / `push:setSecret` answer.
 *
 * #650: the refusal brand has no `config` and no `ok`, so an unlaundered
 * refusal would put `undefined` into a `PushConfig | null` state (the
 * empty-working-form `PushConfig`'s own doc-comment forbids) AND report
 * `problem: 'refused'` — a failed WRITE — for a call that never reached the
 * store. Refused is the honest word for both halves, and it is what the
 * caller's `.catch` already says; `unavailablePushConfig()` is what the dialog
 * shows when it could not ask at all.
 */
export function interpretPushAnswer(key: string, answer: PushWriteResult): AppliedPushAnswer {
  const r = answered(answer);
  if (!r) {
    return { config: unavailablePushConfig(), write: { key, problem: 'refused' } };
  }
  // Main is the authority on whether the write happened, and a credential
  // cannot be read back to check.
  return { config: r.config, write: r.ok ? null : { key, problem: r.problem ?? 'refused' } };
}
