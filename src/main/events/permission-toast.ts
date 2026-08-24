// Actionable permission toasts (P2-E14-04, §5.9): the OS toast for a
// `needs-permission` event carries **Allow / Deny**, so the question can be
// answered without the app ever coming to the front.
//
// **One decision path, N surfaces.** The approval bar, the Events panel's
// inline buttons, the batch band and this toast all end at the same
// `decidePermission` in `sessions/ipc.ts` — the very function
// `sessions:decidePermission` calls. A toast that had its own route to the CLI
// would be a fifth opinion about what "allow" means; this one is a fourth
// button on the same wire.
//
// Everything here is electron-free on purpose. `main/index.ts` is the only file
// allowed to touch `Notification` (the rule `rules-engine.ts` set up), so what
// it hands us is a `ClosableToast` — anything with `close()`. That is what lets
// the routing, the withdrawal and the dead-session case be unit-tested without
// a desktop, which matters because the one thing NO automated test can do is
// press a button on a real OS toast.
import type { Logger } from '../log/logger';
import type { PermissionRequest } from '../../shared/ipc/permissions';
import { ASK_USER_QUESTION_TOOL, parseAskUserQuestion } from '../../shared/ask-user-question';
import type { Translate } from '../../shared/i18n';

export type ToastDecision = 'allow' | 'deny';

/**
 * The buttons, in the order they are attached to the notification.
 *
 * The OS reports a press as an INDEX, so this array is the wire contract
 * between the labels we render and the verdict we send. Reordering it without
 * reordering the labels would send the opposite of what the user pressed —
 * which is why the labels are derived from it rather than written twice.
 */
export const DECIDE_BUTTONS: readonly ToastDecision[] = ['allow', 'deny'];

/**
 * The catalog key for each button's label (#471).
 *
 * **The keys are the approval bar's own** — `approval.allow` / `approval.deny`,
 * the very strings `BatchApprovalBar` renders. That is not thrift, it is the
 * same promise `permissionSummary` keeps below: the toast is a fourth button on
 * the bar's wire, so it must be a fourth button with the bar's WORDS. Sharing
 * the key makes that structural — nobody can retitle one surface's Allow
 * without retitling the other's.
 */
export const DECIDE_BUTTON_KEYS: Readonly<Record<ToastDecision, string>> = {
  allow: 'approval.allow',
  deny: 'approval.deny',
};

/**
 * The buttons to attach to a notification, in the user's language and in the
 * order `press()` decodes.
 *
 * Built from `DECIDE_BUTTONS` rather than written out, so the array that maps
 * an OS-reported INDEX to a verdict is also the array that decides what each
 * index is LABELLED. Writing the labels separately is how a reorder sends the
 * opposite of what the user pressed.
 *
 * The return shape is `Electron.NotificationAction`-compatible by structure and
 * not by import: this module stays electron-free (see the header) so that
 * everything here is testable without a desktop.
 */
export function decideButtonActions(
  t: Translate
): Array<{ type: 'button'; text: string }> {
  return DECIDE_BUTTONS.map((d) => ({ type: 'button' as const, text: t(DECIDE_BUTTON_KEYS[d]) }));
}

/**
 * Which platforms can actually show a button on a toast — **verified against
 * Electron 43's own API docs, not assumed** (the standing rule: never guess a
 * contract).
 *
 * `NotificationConstructorOptions.actions` and the `'action'` event are both
 * annotated `@platform darwin,win32` in `electron.d.ts` (generated from
 * `docs/api/notification.md`); Windows toast actions landed in the 40.x line.
 * The old folklore that actions are macOS-only is out of date, and this
 * codebase would have been wrong to act on it.
 *
 * Linux gets no buttons — gnome/KDE notification actions are not exposed
 * through Electron's `Notification` — so there the toast is a one-gesture
 * SHORTCUT instead: clicking it raises the app onto the card that is asking.
 * That path is wired on every platform, because it is also the honest fallback
 * for the two cases where buttons are supported but may not render: an unsigned
 * macOS build (Apple requires a signed app with `NSUserNotificationAlertStyle`
 * = `alert`), and a Windows dev run with no Start-Menu shortcut carrying the
 * AppUserModelID + ToastActivatorCLSID.
 */
export function toastActionsSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/** The one thing this module needs from a live OS notification. */
export interface ClosableToast {
  close(): void;
}

export interface PermissionToastDeps {
  /**
   * The app's single decision path. Returns FALSE when nothing holds that
   * request any more — a session that died, or a verdict that already landed
   * from another surface.
   */
  decide: (requestId: string, decision: ToastDecision, reason?: string) => boolean;
  /** raise the app onto the card that is asking (the click path) */
  reveal: (cardId: string | null) => void;
  log?: Logger;
}

/**
 * The live toasts, keyed by the request each one is asking about.
 *
 * The map exists for WITHDRAWAL. A permission answered in the approval bar
 * while a toast for it is sitting in the notification centre leaves a button
 * that looks live and is not — press it and the CLI has long since moved on.
 * `withdraw` is called from both permission routers' `onPermissionResolved`,
 * so every decision (including one made by this toast) takes its own toast
 * down.
 */
export class PermissionToasts {
  private readonly open = new Map<string, ClosableToast>();

  constructor(private readonly deps: PermissionToastDeps) {}

  /** how many toasts are currently believed to be on screen (tests, logging) */
  get size(): number {
    return this.open.size;
  }

  /**
   * Remember a toast we just showed. A second toast for the same request
   * replaces the first — `show()` on a fresh notification supersedes the old
   * one at the OS level anyway, so keeping the stale handle would mean
   * withdrawing the wrong object.
   */
  track(requestId: string, toast: ClosableToast): void {
    this.open.get(requestId)?.close?.();
    this.open.set(requestId, toast);
  }

  /**
   * A button was pressed. `index` is what the OS reported.
   *
   * An index we did not attach decides NOTHING: a desktop that reports a
   * button we never rendered is telling us something we do not understand, and
   * guessing "they probably meant allow" is the one failure mode a permission
   * prompt may never have.
   */
  press(requestId: string, index: number): boolean {
    const decision = DECIDE_BUTTONS[index];
    if (!decision) {
      this.deps.log?.warn('a permission toast reported a button this build never attached', {
        requestId,
        index,
      });
      return false;
    }
    return this.decide(requestId, decision);
  }

  /**
   * Send the verdict. Public because it is also the seam a test — and any
   * future surface — answers through.
   *
   * A request nobody holds any more is the DEAD-SESSION case: the session
   * exited, or the bar answered first, and the toast outlived it. It logs and
   * withdraws itself; it must never throw, because this runs on an OS callback
   * in the main process where an exception is a crash dialog (P6).
   */
  decide(requestId: string, decision: ToastDecision): boolean {
    let delivered = false;
    try {
      delivered = this.deps.decide(requestId, decision);
    } catch (err) {
      this.deps.log?.warn('a permission toast decision threw', {
        requestId,
        decision,
        error: String(err),
      });
    }
    // Both outcomes are logged at the level they deserve: a delivered verdict
    // is a thing the user did (info), an undelivered one is a button that did
    // nothing and is exactly what someone greps for afterwards (warn).
    if (delivered) {
      this.deps.log?.info('permission decided from an OS toast', { requestId, decision });
    } else {
      this.deps.log?.warn('a permission toast answered a request nobody is holding', {
        requestId,
        decision,
      });
    }
    // Either way the toast is stale: the verdict landed, or there was nothing
    // to land on.
    this.withdraw(requestId);
    return delivered;
  }

  /**
   * The toast BODY was clicked — not a verdict, a shortcut. Raise the app onto
   * the card that is asking and let the approval bar do the rest.
   *
   * This is deliberately NOT "allow": a click is how you dismiss a notification
   * by reflex, and reflex must not be able to grant a tool call.
   */
  activate(requestId: string, cardId: string | null): void {
    this.deps.log?.info('a permission toast was clicked', { requestId, cardId: cardId ?? '' });
    try {
      this.deps.reveal(cardId);
    } catch (err) {
      this.deps.log?.warn('raising the window from a permission toast failed', {
        requestId,
        error: String(err),
      });
    }
    // The toast has done its job; the window is the surface now.
    this.withdraw(requestId);
  }

  /**
   * This request was decided (or released) somewhere — the bar, the Events
   * panel's inline buttons, the batch band, a session teardown, or this toast.
   * Take the toast down.
   *
   * A toast is tracked until its request resolves, NOT until the OS says the
   * toast closed — deliberately, and Electron's own docs are why: on Windows a
   * toast that times out emits `close` and then **lives on in the Action
   * Center**, where `close()` still removes it. Dropping the handle on that
   * event would leave exactly the artefact this method exists to prevent, a
   * live-looking **Allow** for a question that was settled ten minutes ago.
   * Nothing leaks: every permission resolves (a verdict, or the teardown
   * releasing its holds), and every resolution comes through here.
   *
   * Idempotent and never throws: `close()` on a notification the OS has already
   * retired is allowed to fail, and a failure here must not cost the caller,
   * which is a permission router mid-decision.
   */
  withdraw(requestId: string): void {
    const toast = this.open.get(requestId);
    // The common case by far: every permission in the app resolves through
    // here, and almost none of them had a toast. Nothing to log, nothing to do.
    if (!toast) return;
    this.open.delete(requestId);
    // The e2e proof that a verdict from another surface really takes the toast
    // down (`e2e/permission-toast.spec.ts`) — and, in the field, the line that
    // says a stale Allow button was cleaned up rather than left live.
    this.deps.log?.info('permission toast withdrawn', { requestId });
    try {
      toast.close();
    } catch (err) {
      this.deps.log?.warn('withdrawing a permission toast failed', {
        requestId,
        error: String(err),
      });
    }
  }

  /** Every toast goes — used when the app is shutting down. */
  withdrawAll(): void {
    for (const requestId of [...this.open.keys()]) this.withdraw(requestId);
  }
}

/** Keys worth showing, most specific first — the same fields the bar renders. */
const DETAIL_KEYS = [
  'command',
  'file_path',
  'path',
  'url',
  'pattern',
  'notebook_path',
  'description',
  'prompt',
] as const;

const MAX_DETAIL = 90;

/**
 * Can this request be answered by pressing a button on a toast? (#563)
 *
 * No, for `AskUserQuestion`, and the measurement is what makes it a rule rather
 * than a preference: an allow with no `answers` gets **"The user did not answer
 * the questions."** back from the CLI (probe mode `empty`). So an **Allow**
 * button on a question would not answer it — it would SKIP it, silently, from a
 * notification, which is the worst possible place to discover you have thrown
 * away something the session was waiting on. A question's toast is a click
 * shortcut to the card and nothing else; the panel is the only surface that can
 * carry an answer, because the answer is a list of choices and a toast has no
 * room for one.
 */
export function answerableFromToast(req: PermissionRequest): boolean {
  return req.tool !== ASK_USER_QUESTION_TOOL;
}

/**
 * What the toast says a press would allow.
 *
 * This is the safety half of the item, not decoration. A toast with an Allow
 * button that says only "needs permission" asks the user to grant a tool call
 * they cannot see — which is worse than no toast at all, because the app's
 * whole promise here (§5.9, PHILOSOPHY P6) is that a decision made from the
 * notification is the same decision they would have made from the bar.
 *
 * Wording tracks the approval bar's own header ("Allow Edit?") so the two
 * surfaces are recognisably the same question — except for a QUESTION, which
 * has no buttons and therefore nothing to be recognisable with.
 *
 * TRANSLATED SINCE #471. `approval.title` is literally the bar's key, so the
 * two headers cannot drift in ANY language. What is NOT translated is the
 * `detail` — a shell command, a file path, the CLI's own `reason`. That is
 * §5.21's last bullet doing its job: *we translate our chrome, not CLI output.*
 */
export function permissionSummary(req: PermissionRequest, t: Translate): string {
  // A question says what it is asking, never "Allow AskUserQuestion?" — the
  // toast has no buttons for it (see `answerableFromToast`), so its whole job
  // is to make the click worth making.
  if (req.tool === ASK_USER_QUESTION_TOOL) {
    const questions = parseAskUserQuestion(req.input ?? {});
    const first = questions?.[0];
    if (first) {
      const text = first.question.trim().replace(/\s+/g, ' ');
      const shown = text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
      // Plural when there is more to answer than the line can show, so the
      // click is not a surprise. An ICU `plural` block rather than a ternary
      // over two keys: "(+1 more)" is a count, and a language whose plural
      // rules do not match English's must be free to say it differently.
      return t('notification.question', { question: shown, more: questions.length - 1 });
    }
    return t('notification.questionFallback');
  }
  const tool = req.displayName || req.tool || t('notification.unknownTool');
  const input = req.input ?? {};
  let detail = '';
  for (const key of DETAIL_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) {
      detail = v.trim().replace(/\s+/g, ' ');
      break;
    }
  }
  // The CLI's own prose, when it gave us any, beats a guessed field: it is the
  // only text here we did not write (P7 — host, don't reimplement).
  if (!detail && typeof req.reason === 'string' && req.reason.trim()) {
    detail = req.reason.trim().replace(/\s+/g, ' ');
  }
  if (detail.length > MAX_DETAIL) detail = `${detail.slice(0, MAX_DETAIL - 1)}…`;
  // Two keys, not a concatenation: word order between the question and its
  // subject is a translator's business, not ours.
  return detail
    ? t('notification.permissionDetail', { tool, detail })
    : t('approval.title', { tool });
}
