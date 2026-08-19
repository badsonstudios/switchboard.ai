// The IPC capability vocabulary (P2-E15-04, §5.23 + §5.29, AR-P0-2).
//
// Every channel between the renderer and main declares exactly one capability.
// First-party declares all of them, so this changes nothing at runtime today —
// THAT IS THE POINT. §5.23 says "the main process is the sole enforcer", which
// until now was true only because there was nothing to enforce: the preload
// exposed ~60 hand-maintained methods with no notion of who was allowed to
// call what. Phase 4 wires a plugin's manifest into the check that now exists,
// rather than inventing the check at the moment it first matters.
//
// Shared, not main-only, because the renderer's own bootstrap will eventually
// declare what it uses, and a plugin manifest names these strings.

/**
 * Capabilities, split read/write.
 *
 * The split is the one that will matter to a plugin: "show me the sessions" is
 * a very different ask from "start one", and a contribution that only needs to
 * observe should not have to request the power to act.
 */
export const CAPABILITIES = [
  'sessions.read', // list cards, statuses, pending permissions
  'sessions.spawn', // create / resume / close a session — starts processes
  'sessions.write', // rename, task label, autonomy, permission decisions
  'pty.read', // attach to a terminal's output stream
  'pty.write', // send keystrokes to a running CLI
  'transcripts.read',
  'git.read',
  'events.read',
  'events.write', // acknowledge / dismiss
  'settings.read',
  'settings.write',
  'workspace.read',
  'workspace.write',
  'groups.read',
  'groups.write',
  'app.window', // display geometry, popout movement
  'environment.probe', // runs the CLI to read its version, stats the user's
  // home config. Named for what it DOES, not where the
  // answer is shown — "settings.read" hid a child process.
  'fs.probe', // existence/type of an arbitrary caller-supplied path
  'fs.read', // the CONTENTS of a file, scoped to open session folders plus
  // what the user picked (P2-E16-01, §5.30). Deliberately NOT
  // folded into `fs.probe`: existence-and-type is strictly less
  // power than bytes, and the whole point of splitting the
  // vocabulary is that a Phase-4 consumer can hold one without
  // the other. Same argument as `update.check` vs
  // `update.install` below.
  'dialog.open', // a NATIVE file dialog. Deliberately its own capability:
  // holding "sessions" must not imply the power to put an
  // OS dialog in front of the user.
  'update.check', // contacts the RELEASE HOST over the network and reads a
  // locally-resolved credential to do it (P2-E19-03). Named
  // for what it does, per `environment.probe`: this is the
  // only capability in the app that makes an outbound
  // request to the internet, and hiding that under
  // "settings.read" would be exactly the mislabelling that
  // precedent exists to prevent.
  'update.install', // DOWNLOADS AN EXECUTABLE AND RUNS IT (P2-E19-04). The
  // sharpest capability in the app, and deliberately not
  // folded into `update.check`: reading a version number and
  // replacing the binary on disk are not the same power, and
  // a contribution that wants the first must not silently
  // acquire the second.
  'provider.status', // reads the PROVIDER'S PUBLIC STATUS PAGE over the
  // network (P2-E14-07, §5.14). Its own capability for
  // the `update.check` reason: it is an outbound request
  // to a third-party host, and that fact must be legible
  // in the manifest rather than hidden under
  // "settings.read". Read-only and unauthenticated — it
  // sends nothing, which is what keeps §5.14 inside the
  // local-first constraint.
  'push.read', // which phone-push / webhook switches are on, and WHICH
  // credentials exist (booleans — never a value; there is no
  // channel that reads one back, see `events/push-ipc.ts`).
  'push.write', // the switches, and writing a credential INTO the OS store
  // (P2-E14-06, §5.29). Not folded into `settings.write`: the
  // `fs.read` argument applies — depositing a secret in the
  // credential store is strictly more power than flipping a
  // preference, and a Phase-4 contribution that wants the
  // second must not silently acquire the first.
  'push.send', // SENDS SESSION-DERIVED TEXT TO A THIRD-PARTY HOST the user
  // configured — the setup dialog's "Send test" (P2-E14-06).
  // Its own capability for the `update.check` / `provider.status`
  // reason, and it is the sharpest of the three: those two READ
  // from a public host, this one WRITES a session's task label
  // out of the machine.
  'shell.openExternal', // hands a URL to the user's BROWSER. Its own capability
  // for the `dialog.open` reason — putting something in
  // front of the user, outside the app, is a power in its
  // own right and is not implied by anything else.
  'shell.openPath', // hands a LOCAL PATH to the OS — "Open externally" and
  // "Reveal in folder" (P2-E16-02, §5.30). Deliberately NOT
  // folded into `shell.openExternal`, and the difference is
  // not pedantry: a URL goes to the browser, which sandboxes
  // it, while a path goes to whatever the OS has registered
  // for that extension — and for `.exe`, `.bat` or `.lnk`
  // that is EXECUTION. Sharper power, separate word. The
  // handlers behind it re-check `fs.read`'s scope, so it can
  // only ever be aimed at a file the caller could already
  // have read.
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Channel -> capability. Registration reads the channel name FROM this map, so
 * a typo is a compile error rather than a feature that silently stops working
 * — channels are strings, and nothing else would catch it.
 */
export const CHANNEL_CAPABILITIES = {
  // --- inbound: renderer calls main -------------------------------------
  // the renderer is listening for claimed chords (#90); until it says so, the
  // browser process claims none of them
  'app:acceleratorReady': 'app.window',
  // The four Cut/Copy/Paste/Select All labels for the right-click menu (#526),
  // already translated. `app.window` because that is what it is: chrome for a
  // window this caller already owns. It reads nothing and starts nothing — the
  // menu it names is built from Electron ROLES, so a caller cannot smuggle an
  // action in through a label.
  'app:contextMenuLabels': 'app.window',
  'app:movePopout': 'app.window',
  'app:raisePopout': 'app.window',
  'app:workAreas': 'app.window',
  'events:ack': 'events.write',
  'events:dismiss': 'events.write',
  'events:list': 'events.read',
  // read a file's contents — scope-checked, size-capped and refused in MAIN
  // (P2-E16-01). Its own family, because it belongs to no session.
  'fs:read': 'fs.read',
  // the document viewer's `Open file…` (P2-E16-02). It is the ONE path that
  // widens `fs.read`'s scope, and it widens it by asking the user — which is
  // why it is tagged `dialog.open` and not `fs.read`: the power being exercised
  // is "put an OS dialog in front of the user", and the grant is its result.
  'fs:pickFile': 'dialog.open',
  // a link inside a rendered document, handed to the browser (P2-E16-02)
  'fs:openExternal': 'shell.openExternal',
  // the §5.30 escape hatch: the file itself, in the user's own tools
  'fs:openPath': 'shell.openPath',
  'fs:reveal': 'shell.openPath',
  // Follow the file a viewer has open, so it re-renders when an agent rewrites
  // it (P2-E16-04). `fs.read` and not a capability of its own: it is answered by
  // the same `ReadScope`, and what it reveals — that a file you may already read
  // has changed — is strictly less than the bytes `fs:read` hands over. The
  // notice carries no content, so this cannot become a second way to read.
  'fs:watch': 'fs.read',
  'fs:unwatch': 'fs.read',
  'git:fileVersions': 'git.read',
  // the provider's service health as main currently understands it (P2-E14-07)
  'health:get': 'provider.status',
  // the polling switch is an ordinary preference, like the update auto-check
  'health:getPrefs': 'settings.read',
  'health:setPrefs': 'settings.write',
  'git:status': 'git.read',
  'groups:create': 'groups.write',
  'groups:delete': 'groups.write',
  'groups:list': 'groups.read',
  'groups:palette': 'groups.read',
  'groups:setSessionGroup': 'groups.write',
  'groups:update': 'groups.write',
  'notifications:getPrefs': 'settings.read',
  // Whether the quiet window is open right now, and how many events it has held
  // (P2-E14-05b). Reads settings plus a count of the app's own held list —
  // nothing a `notifications:getPrefs` plus a clock would not already tell you.
  'notifications:quietState': 'settings.read',
  'notifications:setPrefs': 'settings.write',
  'preflight:check': 'environment.probe',
  // Phone push + webhook (P2-E14-06, §5.9 + §5.29). Three capabilities for four
  // channels because the powers really are three: read the shape of the config,
  // write it (credential store included), and make something leave the machine.
  'push:getConfig': 'push.read',
  'push:setPrefs': 'push.write',
  'push:setSecret': 'push.write',
  'push:test': 'push.send',
  // Notification RULES (P2-E14-03). They are notification preferences that
  // happen to be per-session, so they carry the settings capabilities rather
  // than minting a pair of their own — reading one tells you nothing a
  // `notifications:getPrefs` did not, and writing one changes no more than the
  // toast toggle beside it does.
  'rules:list': 'settings.read',
  'rules:notifyWhenDone': 'settings.read',
  'rules:setNotifyWhenDone': 'settings.write',
  // Per-session sounds (P2-E14-05a) — the same reasoning as the rules above:
  // which cue a card rings is a notification preference that happens to be
  // per-session. The two PUSH channels below carry no capability of their own
  // either; they are main talking, and `send` is not a power the renderer has.
  'sounds:get': 'settings.read',
  'sounds:set': 'settings.write',
  // "I took that cue and could not play it" — the renderer's answer to
  // `audio:play`, and the thing that lets main fall back to a beep instead of
  // leaving an attention event silent. It reads nothing and changes nothing;
  // `settings.read` is the narrowest tag that fits.
  'audio:failed': 'settings.read',
  'pty:attach': 'pty.read',
  'pty:detach': 'pty.read',
  'pty:input': 'pty.write',
  'pty:resize': 'pty.write',
  'sessions:allowAllSession': 'sessions.write',
  'sessions:cards': 'sessions.read',
  'sessions:closeCard': 'sessions.spawn',
  'sessions:create': 'sessions.spawn',
  'sessions:decidePermission': 'sessions.write',
  'sessions:submitPrompt': 'sessions.write',
  'sessions:setTransport': 'sessions.write',
  'sessions:interrupt': 'sessions.write',
  'sessions:dropLive': 'sessions.spawn',
  'sessions:isDirectory': 'fs.probe',
  // What the app repaired about a card's conversation history this run (#539) —
  // adopted or ceded. `sessions.read`: it says which card is in which
  // conversation, which `sessions:cards` already tells this caller.
  'sessions:historyRepairs': 'sessions.read',
  // "I have read that" — the only way a history notice leaves. `sessions.write`
  // and not `.read`: it edits persisted workspace state.
  'sessions:dismissHistoryRepair': 'sessions.write',
  'sessions:knownCards': 'sessions.read',
  'sessions:list': 'sessions.read',
  'sessions:pendingPermissions': 'sessions.read',
  'sessions:pickFolder': 'dialog.open',
  'sessions:rename': 'sessions.write',
  'sessions:renameCard': 'sessions.write',
  'sessions:setAutonomy': 'sessions.write',
  'sessions:setTaskLabel': 'sessions.write',
  'sessions:slashCommands': 'sessions.read',
  'settings:getAutoLabels': 'settings.read',
  'settings:setAutoLabels': 'settings.write',
  'settings:getAutoTrust': 'settings.read',
  'settings:setAutoTrust': 'settings.write',
  'transcripts:binding': 'transcripts.read',
  'update:cancelInstall': 'update.install',
  'update:check': 'update.check',
  'update:getPrefs': 'settings.read',
  // The one-shot "you're now on vX" the previous run left behind. A READ of a
  // preference, not an install — it can no more start one than `getPrefs` can.
  'update:handshake': 'settings.read',
  'update:install': 'update.install',
  'update:openExternal': 'shell.openExternal',
  // "Skip this version" and the auto-check toggle are ordinary preferences —
  // they persist in the workspace store next to the notification prefs, and
  // deserve no capability of their own.
  'update:setPrefs': 'settings.write',
  'transcripts:blocks': 'transcripts.read',
  // Session find (P2-E17-01, §5.31). Deliberately NOT a capability of its own,
  // unlike E16's `fs.read`, and the reason is the FILE rather than the payload:
  // this scans the transcript the watcher already picked for that session, so it
  // reads nothing a holder of `transcripts.read` was not already being streamed
  // block by block from — same file, same watcher, same trust boundary. (It does
  // return MORE of that file than `transcripts:blocks` does: past `DETAIL_CAP`,
  // and from blocks the view buffer dropped. That is a different depth of the
  // same conversation, not a different power.)
  'transcripts:search': 'transcripts.read',
  'workspace:getLayout': 'workspace.read',
  'workspace:getUi': 'workspace.read',
  'workspace:isReadOnly': 'workspace.read',
  // whether the workspace file can still be written (#207). A READ of the
  // store's own health — it starts nothing and changes nothing.
  'workspace:saveState': 'workspace.read',
  'workspace:setLayout': 'workspace.write',
  'workspace:setUi': 'workspace.write',

  // --- outbound: main pushes to a window --------------------------------
  // Tagged and routed through the broker too. A no-op today, but without it a
  // Phase-4 plugin would receive every session event regardless of what it
  // declared — and that is not a thing to discover once there is a plugin to
  // break.
  // an allowlisted chord was claimed above the renderer (#90) — the browser
  // process took the key and names the command it stands for
  'app:accelerator': 'app.window',
  'app:displaysChanged': 'app.window',
  'app:popoutGeometryChanged': 'app.window',
  // "make this noise" / "say this" (P2-E14-05a). Main has no audio device; the
  // renderer is where Chromium's is. `settings.read` because the payload is a
  // cue NAME and a sentence the user has already been shown on every other
  // channel — it grants no reach the notification prefs did not.
  'audio:play': 'settings.read',
  'audio:speak': 'settings.read',
  'events:changed': 'events.read',
  // a watched file moved, or went away (P2-E16-04). Same capability as asking
  // for the watch, and as the read the viewer answers it with.
  'fs:changed': 'fs.read',
  // a poll the renderer did not ask for finished, or the local corroboration
  // rule raised/cleared (P2-E14-07). Same capability as reading it.
  'health:status': 'provider.status',
  // a card gained or lost its live session — re-read `sessions:cards` (#170)
  'sessions:cardsChanged': 'sessions.read',
  'sessions:exited': 'sessions.read',
  // the same fact as `sessions:historyRepairs`, for the ones that happen after a
  // window has already asked
  'sessions:historyRepair': 'sessions.read',
  'sessions:feedBlock': 'transcripts.read',
  'sessions:feedReset': 'transcripts.read',
  'sessions:permissionRequest': 'sessions.read',
  'sessions:permissionResolved': 'sessions.read',
  // "bring this card to the front" — pushed when the user clicked an OS toast
  // for a held permission (P2-E14-04). `sessions.read` and not `.write`: it
  // moves the SCREEN, not a session. The verdict, if there is one, still goes
  // through `sessions:decidePermission` and its `sessions.write`.
  'sessions:revealCard': 'sessions.read',
  'sessions:status': 'sessions.read',
  // a card's task label moved, and the renderer did not do it (P2-E7-06) —
  // carries the new value, because its two readers have nothing to re-read
  'sessions:taskLabel': 'sessions.read',
  'sessions:usage': 'sessions.read',
  // how far the download/verify/install has got (E19-04). Same capability as
  // starting one: a window that may not install may not watch one either.
  'update:installStatus': 'update.install',
  // a check the renderer did not ask for (the daily timer, or the menu item)
  // finished — the renderer decides whether that becomes a dialog
  'update:status': 'update.check',
  // saving started failing, or started working again (#207). Same capability
  // as reading the state: a window that may ask may be told.
  'workspace:saveStateChanged': 'workspace.read',
} as const satisfies Record<string, Capability>;

/**
 * DYNAMIC channel families — one channel per session, so they cannot be listed.
 *
 * `pty:data:<sessionId>` is the terminal's output stream: main opens one per
 * attached pane. A map of fixed names would have missed it entirely, which is
 * the kind of gap that makes a security check worth less than it looks.
 */
export const CHANNEL_PREFIX_CAPABILITIES = {
  'pty:data:': 'pty.read',
} as const satisfies Record<string, Capability>;

export type StaticChannel = keyof typeof CHANNEL_CAPABILITIES;
export type DynamicChannel = `pty:data:${string}`;
export type Channel = StaticChannel | DynamicChannel;

// Maps, not object lookups. `CHANNEL_CAPABILITIES['constructor']` returns the
// Object constructor — truthy, not a Capability, and it would sail straight
// past the "untagged channel" branch in the broker. Reachable only through an
// untyped caller today, but a security primitive should not depend on every
// future caller being well-typed.
const EXACT = new Map<string, Capability>(Object.entries(CHANNEL_CAPABILITIES));
const PREFIXES: ReadonlyArray<[string, Capability]> = Object.entries(CHANNEL_PREFIX_CAPABILITIES);

// Resolved dynamic channels, memoised. `pty:data:<id>` misses the exact map by
// construction and is the highest-volume channel in the app — one terminal
// chunk is one lookup, so the prefix scan would run per chunk forever. The key
// space is bounded by live sessions.
const RESOLVED = new Map<string, Capability | undefined>();

/** The capability a channel requires, or undefined if it is not a known channel. */
export function capabilityFor(channel: string): Capability | undefined {
  const exact = EXACT.get(channel);
  if (exact) return exact;
  if (RESOLVED.has(channel)) return RESOLVED.get(channel);
  let found: Capability | undefined;
  for (const [prefix, cap] of PREFIXES) {
    if (channel.startsWith(prefix)) {
      found = cap;
      break;
    }
  }
  RESOLVED.set(channel, found);
  return found;
}

/** Everything — what first-party is granted, and nothing less. */
export function allCapabilities(): Set<Capability> {
  return new Set(CAPABILITIES);
}
