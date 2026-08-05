// Packaging config (P2-E19-01). electron-builder is used for PACKAGING ONLY —
// its auto-update runtime (electron-updater) is deliberately NOT adopted; the
// update checker is hand-rolled in E19-03/04 because this repo is private and
// electron-updater's private-GitHub path needs the same token anyway while
// dragging in latest.yml/blockmap machinery and expecting signed builds.
// See docs/plans/04-phase-2-switchboard.md → E19, decision 2.
//
// A .js config rather than .yml so these decisions can be written next to what
// they configure — the same reason the rest of this repo is commented the way
// it is. The FILENAME is not a style choice: app-builder-lib auto-discovers
// exactly `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}` and nothing
// else, so the popular `electron-builder.config.js` is silently ignored unless
// you pass `--config`. It was, once, during this item — electron-builder
// cheerfully built an installer with every default instead. Renaming it here
// means a bare `npx electron-builder` finds the same config `npm run package`
// does.
//
// Windows-only, unsigned, per-user — E19 decision 3. macOS/Linux targets are
// explicitly out of scope, not forgotten.
'use strict';

module.exports = {
  appId: 'com.badsonstudios.switchboard',
  productName: 'switchboard',
  copyright: 'Copyright © 2026 badsonstudios',

  /**
   * PACKAGING NEVER PUBLISHES. `null` is not "unset" — app-builder-lib's
   * `getPublishConfigs` returns null the moment it sees an explicit null and
   * stops before any provider is resolved, so no publisher is ever constructed,
   * nothing is uploaded, and no `latest.yml`/`app-update.yml` is written.
   * Releases are created by `gh release create` in `.github/workflows/release.yml`
   * — the ONE place allowed to write to this repo (E19 decision 2: electron-
   * builder packages, it does not update and it does not publish).
   *
   * Leaving it unset is not neutral, which is what #273 was: electron-builder 26
   * escalates an unset publish policy to `onTagOrDraft` when it detects CI, then
   * infers a GitHub provider from the origin URL in `.git/config` so it can write
   * `latest.yml` — and schedules THAT for upload, dying with `GitHub Personal
   * Access Token is not set` after a fully successful build, installer already on
   * disk. Reproducing it needs all three (CI + resolvable repo + no token), which
   * is why nobody saw it locally — and why it will not reproduce in a git
   * WORKTREE either, where `.git` is a file and that config read simply fails.
   * (electron-builder 27 drops the implicit behaviour; this line is correct either
   * way, and `scripts/package.js` also passes `--publish never` so the escalation
   * is never even attempted.)
   */
  publish: null,

  // `dist/` is gitignored (and stays that way — src/main/packaging.test.ts
  // asserts it). `out/` is electron-vite's, and the two must not collide.
  directories: {
    output: 'dist',
    buildResources: 'build',
  },

  /**
   * What goes in the app.
   *
   * An ALLOWLIST rather than the default "all production dependencies",
   * because electron-vite bundles the renderer: monaco-editor, react, xterm,
   * marked and the rest are already inside `out/renderer/assets`, and shipping
   * a second uncompiled copy of them adds ~100 MB to an installer the updater
   * (E19-04) will have to download.
   *
   * The evidence for the allowlist: `node-pty` is the only bare specifier the
   * BUILT main/preload bundles still `require()` at runtime — it is native, so
   * `externalizeDepsPlugin` leaves it external on purpose. That is not a fact
   * anyone should have to re-derive by grepping `out/`, so
   * `src/main/packaging.test.ts` re-checks it against the SOURCE imports on
   * every unit run: add a runtime dependency to main, preload or shared
   * without listing it here and the suite goes red rather than the packaged
   * app.
   *
   * node-pty's own tree is trimmed hard: `prebuilds/` (58 MB of binaries for
   * ABIs we do not run — postinstall rebuilds against Electron's) and the
   * compiler leftovers in `build/Release` (~90 MB of .pdb/.iobj/.ipdb/obj) are
   * build output, not runtime. What IS needed:
   *   - lib/**                     the JS, incl. the forked conpty agent
   *   - build/Release/*.node       conpty + pty + conpty_console_list
   *   - build/Release/winpty.dll   loaded by pty.node
   *   - build/Release/*.exe        winpty-agent.exe, spawned by winpty.dll
   *   - package.json               `main` resolution
   */
  files: [
    'out/**',
    'package.json',
    '!node_modules/**',
    'node_modules/node-pty/package.json',
    'node_modules/node-pty/lib/**',
    'node_modules/node-pty/build/Release/*.node',
    'node_modules/node-pty/build/Release/*.dll',
    'node_modules/node-pty/build/Release/*.exe',
  ],

  /**
   * node-pty must live OUTSIDE app.asar.
   *
   * Two independent reasons, either one sufficient: Windows cannot LoadLibrary
   * a .node or a .dll out of a virtual archive, and winpty.dll spawns
   * `winpty-agent.exe` as a real process from a real path. Electron rewrites
   * requires into `app.asar.unpacked/` for us, so nothing in the source has to
   * know. This one line is the difference between a packaged app that opens
   * terminals and one that throws "Failed to load native module" on the first
   * session — which is why "a PTY session starts in the packaged app" is the
   * done-when that matters for this item.
   */
  asarUnpack: ['node_modules/node-pty/**'],

  /**
   * `npm ci`'s postinstall already ran electron-rebuild against Electron's ABI
   * (scripts/rebuild-native.js), including the Windows Spectre-libs fallback
   * that plain electron-builder does not have. Letting electron-builder redo
   * it would at best repeat two minutes of work and at worst fail on a machine
   * that needs that fallback — with the correct binaries already sitting in
   * node_modules.
   */
  npmRebuild: false,

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
    // No signing key here, and that is the decision, not an omission (E19
    // decision 3): a per-user install needs no UAC, and E19-04 downloads over
    // raw HTTPS, which applies no Mark-of-the-Web — so SmartScreen never gets
    // a say either. A sha256 sidecar does the integrity work. electron-builder
    // still logs "signing with signtool.exe" while it stamps the icon and
    // version resources onto the exe; the result is verifiably NotSigned.
  },

  nsis: {
    // The two settings that ARE the "installs without UAC" done-when.
    // perMachine:false puts the app in %LOCALAPPDATA%\Programs\switchboard,
    // which the user can already write, so Windows never shows an elevation
    // prompt. oneClick keeps the install to a single click — and, the part
    // that matters for the upgrade path, makes the installer shut down a
    // running instance itself instead of failing on a locked .exe.
    oneClick: true,
    perMachine: false,
    // The name E19-02's release workflow and E19-04's downloader both expect.
    artifactName: 'switchboard-Setup-${version}.exe',
    shortcutName: 'switchboard',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // A dogfooding tool that deletes its own workspace/session state on
    // uninstall would be a nasty surprise; %APPDATA%\switchboard stays.
    deleteAppDataOnUninstall: false,
  },
};
