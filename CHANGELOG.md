# Changelog

Every released version of switchboard.ai gets a section here. The release
workflow (P2-E19-02) reads this file for its release notes, and the in-app
update dialog (P2-E19-03) shows those notes to the user — so a section written
carelessly is a section a user reads.

## The version, and how it moves

`package.json`'s `version` field is the **single source of the release
number**, and a human moves it — nothing generates it, and no CI job bumps it.
It is not the same thing as the build identity: see
`src/shared/build-identity.ts` for why the two are deliberately separate.

- **semver = the release number.** Human-bumped, on purpose, when someone
  decides a release is happening.
- **git stamp = the build identity.** SHA + branch + dirty + build time,
  stamped in automatically at build time and shown in About. It answers "which
  bytes am I running?", which a semver cannot.

**While work is landing:** add your entry to the section for the version
currently in `package.json`, under `Added` / `Changed` / `Fixed` / `Internal`
(drop the groups you do not need). Write it in the user's words, not the
issue's. Never open a section for a version *beyond* the one in
`package.json` — a speculative section becomes real release notes the moment
someone tags.

**To cut a release:**

1. Bump `version` in `package.json` — patch for fixes, minor for features,
   major for a break. Pre-1.0, a minor is what a "release" normally is.
2. Replace that version's `— unreleased` with the release date, and open a new
   `## <next version> — unreleased` section above it if work continues.
3. Commit both together. The version and its notes arriving in one commit is
   what makes "this tag has no changelog section" a bug worth failing a build
   over — which is exactly what P2-E19-02's workflow does.
4. Tag `v<version>`; the tag must equal `package.json`'s version.

---

## 0.1.0 — unreleased

The first packaged build. This section describes what the app *is*, not what
changed — there is no earlier release to differ from.

### Added

- Run many Claude Code sessions in one window: a sessions rail, and a dockable
  workspace of terminal, changes and event-feed panels that can be popped out
  into their own windows.
- Attention routing — the app tells you which session needs you, and why.
- Approvals and autonomy settings, surfaced in the session's event feed where
  you can act on them.
- Per-session git status and diff viewing.
- Slash commands, a command palette, and full keyboard operation with
  screen-reader support.
- Selectable themes, including a high-contrast one.

### Internal

- Windows installer via electron-builder: per-user, one-click, no UAC
  (P2-E19-01).
