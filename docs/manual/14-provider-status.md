# Is it me or is it them?

> Status: draft

Some days the model is slow, or refuses, or a session just stops working. Before
you go hunting through your prompt, the app can tell you whether Anthropic is
having a bad afternoon.

Two things answer that question, and they're independent.

## The dot in the bottom bar

At the right-hand end of the bottom status bar there's a small dot. It reflects
Anthropic's public status page, which switchboard checks every few minutes.

| What you see | What it means |
|---|---|
| **●** green, no words | All systems operational. Nothing to worry about. |
| **●** amber, *"provider degraded"* | The status page reports degraded performance. |
| **●** red, *"provider outage"* | The status page reports an outage. |
| **○** hollow grey | We don't know — see below. |

Hover the dot for the details: the status page's own summary, any open
incidents, and when it was last checked.

**Grey isn't an error.** It just means nothing useful came back. That happens
when you're offline, when the status page can't be reached, or when you've
turned the check off. Nothing in the app behaves differently because of it — no
warning, no dialog, nothing to dismiss.

## Open incidents show up in Events

When the status page is reporting an unresolved incident, a small card appears
at the top of the **Events** panel naming it and what stage it's at —
*investigating*, *identified*, *monitoring*. It has no buttons: there's nothing
for you to decide. It disappears on its own when the incident is resolved.

## "Several sessions just hit errors"

Status pages lag reality. They're written by people, after somebody notices.

So switchboard also watches your own sessions. If **three different sessions hit
errors within about five minutes**, an amber strip appears across the window:

> Several sessions just hit errors — this may be a problem at the provider
> rather than anything you did.

That's a hint, not a verdict. It appears before the status page catches up, and
it goes away by itself the moment one of those sessions completes a turn
normally. There's nothing to click and nothing to dismiss.

One session failing never raises it, and neither do two — one session in trouble
is usually about that session. Three at once is when "the thing they have in
common" becomes the better explanation.

## Turning the check off

Click the version stamp at the top left to open **About this build**. Under the
update controls there's a checkbox:

- **Check provider status** — on by default.

Unticking it stops switchboard from contacting the status page at all. The dot
goes hollow and its tooltip says the check is off.

**The "several sessions" strip keeps working either way** — that one never
talks to the internet. It only looks at what's happening in your own window.

## What gets sent

Nothing. The status check is a plain read of a public page, the same one you'd
open in a browser at *status.anthropic.com*. No account, no identifier, no
information about your sessions, your machine or your work leaves the app.
