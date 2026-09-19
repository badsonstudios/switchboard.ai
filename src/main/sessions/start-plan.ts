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
import {
  HookSettingsHost,
  McpAttachmentHost,
  ProviderCapabilities,
} from '../extensibility/contributions';
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
   * A conversation the USER picked out of the history list (P2-E20-01, §5.33).
   *
   * Every other resume on this path is inferred — from the card's own head id,
   * its ancestors, or the repair sweep's guess at what it lost. This one was
   * chosen, which changes two things.
   *
   * It is honoured ONLY for a card with no conversation of its own. The picker
   * always opens a NEW card (§5.33: "the card you clicked from is untouched"),
   * so a card that already has a chain is not a pick target — and refusing it
   * here means no future caller can turn a pick into a way to move an existing
   * card into somebody else's conversation, whatever the renderer sends.
   *
   * It is still asked about through `resume.canResume`, like every other
   * candidate: a picked id is untrusted renderer input and a stale one makes
   * the CLI exit at spawn. When the provider says no, this does NOT fall back
   * to a fresh session — see `requestedUnavailable`.
   */
  requestedConversationId?: string;
  /**
   * ADOPT another session's conversation by FORKING it (§5.5 Level 3,
   * P2-E11-12) — experimental, and the caller only sets this when the flag is on.
   *
   * ⚠️ THE SOURCE FOLDER IS CARRIED, AND IT IS NOT `folder`. The defining case
   * is cross-folder: session A's conversation adopted by a new card in folder B.
   * `folder` above is B — where the new session will RUN — while the transcript
   * being forked lives under A's directory. Collapsing the two would look right
   * for the same-folder case and silently answer "no such conversation" for the
   * one this feature exists for.
   *
   * Like `requestedConversationId`, honoured ONLY for a card with no
   * conversation of its own, and a fork that cannot be resolved REFUSES rather
   * than falling through to a fresh session — see `forkUnavailable`.
   */
  requestedFork?: { sourceSessionId: string; sourceFolder: string };
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
   * The Session Bus, for providers that declare the `mcp` capability
   * (P2-E11-03). Absent = no bus is wired in this build, so no session gets one
   * however loudly its adapter declares the capability.
   *
   * OPTIONAL ON PURPOSE, and not merely for tests. The bus is one of the few
   * subsystems whose absence must be a supported state rather than a broken
   * one: `main/index.ts` constructs it, `hook-check` and the e2e harness do not,
   * and a session with no siblings to talk to is a session, not a fault.
   */
  mcpHost?: McpAttachmentHost;
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
  resumedVia?: 'stored' | 'lineage' | 'adopted' | 'picked' | 'forked';
  /**
   * This start FORKS `resumeSessionId` instead of continuing it (§5.5 Level 3).
   *
   * ⚠️ WHEN THIS IS SET, `resumeSessionId` IS SOMEBODY ELSE'S CONVERSATION and
   * is for ARGV ONLY. Every other consumer of that field — the transcript
   * watch, the history replay, and above all `recordNativeId` — must use
   * `forkSessionId` instead. Writing the source id onto this card would make it
   * CLAIM a conversation another card is in, which is the #484 / #539 failure
   * the whole feature is fenced against.
   */
  forkSession?: boolean;
  /**
   * The id the forked conversation will take — minted HERE, before spawn.
   *
   * Known in advance rather than discovered, because the card has to be bound to
   * something the moment it starts. Measured (claude 2.1.272): the CLI announces
   * exactly this id on `system:init`, so the value planned here is the value the
   * session really gets.
   */
  forkSessionId?: string;
  /**
   * A fork was asked for and could not be set up — the source transcript is
   * gone, the root would not read, or this provider cannot fork at all.
   *
   * Its own field rather than folding into `requestedUnavailable`, because the
   * caller's refusal sentence differs: one says the conversation you picked
   * could not be opened, the other says this session could not be forked. Same
   * reason that one does not fall open: somebody asked for a specific thing, and
   * quietly starting an empty session instead looks like data loss.
   */
  forkUnavailable?: boolean;
  /**
   * The user picked a conversation and it could not be resumed (P2-E20-01).
   *
   * Set exactly when `requestedConversationId` was given and did not resolve —
   * the transcript is gone, the directory would not read, or the provider
   * declares no `resume` capability at all.
   *
   * IT EXISTS SO THE CALLER CAN REFUSE, and that is the one place this feature
   * deliberately does not fail open. Everywhere else a declined resume starts a
   * fresh session, which is right when nobody asked for a particular one. Here
   * somebody did: opening an empty new conversation in that folder instead
   * looks exactly like the app wiped their history, and it would do it silently.
   * P6 is about OUR breakage not blocking a session — the ordinary new-session
   * path is untouched and one click away.
   */
  requestedUnavailable?: boolean;
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
  /**
   * Build the MCP config to attach at spawn (P2-E11-03). Undefined = this
   * provider declares no `mcp` capability, so nothing is written and no
   * `--mcp-config` is passed — the session spawns exactly as it did before the
   * Session Bus existed.
   *
   * Returns `undefined` rather than `{}` when the capability is present but has
   * nothing to attach (no bus for this session, or the adapter declined). The
   * distinction matters at the call site: `{}` would still be truthy and would
   * write an empty config file and pass a flag for no servers.
   *
   * ⚠️ IT OPENS A LISTENING ENDPOINT as a side effect, so it has a release
   * pair — see `releaseMcpConfig`.
   */
  buildMcpConfig?: (sessionId: string) => Record<string, unknown> | undefined;
  /**
   * Undo `buildMcpConfig` for a session that never started. Present exactly
   * when `buildMcpConfig` is — the pair travels together, like #470's.
   *
   * THIS COMMENT USED TO SAY NO PAIR WAS NEEDED, and that was wrong (found in
   * review of #763). The reasoning was that the endpoint is torn down "on the
   * same teardown path as everything else" — but a `create` that throws never
   * gets a record, so `tearDownLive` never runs for that id and there is no
   * such path. Every failed start after the attach leaked a listening socket
   * and a live token for the life of the app.
   *
   * Goes STRAIGHT TO THE HOST, never through the adapter, for the same reason
   * `releaseSettings` does: the adapter only ever shaped a launch the host had
   * already registered, so blaming a "provider capability" for a fault entirely
   * inside our own bus would be a lie in the log.
   */
  releaseMcpConfig?: (sessionId: string) => void;
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
  let requestedUnavailable = false;
  // A capability that throws is degraded ONCE and then not asked again, the
  // same ruling `titles` gets below: `safely` reports on every call, and a
  // provider whose check throws would otherwise post one warning per ancestor
  // for a fault the reader already knows about.
  let resumeBroken = false;
  // ── ADOPTING ANOTHER SESSION'S CONVERSATION BY FORKING IT (§5.5 Level 3) ──
  //
  // Asked FIRST, and asked ONLY for a card with nothing of its own — the same
  // fence `picked` sits behind, for the same reason. A fork always opens a NEW
  // card, so a card that already has a chain is not a fork target, and refusing
  // it here means no future caller can turn a fork into a way to move an
  // existing card into somebody else's conversation.
  //
  // ⚠️ THE ID THIS RESOLVES INTO `resumeSessionId` BELONGS TO ANOTHER CARD, and
  // that is safe only because `forkSession` travels with it: the CLI is told to
  // FORK rather than continue, which was measured (claude 2.1.272) to leave the
  // source transcript byte-identical. Every downstream consumer that would
  // normally treat `resumeSessionId` as "this card's conversation" reads
  // `forkSessionId` instead — see the note on `StartPlan.forkSession`.
  let forkSession = false;
  let forkSessionId: string | undefined;
  let forkUnavailable = false;
  const fork = candidates.length === 0 ? input.requestedFork : undefined;
  if (fork) {
    if (!caps?.fork) {
      // A provider that cannot fork cannot honour this, and saying so is the
      // point: falling through would start an EMPTY session in the right folder,
      // which is the outcome that looks exactly like the history was lost.
      forkUnavailable = true;
    } else {
      const ok = safely('fork.canFork', () =>
        caps.fork!.canFork({
          projectsRoot: transcriptsRoot ?? '',
          // the SOURCE's folder — not `input.folder`, which is where the new
          // session will run. The cross-folder case is the whole feature.
          sourceFolder: fork.sourceFolder,
          sourceSessionId: fork.sourceSessionId,
        })
      );
      if (ok) {
        resumeSessionId = fork.sourceSessionId;
        resumedVia = 'forked';
        forkSession = true;
        // Minted HERE so the card can be bound before the process exists.
        // `globalThis.crypto` rather than a node:crypto import for the reason
        // `shared/stream-protocol.ts` gives — and it must be a real UUID,
        // because the CLI validates `--session-id` and refuses anything else.
        forkSessionId = globalThis.crypto.randomUUID();
      } else {
        forkUnavailable = true;
      }
    }
  }

  // ── A CONVERSATION THE USER PICKED (P2-E20-01, §5.33) ────────────────────
  //
  // Asked FIRST and asked ONLY for a card with nothing of its own. The picker
  // opens a new card every time, so `candidates.length > 0` means this is not a
  // pick target at all — an existing card keeps the conversation it has, and no
  // renderer message can move it into somebody else's.
  //
  // Through the same `canResume` as every other candidate: a picked id crossed
  // an IPC boundary, and a stale one makes the CLI exit at spawn. What differs
  // is the FAILURE — it is recorded rather than swallowed, because the caller
  // must refuse the start instead of quietly opening a fresh conversation the
  // user did not ask for (see `requestedUnavailable`).
  // `!fork` as well: a start that asked to FORK is not also a pick, and a fork
  // that failed must refuse rather than quietly trying the other door. Gated on
  // the REQUEST, not on whether it succeeded, so an unresolvable fork cannot
  // fall through into a resume of something else.
  const picked = candidates.length === 0 && !fork ? input.requestedConversationId : undefined;
  if (picked) {
    if (!caps?.resume) {
      // A provider that cannot resume cannot honour a pick. Saying so is the
      // whole point: falling through would start an empty session in the right
      // folder, which is the one outcome that looks like data loss.
      requestedUnavailable = true;
    } else {
      const before = warnings.length;
      const yes = safely('resume.canResume', () =>
        caps.resume!.canResume({
          projectsRoot: transcriptsRoot ?? '',
          folder: input.folder,
          nativeSessionId: picked,
        })
      );
      if (yes === undefined && warnings.length > before) resumeBroken = true;
      if (yes) {
        resumeSessionId = picked;
        resumedVia = 'picked';
      } else {
        requestedUnavailable = true;
      }
    }
  }

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
    requestedUnavailable,
    // §5.5 Level 3. All three are absent on every ordinary start, so nothing
    // downstream changes shape for a session that is not a fork.
    forkSession: forkSession || undefined,
    forkSessionId,
    forkUnavailable: forkUnavailable || undefined,
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
    // §5.4's Session Bus (P2-E11-03). Through the same `safely` sink as the
    // rest: an adapter that throws while shaping its config degrades to "this
    // session has no bus" and still starts, which is the only acceptable
    // direction (P6). `?? undefined` and never `?? {}` — see `buildMcpConfig`.
    //
    // `mcpHost` is the seam, and it is undefined when nothing wired a bus (the
    // whole test suite, and any build where `BusHost` is absent). A declared
    // capability with no host to serve it must attach NOTHING rather than half
    // of something.
    buildMcpConfig:
      caps?.mcp && input.mcpHost
        ? (id) =>
            safely('mcp.configFor', () => caps.mcp!.configFor(id, input.mcpHost!)) ?? undefined
        : undefined,
    releaseMcpConfig:
      caps?.mcp && input.mcpHost
        ? (id) => {
            // NOT `safely`: its wording blames a "provider capability", and this
            // deliberately bypasses the adapter. Same sink, same fail-open,
            // honest culprit — exactly `releaseSettings`' argument.
            try {
              input.mcpHost!.releaseSession(id);
            } catch (err) {
              degraded(`session bus "releaseSession" threw: ${String(err)}`);
            }
          }
        : undefined,
    ensureTrusted: caps?.trust
      ? (folder) => safely('trust.ensureTrusted', () => caps.trust!.ensureTrusted(folder)) ?? false
      : undefined,
    warnings,
  };
}
