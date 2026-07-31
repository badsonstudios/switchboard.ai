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

/** The persisted card this start is for, if it already existed. */
export interface PriorCard {
  providerId?: string;
  nativeSessionId?: string;
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
  /** watch transcripts under this root; undefined = do not watch at all */
  transcriptsRoot?: string;
  /** build injectable settings for the spawned session; undefined = inject
   *  nothing, and do not register a hook token either */
  buildSettings?: (sessionId: string) => Record<string, unknown>;
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

  // Resume only when the provider says this conversation is really there. The
  // capability is asked BEFORE the id is used, because a stale id is not
  // harmless: it makes the CLI exit at spawn and the card crash.
  const nativeId = input.prior?.nativeSessionId;
  const resumable =
    !!nativeId && !!safely('resume.canResume', () => caps?.resume?.canResume(input.folder, nativeId));

  // An adapter that cannot say WHERE its transcripts are has, for our purposes,
  // no transcripts: watching "" would poll a directory that does not exist
  // forever and report nothing, which reads like a bug rather than a provider
  // without the feature.
  const root = caps?.transcripts
    ? safely('transcripts.projectsRoot', () => caps.transcripts!.projectsRoot())
    : undefined;

  return {
    providerId,
    resumeSessionId: resumable ? nativeId : undefined,
    transcriptsRoot: root || undefined,
    buildSettings: caps?.hooks
      ? (id) => safely('hooks.settingsFor', () => caps.hooks!.settingsFor(id, host)) ?? {}
      : undefined,
    ensureTrusted: caps?.trust
      ? (folder) => safely('trust.ensureTrusted', () => caps.trust!.ensureTrusted(folder)) ?? false
      : undefined,
    warnings,
  };
}
