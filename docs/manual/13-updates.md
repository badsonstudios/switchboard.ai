# Updates

> Status: draft

switchboard.ai can tell you when a newer version has been released, show you
what changed, and — with one click — download, check and install it. It never
installs anything without asking.

<!-- screenshot: the "There's a new release" dialog with notes and three buttons -->
<!-- screenshot: the same dialog mid-download, showing the progress bar and Cancel -->

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
| **Update** | Downloads the new version, checks it, and installs it. See below. |
| **Ignore** | Closes the box. You'll be offered this release again next time you start the app. |
| **Skip this version** | Closes the box and stops offering **this particular version**. A *newer* release than the one you skipped will still be offered. |

Escape, clicking outside the box, or **Ignore** all do the same thing: nothing
is remembered, and you'll be asked again next time. The difference is that
Escape and clicking away leave a small **"v0.3.0 is ready to install"** note in
the Events drawer, so you can come back to it without hunting for the menu. The
drawer is closed by default, so what you'll actually see is a **dot on the tab
at the right edge** — open it with that tab or `Ctrl+E` and the note is inside. **Ignore** and **Skip** don't — those are answers, and re-asking in
the corner would be nagging.

If you use a screen reader, you don't have to keep checking Events for that
note: it arrives long after the window opened, so it reads itself out as soon
as it appears. It waits for a pause rather than interrupting — an update is
news, not an alarm. The **"You're now on v0.3.0"** note after an install
announces itself the same way.

## What happens when you press Update

Four steps, all in the app, all of them visible:

1. **Downloading.** A progress bar, with a **Cancel** button next to it. This is
   the new installer coming down — around 120 MB, so on a slow line it takes a
   minute. Nothing else stops while it happens: your sessions keep running.
2. **Checking the download.** Every release publishes a checksum — a
   fingerprint of the installer file. switchboard.ai works out the fingerprint
   of what it just downloaded and compares the two.
3. **Installing.** The installer runs silently — no wizard, no clicking Next,
   and no Windows "do you want to allow this app to make changes" prompt
   (switchboard.ai installs into your own user folder, so it doesn't need one).
   switchboard.ai closes.
4. **Back on the new version.** The installer reopens the app when it's done,
   and the tab at the right edge picks up a dot. Open the Events drawer (click
   the tab, or `Ctrl+E`) and you'll see **"You're now on v0.3.0"**. That's the
   app confirming the update actually landed, not just that it tried.

If you have sessions mid-task when you press Update, you'll get the same "are
you sure?" question you'd get from closing the window. Say no and nothing is
installed — the release stays on offer.

**Cancel stops it properly.** The download stops, the partly-downloaded file is
deleted, and the box goes back to Update / Ignore / Skip. You've lost nothing
but the bandwidth.

## If the download doesn't match its checksum

The downloaded file is **deleted, and never run.** You'll get a plain
explanation and an **Open the release page** button, so you can get the
installer from the browser instead.

This is the important one, so it's worth being blunt about why it's there:
switchboard.ai isn't code-signed yet, so the checksum is the only thing
standing between a download that went wrong and an installer being executed on
your machine. Almost every time it fires it'll be a download that got truncated
or corrupted in transit — and the right response to that is still "throw it
away and start again", not "run it and hope".

Every other thing that can go wrong — no network, no credentials, a release
without an installer, Windows refusing to start it — ends the same way: a plain
sentence saying what happened, and the release page one click away. Nothing is
half-installed, and nothing is left behind.

## If the release goes away while the box is open

The box can outlive the release it's describing. If you leave switchboard.ai
running for a day with a release on offer and that release is withdrawn or
replaced in the meantime, the next daily check notices — but the box already on
your screen is a picture of the *old* answer.

Press **Update** on one of those and nothing is downloaded. You get a plain
sentence saying **that release is no longer on offer** — and one
**Check for updates…** shows you what's actually available now.

The same sentence covers the quieter version of this: if the last check
couldn't reach the release list at all — you went offline, the laptop slept —
switchboard.ai stops standing behind the release it found yesterday rather than
downloading it on the strength of a stale answer. That's why the message says
"withdrawn, replaced, or could not be confirmed" instead of picking one.

That's deliberately a different message from *"this release has no installer
this app can verify"*, which means something else entirely: the release is
there, it just doesn't ship a file switchboard.ai can check before running.
One tells you to look again; the other tells you to get the file yourself.

## Housekeeping

- One-click updates are **Windows-only** right now. On anything else, Update
  opens the release page like it always did.
- Downloaded installers live in your temporary folder and are **swept on the
  next start**, so a cancelled or crashed update doesn't leave 120 MB behind.
- If an install is running, the daily check stays quiet — it won't pop a second
  box on top of your progress bar.

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

The release list, the installer file, and nothing else. There's no usage
reporting, no "phone home", and no account. If you turn automatic checks off
and never press Update, switchboard.ai makes no network connections of its own
at all.

Right now the releases live in a private place, so the check needs credentials
that are already on your machine. If it can't find any, checking is simply
switched off — quietly, with no setup to do and no error to dismiss.

Those credentials are used **only** to ask GitHub for the release, and only on
GitHub's own address. The actual file comes from a storage server GitHub
redirects to, and your credentials are deliberately not sent there — they
aren't needed, and handing them to a machine that didn't ask for them isn't
something an app should do quietly.
