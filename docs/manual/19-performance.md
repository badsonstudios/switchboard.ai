# When it feels slow

> Status: current

Sometimes the app stops feeling instant — typing arrives in little bursts,
switching between sessions takes a beat. This page is about finding out *why*,
on your own computer, instead of guessing.

There are two parts: a summary you can read at any time, and a recorder you
switch on when you want the detail.

## The quick answer: the performance summary

Press **`Ctrl+Shift+P`** and pick **Show performance summary**.

It lists the things you do — typing a character, switching session, opening
Settings — and how long each one took **in this window, since you opened it**.
Close and reopen the app and it starts again from nothing.

The numbers are **percentiles**, not averages, and that is deliberate:

| Column | Means |
|---|---|
| **Times** | how many of these were measured |
| **p50** | half of them were faster than this |
| **p95** | 19 out of 20 were faster than this |
| **Worst** | the single slowest one |

An average would be actively misleading here. If forty keystrokes are instant
and two take a third of a second, the average says "fine" — and the two you
noticed are the entire complaint. **p95 and Worst are where a stutter shows
up.** On a short session, watch Worst: p95 needs a couple of dozen samples
before one bad moment moves it at all.

Underneath the table are three more sentences:

- **How often the app was too busy to redraw**, and for how long. This is the
  direct cause of typing that arrives in clumps.
- **Background delay.** The app has a part that manages your sessions behind the
  scenes, separate from what you see. If *that* gets blocked, every window feels
  sluggish at once rather than just the one you are in — so it is worth telling
  the two apart. It is checked once a minute, so it says nothing for the first
  minute after launch.
- **Whether detailed recording is on**, and what it found.

Everything above is measured all the time and costs nothing worth mentioning.
You never have to switch it on.

## The detailed answer: turning on capture

**Settings** (`Ctrl+,`) **▸ Diagnostics ▸ Detailed performance capture.**

This is off until you turn it on, and it stays off between restarts until you
do. Switching it on starts recording, straight away — you do not need to
restart the app.

While it is on, the app also records, for every character you type:

- how long the character took to appear;
- how much of the app was busy while you waited;
- how big the conversation was at that moment, and how much of it was on screen;
- whether anything measured the page layout while you were typing. **This one
  should always be zero.** Measuring the layout mid-keystroke was the original
  cause of typing lag, it was fixed, and a number other than zero here means it
  has come back.

### What it costs

A little speed — which is why it is off by default. On the machine it was
measured on, the difference was too small to see: under a twentieth of a
millisecond per keystroke, which is smaller than the normal variation between
two runs. If it ever *is* the reason things feel slow, switch it off and the
recording stops completely — the extra measuring is removed rather than merely
skipped.

### One thing it does not see yet

**A session in its own pop-out window is not measured.** A pop-out is a separate
window as far as the recording is concerned, and the recorder only watches the
main one. If you type in a popped-out session, nothing is recorded for it — and
because "nothing recorded" looks the same as "you did not type", it will not
warn you. Do your measuring in the main window until this is fixed.

### What it records, and what it never touches

This is the important part, so it is stated plainly:

**It records durations and the names of actions. That is all.**

It never records what you typed, what your files are called, what any session
said, or anything from a conversation. There is nowhere in the file for those
things to go — the recording is a list of numbers and a short list of action
names chosen in advance.

**Nothing leaves your computer.** There is no account, no server and no
reporting. The file sits on your own disk until you choose to do something with
it.

The file *does* record what computer it is — app version, operating system,
processor and memory. That is on purpose: the usual question is "why is my
laptop slower than my desktop?", and that question cannot be answered without
knowing which is which.

## Sending the file to someone

**Settings ▸ Diagnostics ▸ The capture file ▸ Show the file** opens the folder
it is in, with the file selected, ready to attach to a bug report. The button
is greyed out until there is something to show.

It is **one file**, kept across restarts, so "send me the file" stays one
instruction even if you restarted the app three times during the day.

It holds roughly a working day. When it gets full it is set aside under the same
name with `.1` on the end and a fresh one starts, so it cannot quietly fill your
disk — and the day you were about to report on is not thrown away. If you are
sending it by hand and a `.1` file is sitting beside it, send both.

### The easier route: Report a problem

**Help ▸ Report a problem** is the one gesture that packages all of this up, and
it works whether or not detailed capture has ever been on:

- **The report itself carries the numbers.** Whichever way you send it, the
  performance summary — the same table you see on screen, plus the long-task and
  background-delay figures — is written into the report in plain text. So
  someone reading it can tell what happened without opening anything.
- **The zip carries them too**, as a readable text file of its own, plus the
  detailed capture file and its `.1` sibling if they exist. That matters if the
  zip is what you are moving: drop it on the other computer and it explains
  itself, with no app needed to read it.
- **Sending it to GitHub** files an issue with the numbers already in it. The
  zip cannot be attached automatically — GitHub only accepts attachments through
  its web form — so the issue tells you where the file is and you drag it on.
- **Sending it to yourself** (choose the email or zip option) leaves the zip on
  your disk and opens the folder with it selected, ready to copy to the other
  machine.

If detailed capture has never been on, the report says exactly that rather than
leaving a gap — so a reader can tell "it was off" from "we could not collect
it".

## A reasonable routine

1. Work normally until the app annoys you.
2. Open the performance summary and look at the **Worst** column.
3. If you want detail, turn on capture and carry on working for a while — the
   longer the better, because the interesting moments are rare.
4. Send the file, or read it yourself: it is one JSON object per line, and the
   last line is the most recent.
