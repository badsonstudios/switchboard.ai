// What a notification SAYS, for the kinds that are not a permission (#471).
//
// The permission case is `permission-toast.ts` → `permissionSummary`, because
// naming what an **Allow** button would allow is a safety requirement rather
// than copy. Everything else is one word about a session's state, and until
// #471 main produced it by de-hyphenating the enum member —
// `e.kind.replace(/-/g, ' ')` — which is a perfectly good English string and
// nothing else's.
//
// It reaches further than the desktop toast: `push.ts` and the webhook forward
// `ctx.body` verbatim, so this is also the sentence that lands on a phone.
//
// Kept out of `main/index.ts` so the mapping can be tested, and out of
// `permission-toast.ts` because it belongs to every toast rather than that one.
import type { FeedKind } from './feed';
import type { Translate } from '../../shared/i18n';

/**
 * The catalog key for each attention kind.
 *
 * A `Record<FeedKind, …>` and not a template string, deliberately: a new member
 * of `FeedKind` is then a TYPE ERROR here rather than a `notification.kind.foo`
 * rendered to the user as its own key. i18next returns the key when it cannot
 * resolve one, and a missing key is exactly the kind of thing that ships.
 */
export const NOTIFICATION_KIND_KEYS: Readonly<Record<FeedKind, string>> = {
  done: 'notification.kind.done',
  ready: 'notification.kind.ready',
  'needs-input': 'notification.kind.needs-input',
  'needs-permission': 'notification.kind.needs-permission',
  crashed: 'notification.kind.crashed',
};

/**
 * What a toast (or push, or webhook) says about an attention event.
 *
 * `kind` is typed loosely because the value arrives on a `FeedEvent` that has
 * crossed a process boundary and, in the rules engine, can be replayed from a
 * persisted workspace file. An unrecognised kind falls back to the de-hyphenated
 * enum member — the exact behaviour this replaced — rather than to a key or an
 * empty string: the user gets *something true in English* instead of
 * `notification.kind.went-weird`.
 */
export function notificationBody(kind: string, t: Translate): string {
  const key = NOTIFICATION_KIND_KEYS[kind as FeedKind];
  return key ? t(key) : kind.replace(/-/g, ' ');
}
