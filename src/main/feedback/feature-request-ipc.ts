// Help ▸ Feature request… — the one channel (#1008).
//
// ONE CHANNEL, AND IT CARRIES TEXT, NOT A URL. The renderer sends a title, some
// details and which of the two channels the user picked; MAIN composes the
// `mailto:` or the `issues/new` address from constants it holds and hands that
// to the OS. The obvious shorter version — let the window compose the URL and
// pass it through `shell.openExternal` — would put an arbitrary, renderer-built
// string in front of `shell.openExternal`, which is the one door in this app
// that reaches outside it. The renderer runs rendered markdown; it does not get
// to name the destination. `update:openExternal` draws the same line a different
// way (an allowlist over a URL it did not build); this one never takes a URL at
// all.
//
// NOTHING IS SENT FROM HERE. Both channels end in someone else's application
// with a form already filled in, waiting on the user's own Send button. That is
// the P8 (local-first, no telemetry) story and it is a hard constraint of the
// item, not a preference — there is no code path in this file that could post
// anything even if it wanted to.
import { shell } from 'electron';
import { IpcBroker } from '../ipc/broker';
import type { Logger } from '../log/logger';
import {
  featureUrlFor,
  isSendable,
  type FeatureRequestDraft,
  type FeedbackChannel,
  type FeedbackResult,
} from '../../shared/feedback';

/** The one bit of electron this touches, injectable so tests need no app. */
export interface FeedbackShell {
  openExternal(url: string): Promise<void>;
}

export const electronFeedbackShell: FeedbackShell = {
  openExternal: (url) => shell.openExternal(url),
};

export interface FeatureRequestIpcDeps {
  broker: IpcBroker;
  log: Logger;
  sh?: FeedbackShell;
}

/** Whatever crossed the wire, narrowed to something we are willing to compose. */
export function sanitizeDraft(raw: unknown): FeatureRequestDraft {
  const d = (raw ?? {}) as Partial<FeatureRequestDraft>;
  const channel: FeedbackChannel = d.channel === 'ticket' ? 'ticket' : 'email';
  return {
    title: typeof d.title === 'string' ? d.title.trim() : '',
    details: typeof d.details === 'string' ? d.details : '',
    channel,
  };
}

export function registerFeatureRequestIpc(deps: FeatureRequestIpcDeps): void {
  const { broker, log } = deps;
  const sh = deps.sh ?? electronFeedbackShell;

  broker.handle('feedback:featureRequest', async (_e, raw: unknown): Promise<FeedbackResult> => {
    const draft = sanitizeDraft(raw);
    if (!isSendable(draft)) {
      return { ok: false, channel: draft.channel, problem: 'empty-details' };
    }

    // THE COMPOSITION IS INSIDE THE TRY, not above it. This handler's promise
    // is that every outcome is a reportable result — and a throw from building
    // the string would have escaped that promise entirely, rejecting the invoke
    // and reaching the dialog as "could not send", which is a diagnosis of the
    // wrong thing. That was not hypothetical: `encodeURIComponent` throws on a
    // lone surrogate, so a long request with an emoji in it did exactly this
    // until `clampEncoded` learned where a character ends.
    let url = '';
    try {
      url = featureUrlFor(draft);
      await sh.openExternal(url);
    } catch (err) {
      // `openExternal` REJECTS when the OS has no handler for the scheme — a
      // machine with no mail client registered is the everyday case, not an
      // exotic one. Reported rather than swallowed (#896's lesson): the dialog
      // closes on success, so a hand-off that never happened would close the
      // window and take the user's words with it.
      //
      // THE ERROR'S NAME, NOT ITS MESSAGE. An `openExternal` rejection is
      // platform-dependent and could quote the URL it was handed — which is the
      // user's own words, percent-encoded. These logs are what the diagnostic
      // bundle zips and what a problem report posts to GitHub, so a message
      // that might carry the body would smuggle it into the one place in this
      // app where local text really leaves the machine.
      log.warn('could not hand the feature request to the OS', {
        channel: draft.channel,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return { ok: false, channel: draft.channel, problem: 'send-failed' };
    }

    // The CHANNEL and the SIZE, never the words. What someone asks the app to
    // do is theirs; the log exists to answer "did the button do anything", and
    // it can answer that without quoting them.
    log.info('feature request handed off', { channel: draft.channel, chars: url.length });
    return { ok: true, channel: draft.channel };
  });
}
