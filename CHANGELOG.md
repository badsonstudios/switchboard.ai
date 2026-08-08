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

## 0.1.2 — 2026-08-08

### Fixed

- Sessions with **Allow all** switched on are now genuinely silent in Direct
  mode. Before, every tool call still rang the bell — a beep, a taskbar flash,
  and a "needs permission" entry in the events panel for a question the app
  had already answered itself. Now those calls are answered inside the app
  without involving the window at all: no banner, no beep, no log spam.
- Closing (or crashing) a window can no longer strand a session that was
  waiting on a permission answer. An unanswerable question now times out to a
  safe "no" — the tool is denied and the session carries on, instead of
  hanging forever on a prompt nobody can see.
- Direct-mode sessions no longer flip to "needs permission" on background
  notification noise when nothing is actually being asked. Real questions
  still come through exactly as before.
- A group can no longer be renamed to an empty name — the edit simply ends and
  the old name stands, matching how session renames already behave. And if a
  hand-edited (or damaged) workspace file contains a blank group name, it now
  loads as "Untitled group" instead of producing an invisible, unclickable
  group.
- Pressing **Update** on a release that was withdrawn while the dialog sat
  open now says the release is no longer available, instead of the misleading
  "no installer this app can verify".
- Each session tab now shows the session's identity color and language badge,
  matching its card header. They previously always painted a grey dot.

### Added

- Screen readers now announce the "reconnect your pop-out window" offer in the
  events panel, the same way they announce update notices.
- The manual's troubleshooting page now explains what the app does with a
  damaged workspace file — both when the whole file is unreadable (it is set
  aside as `workspace.json.corrupt` and the app starts fresh) and when
  individual fields are quietly repaired.
- Every one of those load-time repairs now says so in the log: what was
  repaired or dropped, and — when the whole file was set aside — why it
  couldn't be read and where it went. Nothing about a damaged workspace is
  silent anymore.

### Internal

- The end-to-end test suite now refuses to run against a stale build, failing
  in seconds with a clear message instead of minutes of misleading failures.
- Group operations refuse bad input with a result the interface can react to
  instead of throwing, closing off a class of invisible background errors.
- Two tests that had quietly stopped proving anything were rebuilt so they
  fail when the behavior they name is actually broken.

## 0.1.1 — 2026-08-06

### Added

- One-click updates. The "there's a new release" dialog's **Update** button now
  does the whole job instead of opening a web page: it downloads the installer
  with a real progress bar and a working Cancel, checks the file against the
  checksum the release published — a download that doesn't match is deleted and
  never run — installs silently, and restarts the app. The next run confirms
  the update actually landed with a "You're now on vX" note in the events
  panel. Closing the dialog without answering leaves a small "ready to install"
  reminder there too; choosing Ignore or Skip doesn't. Every failure ends with
  a plain sentence and a link to the release page.

### Fixed

- Direct-mode sessions no longer show the "Claude is asking permission in the
  terminal" bar — there is no terminal in that mode, and the [Open Terminal]
  button it offered went nowhere. This includes the version of the bug where
  a session with "Allow all" switched on flashed that bar for a few seconds on
  every single permission, while nothing was actually waiting on you.
- A session can no longer be renamed to nothing: an empty rename box (or one
  with only spaces) now means "never mind", the same as pressing Escape, and a
  blank name can no longer sneak into the saved workspace.
- A very long session name now shortens with `…` in the card header instead of
  pushing the status pill and window buttons off the edge of the card.

### Internal

- Line endings are pinned repo-wide (`.gitattributes`, `eol=lf`).
- Build stamps on push builds name the real branch instead of "detached".
- The urgency lamp's timing-dependent tests now run on a clock the tests own.
- Every always-visible notice bar carries a height guard pinned by one shared
  regression roster.
- Group edits the app refuses now come back as an answer instead of an error
  nobody was listening for, so a refused edit can never surface as a crash
  report in the background.

---

## 0.1.0 — 2026-08-05

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
- Session pinning (a pinned session sorts first and bulk actions skip it) and
  a focus-stealing policy that decides whether a session that needs you may
  jump to the front.
- The app checks for new releases once a day and offers the update in a small
  dialog with the release notes; checking is fail-open — no credentials or no
  network simply means no check, never an error.

### Internal

- Windows installer via electron-builder: per-user, one-click, no UAC
  (P2-E19-01).
