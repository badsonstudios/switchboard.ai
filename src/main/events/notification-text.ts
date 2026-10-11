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
  // Present so this map stays TOTAL over `FeedKind` — which is the whole reason
  // it is a `Record` rather than a template string. It is not reached today:
  // `notifier.ts`'s `isAttention` deliberately leaves `dispatch-result` out, so
  // no toast, push or webhook is built from one (P2-E13-05 — the reviewer's own
  // `done` has already beeped one moment earlier, and a second signal for the
  // same fact is the duplicate #948's review argued against). A key rather than
  // a placeholder, so the day something does reach it there is a sentence.
  'dispatch-result': 'notification.kind.dispatch-result',
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
 * `title` is WHO, already resolved by the caller. Since #1206 the `speak`
 * action hands it the session's NAME (`spokenWho`), not the task label every
 * other channel leads with: by ear the question is which session, and a
 * conversation's title does not answer it. This function speaks whatever it is
 * handed.
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

/**
 * A SESSION'S NAME, made sayable (#1206).
 *
 * The owner, hand-testing speech: "When it talks, it needs to say the name of
 * the session. If I'm in Switchboard AI, it needs to say 'Switchboard AI, and
 * then what's going on.'" The voice was saying the conversation's task label,
 * which is the right thing to READ on a toast and useless BY EAR for the one
 * question a listener has: which session wants me.
 *
 * A name is usually a folder's name, and folder names carry punctuation a
 * voice either reads out ("Switchboard dot A I") or swallows. So:
 *
 *   - a dot after a letter or a digit, with LETTERS after it, becomes a space.
 *     A short tail is upper-cased, which is what makes a voice spell it rather
 *     than try to pronounce it: one or two letters always ("ai", "io", "js"),
 *     three only when they hold no vowel ("txt", "css"). A three-letter tail
 *     WITH a vowel is usually a word ("my.app", "api.dev", "john.doe") and is
 *     left as one. "Switchboard.ai" is "Switchboard AI";
 *   - a dot between DIGITS is left alone: "v0.8" is a number and is said as one;
 *   - `_` `-` `/` `\\` between words become spaces: "my-app" is "my app".
 *
 * Nothing else is touched. This is a guess at pronunciation, and the more it
 * rewrites the more names it gets wrong; these are the rules a real name on
 * the owner's machine needed. A name that still comes out wrong can be
 * renamed to how it should be said.
 */
export function speakableName(name: string): string {
  return (name ?? '')
    .replace(/(?<=[\p{L}\p{N}])\.(\p{L}+)/gu, (_m, tail: string) => ` ${spelled(tail)}`)
    .replace(/(?<=[\p{L}\p{N}])[_\-/\\]+(?=[\p{L}\p{N}])/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function spelled(tail: string): string {
  if (tail.length <= 2) return tail.toUpperCase();
  if (tail.length === 3 && !/[aeiouy]/i.test(tail)) return tail.toUpperCase();
  return tail;
}

/** How much of a NAME is kept when a task label has to follow it, so the
 *  label is never the part that falls off the end. */
const SPOKEN_NAME_WITH_LABEL_MAX = 30;

/**
 * The name the voice should use for one session, and whether another open
 * session SOUNDS the same (#1206).
 *
 * Compared as they are SAID, not as they are written: "my-app" and "my_app"
 * are different names on screen and the same two words by ear, and the point
 * of `shared` is whether the listener can tell them apart.
 */
export function sessionNameAmong(
  sessions: ReadonlyArray<{ id: string; title: string }>,
  liveId: string
): { name: string; shared: boolean } | null {
  const mine = sessions.find((s) => s.id === liveId)?.title;
  if (!mine) return null;
  const said = (title: string): string => speakableName(title).toLowerCase();
  const key = said(mine);
  return { name: mine, shared: sessions.filter((s) => said(s.title) === key).length > 1 };
}

/**
 * WHO the voice names (#1206): the session, not the task.
 *
 * `name` is the card's name as the list of sessions shows it. `label` is what
 * every other channel leads with (the task label when there is one). Speech
 * says the name; the label is left out, because a sentence you cannot skim
 * should be short.
 *
 * ...EXCEPT WHEN THE NAME ALONE DOES NOT SAY WHICH. Two sessions opened on one
 * folder have the same name, and what tells them apart in the list is the task
 * label under each. So when `shared`, the label follows the name, and that is
 * the only time it is spoken.
 *
 * With no name at all (a session main has no record of) this falls back to the
 * label, which is what the voice said before.
 */
export function spokenWho(
  who: { name?: string | null; shared?: boolean; label: string },
  t: Translate
): string {
  const name = speakableName(who.name ?? '');
  // a name with nothing in it a voice can say ("...", "---") is no name
  if (!/[\p{L}\p{N}]/u.test(name)) return speakableTitle(who.label, t);
  const label = (who.label ?? '').replace(/\s+/g, ' ').trim();
  if (who.shared && label && label !== (who.name ?? '').trim()) {
    // the NAME gives way first: the label is the only thing telling them apart
    const short = speakableTitle(name, t).slice(0, SPOKEN_NAME_WITH_LABEL_MAX).trim();
    return speakableTitle(`${short}, ${label}`, t);
  }
  return speakableTitle(name, t);
}
