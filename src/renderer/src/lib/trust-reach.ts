// How far the workspace's trust setting can actually reach (#397).
//
// THE MEASUREMENT. #384 proved it twice — at the bare CLI with a stripped
// isolated home and the exact flag list, and again through the app with
// `autoTrust: false` — that in `--input-format stream-json` mode the CLI draws
// NO trust prompt: not on the stream, not in a dialog, not anywhere. It simply
// runs in the folder. `e2e/real-claude.spec.ts` pins that behaviour, and the
// day the CLI starts asking, that test is what goes red.
//
// So on the Direct transport, choosing 🔒 ask trust cannot get you ASKED.
//
// AND SINCE THE #397 FOLLOW-UP, IT CANNOT GET YOU PRE-ACCEPTED EITHER. The
// first review of this file flagged the gap: `sessions:create` used to pre-write
// `hasTrustDialogAccepted` into the user's real `~/.claude.json`
// (`main/sessions/trust.ts`) on EVERY spawn, transport included — so with the
// chip greyed out and auto-trust defaulting ON, a folder's first Direct session
// accepted it for good, and the escape hatch this module's tooltip points at
// ("switch a session to Terminal and you will be asked") was only reachable
// before that first run. Dan's answer, 2026-08-13: gate the write on the
// transport the spawn will actually use. It is measured, not assumed — the
// probe run that day (claude 2.1.226) showed an untrusted folder in stream mode
// running normally, loading project settings, firing project hooks, and leaving
// no record of itself in `~/.claude.json`. Nothing is lost by not writing.
//
// That is what makes the greyed chip HONEST rather than merely asserted: while
// it is inert, the setting it controls has no effect of any kind, question or
// write.
//
// THE CONSEQUENCE FOR THE UI. Direct is the default transport
// (`shared/transport.ts`), so the title bar was offering a setting that, for
// most workspaces, changes nothing at all. PHILOSOPHY P7 as amended (§6): a
// decision the CLI keeps, we may not fake — "we say so plainly". Greying the
// chip out is the plain version. Dan, 2026-08-11: *"disable on Direct — grey
// the 🔒 ask option out on Direct sessions with a tooltip explaining trust
// prompts only exist on the Terminal transport"*. An app-side ask (gating on
// `can_use_tool`) was considered on the same sitting and NOT chosen.
//
// WHY THE RULE IS WORKSPACE-WIDE AND NOT PER-SESSION. `autoTrust` is ONE
// workspace setting (`main/workspace/store.ts`), read once per spawn in
// `sessions:create`, and its control is ONE chip in the title bar. There is no
// per-session trust control to grey out. So the honest question the chip can
// answer is the workspace-wide one: *is there any card whose next session could
// be asked?* — which is true exactly when some card will spawn on the Terminal.
//
// Pure, so the rule is testable without React.

import { DEFAULT_SESSION_TRANSPORT, type TransportKind } from '../../../shared/transport';

/** The i18n key naming why the trust chip is inert, when it is. */
export const TRUST_INERT_REASON_KEY = 'titlebar.trustInert';

/**
 * Can the workspace's trust setting change what any session does?
 *
 * True when at least one card will spawn on the Terminal transport, because
 * that is the only transport on which Claude Code raises a trust question at
 * all. False for an all-Direct workspace — including an empty one, where the
 * honest answer is still "nothing here would notice".
 *
 * WHICH TRANSPORT IS COUNTED — the pending-restart question. A card's transport
 * choice and the trust setting are both NEXT-SPAWN settings: the CLI can change
 * neither on a live session, and `sessions:create` reads both when it starts
 * one. So the transport that decides whether trust can matter is the one the
 * card will START on, not the one it happens to be running now. That is why
 * `sessions:cards` reports the chosen transport and this rule consumes it.
 *
 * The safer-looking alternative — count the RUNNING transport, since a pending
 * choice can still be reverted — is the one that breaks the only workflow this
 * setting has. The manual's advice for a folder you want to be asked about is
 * "open it in Terminal mode the first time": you switch the card, then restart.
 * Gated on the running transport the chip would stay dead through both steps
 * and only wake up AFTER the spawn that needed it had already read `autoTrust`.
 * Being early here costs nothing — the worst case is a live chip on a workspace
 * whose one Terminal card gets reverted before it ever restarts, and the
 * setting is a preference, not an action.
 *
 * A card whose transport is `undefined` counts as the default (Direct today),
 * never as Terminal: main computes this field, and if it ever stops, silence
 * must not be read as "a prompt could happen here".
 */
export function trustSettingReaches(
  cards: readonly { transport?: TransportKind }[]
): boolean {
  return cards.some((c) => (c.transport ?? DEFAULT_SESSION_TRANSPORT) === 'pty');
}
