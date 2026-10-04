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
   * because electron-vite bundles the renderer: monaco-editor, react, marked
   * and the rest are already inside `out/renderer/assets`, and shipping a
   * second uncompiled copy of them adds ~100 MB to an installer the updater
   * (E19-04) will have to download.
   *
   * ⚠️ THE LIST IS NOW `out/**` AND `package.json`, AND THAT IS THE WHOLE APP
   * (#952). It used to carry five `node_modules/node-pty/**` lines, because
   * node-pty was the only bare specifier the BUILT main/preload bundles still
   * `require()`d at runtime — it is native, so `externalizeDepsPlugin` left it
   * external on purpose. The PTY transport is gone and so is that dependency,
   * which means **this app now ships no native module at all**: no
   * `asarUnpack`, no ABI rebuild, no per-platform binary, and nothing in
   * `node_modules` reaching the installer.
   *
   * The guard that made this safe stays, and it matters more now, not less:
   * `src/main/packaging.test.ts` re-checks this list against the SOURCE imports
   * of main, preload and shared on every unit run. Add a runtime dependency
   * without listing it here and the suite goes red rather than the packaged
   * app. An empty-looking allowlist is a claim — that nothing is external — and
   * that test is what keeps it true.
   */
  files: [
    'out/**',
    'package.json',
    '!node_modules/**',
    // NOTHING here for #815's zip writer, deliberately: `yazl` is inlined into
    // the main bundle instead (`src/build/bundled-deps.ts` carries the why —
    // its `buffer-crc32` dependency is invisible to the runtime-dep guard).
    // A package that is already inside `out/main/index.js` must not also be
    // shipped from node_modules; `packaging.test.ts` asserts both halves.
  ],

  /**
   * The user manual, beside the app (Help ▸ User manual).
   *
   * `extraResources` and not another line in `files`: that would put the pages
   * INSIDE app.asar, and the document viewer reads through a scope check built
   * on `realpath`, follows the open file with a directory watch, and offers
   * Open externally — an archive member is not a path any of those can use.
   * Out here they are ordinary files in `resources/manual`, read-only in the
   * app like every other file.
   *
   * The pages and their pictures (`img/`, #1082), and not the two files that
   * are about WRITING the manual: `_template.md` is a page's skeleton and
   * `README.md` is the contributors' index and house style. No page links to
   * either.
   */
  extraResources: [
    {
      from: 'docs/manual',
      to: 'manual',
      filter: ['*.md', 'img/*.png', '!_template.md', '!README.md'],
    },
  ],

  /**
   * No `asarUnpack` (#952).
   *
   * node-pty needed it — Windows cannot LoadLibrary a .node or a .dll out of a
   * virtual archive, and winpty.dll spawned `winpty-agent.exe` as a real
   * process from a real path. With the PTY transport deleted there is no native
   * code in the package, so everything can live inside app.asar. If a native
   * dependency is ever added back, it needs a line here and a line in `files`,
   * and `packaging.test.ts` is what will tell you.
   */

  /**
   * Nothing to rebuild (#952).
   *
   * This was `false` because `npm ci`'s postinstall had already run
   * electron-rebuild against Electron's ABI, including a Windows Spectre-libs
   * fallback electron-builder does not have. There is no postinstall and no
   * native module now, so the flag only asserts that electron-builder must not
   * go looking — which is cheap insurance and one less thing to rediscover.
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
    // The user-visible brand is "switchboard.ai"; productName stays bare
    // "switchboard" because it names the exe (switchboard.ai.exe would read as
    // a file extension), the %APPDATA%\switchboard state folder existing
    // installs already use, and the artifact above. Shortcut + Add/Remove
    // entry carry the full brand instead.
    shortcutName: 'switchboard.ai',
    uninstallDisplayName: 'switchboard.ai ${version}',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    // A dogfooding tool that deletes its own workspace/session state on
    // uninstall would be a nasty surprise; %APPDATA%\switchboard stays.
    deleteAppDataOnUninstall: false,
  },
};
