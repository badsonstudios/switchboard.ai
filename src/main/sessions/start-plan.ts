// What starting a session actually DOES, decided from the provider's declared
// capabilities rather than from knowing it is Claude (P2-E15-01, §5.3,
// AR-P0-1).
//
// This used to be four assumptions inlined in `ipc.ts`: providerId was the
// literal 'claude-code', hook settings were always built, `~/.claude/projects`
// was always watched, and resume eligibility was decided by calling a
// Claude-shaped helper directly. Each was invisible until you tried to write a
// second adapter, at which point you would have had to edit the consumer — the
// exact failure §5.23's seam exists to prevent.
//
// It is a pure function on purpose. "No Claude-specific branch remains in the
// session IPC" is a claim about DECISIONS, and decisions you can call in a test
// are the only ones you can prove.
//
// Everything an adapter is asked here is FAIL-OPEN. A contributor that throws
// degrades that one capability to absent — it never takes the session start
// down with it, because a session that will not start is worse than a session
// with no transcript pane (PHILOSOPHY: our breakage must not block a session).
import { HookSettingsHost, ProviderCapabilities } from '../extensibility/contributions';
import { NativeLineage, resumeCandidates } from './lineage';

/** The persisted card this start is for, if it already existed. */
export interface PriorCard extends NativeLineage {
  providerId?: string;
  /** `nativeSessionId` and `nativeSessionLineage` come from `NativeLineage` —
   *  the chain, not a single id, since #484. */
}

export interface StartPlanInput {
  /** what an adapter says it can do; undefined for an unknown id, and for an
   *  adapter that declares nothing */
  capabilitiesOf: (providerId: string) => ProviderCapabilities | undefined;
  /** is this provider actually available right now? */
  isRegistered: (providerId: string) => boolean;
  /** the provider a card without one runs on — a thunk, so a card that already
   *  names a registered provider never even asks */
  defaultProviderId: () => string;
  folder: string;
  prior?: PriorCard;
  /**
   * Every native id any card in the workspace points at, head or ancestor
   * (#484). Only read when a card's whole chain came up empty and the provider
   * offers to look for the conversation it lost — the list is what stops that
   * search handing back a conversation another card is already in. A thunk
   * because the common start never asks.
   *
   * REQUIRED, and the repair is skipped outright when it throws. It is
   * documented in three places as the guarantee that two cards cannot end up in
   * one conversation, and a guarantee that quietly degrades to `[]` — because a
   * caller omitted it, or because reading the workspace threw — is not one. A
   * repair declined costs the user one relaunch; a repair made without this list
   * can put a card into a conversation another card is in.
   */
  claimedNativeIds: () => string[];
  /**
   * Called when something degraded. A SINK rather than a returned list,
   * because two of the decisions are lazy — `buildSettings` runs later inside
   * the session manager, `ensureTrusted` after the caller has already read the
   * plan. A list would be drained before those ever fired, which is how a
   * provider that throws at spawn time became invisible.
   */
  onDegraded?: (reason: string) => void;
}

export interface StartPlan {
  /** which adapter this session runs on */
  providerId: string;
  /** native conversation to resume, or undefined for a fresh session */
  resumeSessionId?: string;
  /**
   * WHERE that id came from (#484) — the card's head id, one of its ancestors,
   * or a conversation the provider found lying unclaimed in the folder.
   *
   * Reported because the last two are recoveries, and a recovery that happens
   * silently is indistinguishable from the bug it repairs: "my card came back
   * in the right conversation" and "my card came back in SOME conversation"
   * need to be different lines in the log. Undefined exactly when
   * `resumeSessionId` is.
   */
  resumedVia?: 'stored' | 'lineage' | 'adopted';
  /** watch transcripts under this root; undefined = do not watch at all */
  transcriptsRoot?: string;
  /**
   * Pull a conversation title out of one transcript line (§5.11, P2-E7-06).
   * Undefined = this provider has no titles, so no line is ever inspected for
   * one and the task label is never auto-filled.
   *
   * Wrapped in the same fail-open guard as the rest: a contributor that throws
   * on a line degrades to "this line has no title", not to a lost transcript.
   */
  readTitle?: (line: Record<string, unknown>) => string | undefined;
  /** build injectable settings for the spawned session; undefined = inject
   *  nothing, and do not register a hook token either */
  buildSettings?: (sessionId: string) => Record<string, unknown>;
  /** Undo `buildSettings` for a session that never started (#470). Present
   *  exactly when `buildSettings` is — the pair is the hooks capability being
   *  declared at all — and it releases the HOST's state (the token), which is
   *  why it goes straight to the host and never through the adapter: the
   *  adapter only ever shaped what the host had already registered. */
  releaseSettings?: (sessionId: string) => void;
  /** Prepare the folder for this provider (Claude's trust prompt, §5.9).
   *  Undefined = this provider needs nothing done to the folder. Returns false
   *  when the provider could not do it, so the caller can say so — a silent
   *  auto-trust failure is a trust dialog the user cannot explain. */
  ensureTrusted?: (folder: string) => boolean;
  /** what degraded during PLANNING. The lazy closures report through
   *  `onDegraded` instead — see the note there. */
  warnings: string[];
}

/**
 * Decide how to start a session. Every branch here is driven by a declared
 * capability; nothing in it knows which provider it is talking about.
 */
export function planSessionStart(input: StartPlanInput, host: HookSettingsHost): StartPlan {
  const warnings: string[] = [];
  const degraded = (reason: string): void => {
    warnings.push(reason);
    input.onDegraded?.(reason);
  };
  const safely = <T>(what: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (err) {
      degraded(`provider capability "${what}" threw: ${String(err)}`);
      return undefined;
    }
  };

  // A card that already exists keeps the provider it was created with. Reading
  // the default here instead would silently migrate an existing card onto a
  // different CLI the day the default changes — and its persisted native
  // session id would then belong to a provider that never wrote it.
  //
  // Unless that provider is GONE: a card persisted under an adapter that is no
  // longer registered would otherwise be unstartable for ever, since spawning
  // resolves the adapter and throws. Falling back to the default degrades one
  // card instead of bricking it, and the id is rewritten on the way past.
  const wanted = input.prior?.providerId || '';
  let providerId = wanted;
  if (wanted) {
    // undefined means the CHECK failed, which is not the same as "not there" —
    // saying "provider x is not registered" when the lookup threw would send
    // the next reader hunting for a registration bug that does not exist
    const registered = safely('isRegistered', () => input.isRegistered(wanted));
    if (!registered) {
      degraded(
        registered === undefined
          ? `could not tell whether provider "${wanted}" is registered — falling back to the default`
          : `provider "${wanted}" is not registered — falling back to the default`
      );
      providerId = '';
    }
  }
  if (!providerId) {
    providerId = input.defaultProviderId();
    // The fallback is the one provider nothing else vouches for. If it is not
    // registered either, spawning throws and the card is exactly as unstartable
    // as the case this branch exists to prevent — so say so here, where the
    // reason is still known.
    if (safely('isRegistered', () => input.isRegistered(providerId)) === false) {
      degraded(`the default provider "${providerId}" is not registered either`);
    }
  }

  const caps = safely('capabilitiesOf', () => input.capabilitiesOf(providerId));

  // An adapter that cannot say WHERE its transcripts are has, for our purposes,
  // no transcripts: watching "" would poll a directory that does not exist
  // forever and report nothing, which reads like a bug rather than a provider
  // without the feature.
  //
  // Resolved BEFORE the resume decision, and that order is load-bearing (#432).
  // THIS is the session's transcript root — the one string the watcher polls,
  // the one a resumed Direct session replays its history out of (#395), and
  // therefore the one `canResume` is asked about below. It used to be asked
  // about whatever root the adapter derived for itself, which made one contract
  // two independent declarations: a provider that answered from a root the host
  // never reads would resume and then show nothing.
  const root = caps?.transcripts
    ? safely('transcripts.projectsRoot', () => caps.transcripts!.projectsRoot())
    : undefined;
  const transcriptsRoot = root || undefined;

  // Resume only when the provider says this conversation is really there. The
  // capability is asked BEFORE the id is used, because a stale id is not
  // harmless: it makes the CLI exit at spawn and the card crash.
  //
  // Note what this makes `resume` — unlike `titles` below — deliberately NOT
  // independent of `transcripts`: a provider whose root could not be resolved is
  // asked about `''`, and one that answers out of a transcript therefore says
  // no, so the card starts FRESH. That loses a resume we might have got away
  // with; it is the trade this item chose, because the alternative is resuming
  // against a directory the host will not read, which is a session that looks
  // wiped. A provider that resumes on some other authority is unaffected — it
  // ignores the root and still gets to say yes.
  //
  // And it is asked about the whole CHAIN, not one id (#484). A card's newest
  // id is recorded the moment the CLI announces one, and the CLI writes no
  // transcript for it until a real turn happens (S-07) — so a card whose last
  // session got no prompt points at a file that does not exist while its real
  // history sits under an earlier id. Walking the ancestors puts that card back
  // where it was; stopping at the head is what made it start fresh instead.
  const candidates = resumeCandidates(input.prior);
  let resumeSessionId: string | undefined;
  let resumedVia: StartPlan['resumedVia'];
  // A capability that throws is degraded ONCE and then not asked again, the
  // same ruling `titles` gets below: `safely` reports on every call, and a
  // provider whose check throws would otherwise post one warning per ancestor
  // for a fault the reader already knows about.
  let resumeBroken = false;
  // A provider that declares no `resume` at all is asked nothing — walking a
  // ten-deep chain to call `undefined?.canResume` ten times says the same thing
  // slower, and leaves a reader wondering which of the two absences the loop is
  // for.
  for (const nativeSessionId of caps?.resume ? candidates : []) {
    if (resumeBroken) break;
    const before = warnings.length;
    const yes = safely('resume.canResume', () =>
      caps?.resume?.canResume({
        // exactly what this plan exposes, not a second reading of the
        // capability — "" for a provider that declares no transcripts at all
        projectsRoot: transcriptsRoot ?? '',
        folder: input.folder,
        nativeSessionId,
      })
    );
    if (yes === undefined && warnings.length > before) resumeBroken = true;
    if (yes) {
      resumeSessionId = nativeSessionId;
      resumedVia = nativeSessionId === input.prior?.nativeSessionId ? 'stored' : 'lineage';
      break;
    }
  }

  // Nothing in the chain is on disk — but this card HELD a conversation once,
  // which is the precondition that makes the next question safe to ask. A card
  // with no history to lose is never offered one, so a fresh session in a
  // folder full of old transcripts cannot adopt a stranger's.
  //
  // Cards orphaned BEFORE the chain existed are the reason this exists at all:
  // they carry an id with no transcript, no ancestors, and their real history
  // under an id nothing now refers to. The lineage prevents the next one; only a
  // look in the folder recovers the ones already made.
  //
  // A CEDED ID IS NOT A TICKET TO A REPAIR (#539), and this is deliberately
  // `candidates.length` and not "has this card ever held a conversation". A card
  // that gave its only conversation to a duplicate holds nothing resumable, so
  // widening the precondition to include ceded ids reads like the kind thing to
  // do — and it is exactly wrong. The adoption rests on one inference: *my
  // conversation is genuinely missing from disk, so the newest unclaimed one in
  // this folder is probably the one I lost.* For a ceded card the evidence is
  // the opposite — its conversation is present and demonstrably someone else's —
  // and `ownIds` would be EMPTY, so the adapter's own "are they really absent?"
  // guard becomes vacuous at the same moment. It would take the newest unrelated
  // transcript in a busy folder and append the user's next turn to it. So a
  // fully-ceded card starts fresh, keeps its ceded pointer, and the notice plus
  // the manual's hand-edit are the way back.
  if (!resumeSessionId && !resumeBroken && candidates.length > 0 && caps?.resume?.findOrphaned) {
    // NOT `?? []`. This list is the guarantee that two cards cannot end up in
    // one conversation, so a workspace read that threw skips the repair rather
    // than performing it with the guard silently empty.
    const claimed = safely('claimedNativeIds', input.claimedNativeIds);
    const found =
      claimed &&
      safely('resume.findOrphaned', () =>
        caps.resume!.findOrphaned!({
          projectsRoot: transcriptsRoot ?? '',
          folder: input.folder,
          // every OTHER card's chain, so two cards cannot end up in one
          // conversation...
          claimed: claimed.filter((id) => !candidates.includes(id)),
          // ...and this card's own, which is both unofferable and the list the
          // provider must re-verify before it answers at all (see
          // `findOrphaned`: `canResume` said no, which does not distinguish
          // "not there" from "could not look")
          ownIds: candidates,
        })
      );
    if (found) {
      resumeSessionId = found;
      resumedVia = 'adopted';
      // Not a failure — a repair — but it goes through the same sink because
      // it is the one resume outcome the user might disagree with, and the
      // caller logs everything that arrives here against the card.
      degraded(
        `the conversation this card recorded is not on disk; reattaching it to "${found}", the newest unclaimed conversation in this folder`
      );
    }
  }

  // Deliberately NOT gated on `root`: the two are independent declarations and
  // reading a title costs nothing extra, because the host is already tailing.
  // A provider that declared titles but no transcripts would simply never be
  // asked — nothing tails, so no line reaches this.
  //
  // The ONE capability asked per TRANSCRIPT LINE rather than once per session,
  // so it cannot use `safely` as-is: that appends to `warnings` and calls
  // `onDegraded` on every throw, and a provider whose reader throws would grow
  // an unbounded array and flood the log at transcript speed. A throw here
  // degrades `titles` to ABSENT for the rest of the session — reported once,
  // then never asked again, which is also what `TitleCapability` promises. The
  // session keeps its transcript, its Feed and its usage totals; it just does
  // not get labels.
  let titlesBroken = false;
  const readTitle = caps?.titles
    ? (line: Record<string, unknown>): string | undefined => {
        if (titlesBroken) return undefined;
        try {
          return caps.titles!.titleFrom(line);
        } catch (err) {
          titlesBroken = true;
          degraded(`provider capability "titles.titleFrom" threw: ${String(err)}`);
          return undefined;
        }
      }
    : undefined;

  return {
    providerId,
    resumeSessionId,
    resumedVia,
    transcriptsRoot,
    readTitle,
    buildSettings: caps?.hooks
      ? (id) => safely('hooks.settingsFor', () => caps.hooks!.settingsFor(id, host)) ?? {}
      : undefined,
    releaseSettings: caps?.hooks
      ? (id) => {
          // NOT `safely`: its wording blames a "provider capability", and this
          // call deliberately bypasses the adapter — a provider that declared
          // hooks would be named for a fault entirely inside the host's
          // listener. Same sink, same fail-open, honest culprit.
          try {
            host.releaseHookSettings(id);
          } catch (err) {
            degraded(`hook host "releaseHookSettings" threw: ${String(err)}`);
          }
        }
      : undefined,
    ensureTrusted: caps?.trust
      ? (folder) => safely('trust.ensureTrusted', () => caps.trust!.ensureTrusted(folder)) ?? false
      : undefined,
    warnings,
  };
}
