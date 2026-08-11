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
  'shell.openExternal', // hands a URL to the user's BROWSER. Its own capability
  // for the `dialog.open` reason — putting something in
  // front of the user, outside the app, is a power in its
  // own right and is not implied by anything else.
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
  'app:movePopout': 'app.window',
  'app:workAreas': 'app.window',
  'events:ack': 'events.write',
  'events:dismiss': 'events.write',
  'events:list': 'events.read',
  'git:fileVersions': 'git.read',
  'git:status': 'git.read',
  'groups:create': 'groups.write',
  'groups:delete': 'groups.write',
  'groups:list': 'groups.read',
  'groups:palette': 'groups.read',
  'groups:setSessionGroup': 'groups.write',
  'groups:update': 'groups.write',
  'notifications:getPrefs': 'settings.read',
  'notifications:setPrefs': 'settings.write',
  'preflight:check': 'environment.probe',
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
  'events:changed': 'events.read',
  // a card gained or lost its live session — re-read `sessions:cards` (#170)
  'sessions:cardsChanged': 'sessions.read',
  'sessions:exited': 'sessions.read',
  'sessions:feedBlock': 'transcripts.read',
  'sessions:feedReset': 'transcripts.read',
  'sessions:permissionRequest': 'sessions.read',
  'sessions:permissionResolved': 'sessions.read',
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
