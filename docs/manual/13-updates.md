# Updates

> Status: draft

switchboard.ai can tell you when a newer version has been released, show you
what changed, and let you decide what to do about it. It never installs
anything without asking.

<!-- screenshot: the "There's a new release" dialog with notes and three buttons -->

## When it checks

- **Once when you start the app**, a moment after the window appears.
- **Once a day** while you leave it running.
- **Whenever you ask** — see below.

That's the whole schedule. There's no background service, nothing runs when the
app is closed, and a check takes a fraction of a second.

## Asking for a check yourself

Three ways, all doing the same thing:

- **Help ▸ Check for Updates…** in the menu bar.
- **The command list** — press `Ctrl+Shift+P` (`Cmd+Shift+P` on a Mac), type
  "updates", and pick **Check for updates…**.
- **The About panel** — click the version chip at the top of the window and use
  the **Check for updates…** button.

A check you asked for always tells you the answer, even when the answer is
"you're already on the newest one".

## The "there's a new release" box

When there's something newer, you get a small box naming the version and
showing that release's notes — the actual "what changed" text, read here in the
app rather than on a web page. Long notes scroll inside the box.

Three buttons:

| Button | What it does |
|---|---|
| **Update** | Opens that release's page so you can download it. (A one-click download-and-install is coming; until then this is the honest version.) |
| **Ignore** | Closes the box. You'll be offered this release again next time you start the app. |
| **Skip this version** | Closes the box and stops offering **this particular version**. A *newer* release than the one you skipped will still be offered. |

Escape, clicking outside the box, or **Ignore** all do the same thing: nothing
is remembered, and you'll be asked again next time.

**Skip is per version, not "stop telling me about updates".** If you skip
`0.3.0` and `0.4.0` comes out, you'll hear about `0.4.0`. And a check you asked
for yourself always shows the release, even one you skipped — otherwise the
button would look broken. So there's no "un-skip" button and you don't need
one: **Check for updates…** brings a skipped release straight back.

Links inside the release notes open in your web browser, not inside
switchboard.ai.

## Turning automatic checks off

Click the version chip to open **About this build** and untick **Check for
updates automatically**. That switches off the startup check and the daily one.
The **Check for updates…** button next to it keeps working — turning off the
automatic check doesn't take the manual one away.

## If it can't check

Sometimes it can't: you're offline, or the machine has no credentials for the
release list. In that case:

- **A background check says nothing at all.** No banner, no error, no badge.
  It costs you nothing and doesn't interrupt anything you're doing.
- **A check you asked for** says, plainly, what happened — and it tells the
  three cases apart, because the fix is different for each: this machine has no
  credentials for the release list, the credentials it has can't see it, or it
  simply couldn't be reached right now. None of them are dressed up as an
  error, because none of them are one.

This is deliberate. Update checking is a convenience; it is never allowed to
get in the way of a session that's running.

## What it talks to

The release list, and nothing else. There's no usage reporting, no "phone
home", and no account. If you turn automatic checks off, switchboard.ai makes
no network connections of its own at all.

Right now the releases live in a private place, so the check needs credentials
that are already on your machine. If it can't find any, checking is simply
switched off — quietly, with no setup to do and no error to dismiss.
