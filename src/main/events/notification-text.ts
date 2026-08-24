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

// The SPOKEN half moved here from `shared/sounds.ts` in #471. That file's own
// header draws the line — "MAIN decides WHICH sound a card gets and WHAT
// sentence to speak, the RENDERER turns those into actual noise" — and the
// sentence is the half that needs a translator. Nothing in the renderer ever
// called these; keeping them in `shared/` would have meant a shared test
// reaching into `src/main` for a `t`, which the lint rules rightly forbid.

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
  // `Object.hasOwn`, not a bare index: an object literal inherits from
  // `Object.prototype`, so `kind === 'toString'` would find a FUNCTION here and
  // hand it to `t()` — which then tries to `split('.')` it. The result is a
  // thrown TypeError on the one path this whole file promises will degrade
  // quietly, and `'__proto__'` puts the literal text "[object Object]" on a
  // toast and on a phone. Unreachable from `FeedKind` today (`feed.ts` gates on
  // its own ATTENTION set), which is exactly why it would have stayed true
  // right up until the day a kind arrived from somewhere else.
  const key = Object.hasOwn(NOTIFICATION_KIND_KEYS, kind)
    ? NOTIFICATION_KIND_KEYS[kind as FeedKind]
    : undefined;
  return key ? t(key) : kind.replace(/-/g, ' ');
}
/**
 * The sentence the app speaks (§5.9: "TradingApp needs permission").
 *
 * `title` is whatever the rules engine already resolved for every other
 * channel — the card's auto task label when there is one, the session title
 * when there is not (`main/index.ts` → `titleFor`). That chain is why the
 * fallback in this item's spec needs no code here: turning auto labels off
 * changes what `title` IS, and this function speaks whatever it is handed.
 *
 * The event's own body is deliberately NOT spoken. For `needs-permission` that
 * body is a tool-call summary ("Bash: rm -rf …"), which is the right thing to
 * READ on a toast you can look at and the wrong thing to have read ALOUD at you
 * across a room — a sentence you cannot skim, cannot pause, and cannot re-read.
 */
export function announcementFor(title: string, kind: string, t: Translate): string {
  const who = speakableTitle(title, t);
  // TRANSLATED SINCE #471, and not as an afterthought: the voice is the one
  // notification channel that reaches a user who is not looking at the screen,
  // and it would have been the only one left speaking English after the toast,
  // the phone and the webhook stopped. Whole sentences per kind rather than
  // "{who} " + a word, because word order is a translator's business — several
  // languages would put the subject last.
  switch (kind) {
    case 'needs-input':
      return t('notification.speak.needs-input', { who });
    case 'needs-permission':
      return t('notification.speak.needs-permission', { who });
    case 'done':
      return t('notification.speak.done', { who });
    case 'crashed':
      return t('notification.speak.crashed', { who });
    default:
      // A kind with no sentence of its own — replayed from an older workspace
      // file, or added without a key. Said rather than swallowed, in the same
      // de-hyphenated English `notificationBody` falls back to.
      return t('notification.speak.other', { who, what: kind.replace(/-/g, ' ') }).trim();
  }
}

/** How much of a label a voice is allowed to read out. */
export const SPOKEN_TITLE_MAX = 60;

/**
 * A label, trimmed to something a voice can say in a breath.
 *
 * Auto task labels come from the CLI's own conversation title and are usually
 * short, but nothing GUARANTEES that — a user-typed label is free text, and a
 * paragraph of it would be read out in full, over the top of the next event,
 * with no way to stop it. Cut at a word boundary where there is one so the
 * result is still a phrase rather than a syllable.
 */
export function speakableTitle(title: string, t: Translate): string {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim();
  // The only string here we WROTE — a label is the user's words, or the
  // conversation's, and neither gets translated (§5.21: our chrome, not theirs).
  if (!clean) return t('notification.speak.anonymous');
  if (clean.length <= SPOKEN_TITLE_MAX) return clean;
  const cut = clean.slice(0, SPOKEN_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > SPOKEN_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trim();
}
