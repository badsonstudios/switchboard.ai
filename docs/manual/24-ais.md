<p align="right"><a href="contents.md">☰ Contents</a></p>

# Settings → AIs

> Status: draft

Switchboard can run sessions on more than one AI. The **AIs** tab in Settings
shows which AIs are on this computer and whether each one is signed in. It is
also where you choose the AI that new sessions start on, and where you add an
AI Switchboard does not already know about.

Open Settings (**`Ctrl+,`**) and click **AIs**. It is the third tab.

## New sessions start on

The box at the top says which AI a new session starts on. Pick another one
from the list and it changes straight away. There is nothing to save.

- Only AIs Switchboard can actually start a session on are in that list.
- Sessions that are already open keep the AI they have.
- If the AI you chose is no longer set up (for example, you removed it), a line
  under the box says so, and names the AI new sessions use instead. Choose
  again to get rid of it.

Each row under **Found on this computer** also has a **Make default** button,
which does the same thing. The row that is the default has a **default** tag.

## Found on this computer

Switchboard looks for the AIs it knows about **every time it starts**. It does
this after the window is on screen, so it never slows down starting the app.
Each row shows:

- **the AI's name and its maker**;
- **whether it is signed in**: *Logged in*, *Logged in as* an account and a
  plan when the AI reports them, or *Not logged in*;
- **its version**.

Sometimes a row says **unknown** for the sign-in or the version. That means
the AI did not tell us. Some AIs can only report it by starting up, which for
some of them means downloading something first, so Switchboard does not ask.
If the AI did not answer in time, the row says it could not tell, and why.
**Look again** asks once more.

A row may also say **Switchboard cannot start sessions on this one yet**. That
AI is installed and was found, but this version of the app cannot run it yet.

### Log in

When an AI is installed but not signed in, its row has a **Log in…** button.
It runs **that AI's own sign-in**. Usually that opens your browser on the AI
maker's own page. Switchboard never sees your password and never stores it.
There is no password box anywhere in Switchboard.

Some AIs can only be signed in from a terminal. Claude Code is one: pressing
**Log in…** on its row tells you the command to type (`claude auth login`).
When an AI offers more than one way to sign in, the row asks you to pick one.

## Not found

These are AIs Switchboard knows about that are not on this computer. Each one
shows how to install it:

- **a command** in a box, with a **Copy** button. Paste it into a terminal.
- or **How to install**, which opens the maker's own page in your browser.

Switchboard does not install anything itself. After you install one, press
**Look again** and it moves up to **Found on this computer**.

Just after the app starts, a row may say **checking…**. That means the search
has not finished yet. It is not the same as "not found".

## Look again

**Look again** searches this computer again. Use it after you install an AI or
sign in to one. The button says **Looking…** while it works.

## Add an AI

Press **+ Add an AI…**. The window that opens has two tabs.

### From the list

This is the list of AIs that Switchboard ships with. All of them speak the
same protocol for coding tools (the Agent Client Protocol), which is how
Switchboard can host any of them in the same way.

- Type in the search box to find one by its name or maker.
- Tick **Runs local models** to see only the ones that can use a model running
  on your own computer (for example through Ollama).
- An AI that is already installed is marked **✓ installed**. For the rest, the
  row shows how to install it.

**Adding from this list does not install anything.** It shows you how to
install the AI. Install it, sign in with the AI's own sign-in, then press
**Look again** on the AIs tab.

**Check for new AIs** asks the public list of these AIs (the ACP registry)
whether anything has been added or changed since this version of Switchboard
was made. It tells you how many AIs are new, updated or gone, and names the new
ones. **This is the only thing on these screens that uses the internet, and it
only happens when you press the button.** The date of the last check is shown
under it.

### Something else

Use this for an AI that is not on the list, as long as it speaks the Agent
Client Protocol.

1. **Name**: what you want to call it. This is the name you will see in
   Switchboard.
2. **Command**: the program to run. Use the program's name if it is on your
   PATH, or its full path (for example `C:\Tools\agent\agent.exe`). A relative
   path is not accepted.
3. **Arguments** (optional): separate them with spaces. A single argument
   cannot contain a space.
4. Press **Test**. Switchboard starts the program once, checks that it
   answers, and then stops it. When it works, you see the AI's name, its
   version and the protocol version. When it does not, you see why.
5. **Add** only becomes available after a Test has passed. If you change the
   command or the arguments, test again. Changing the name does not need
   another test.

The AI you added appears under **Found on this computer**, with an **added by
you** tag. You can make it the default and start sessions on it straight away.
Its row has a **Remove** button, which asks you to confirm first.

Some characters are refused in the command and the arguments, because of the
way Windows starts programs: `( ) % ! ^ " < > & |`. Test tells you when one of
them is in the way.

**What Test does not tell you:** Test does not open a conversation with the
AI, so it cannot list the AI's models.

## Good to know

- Switchboard never asks for a password or an API key. Each AI keeps its own
  sign-in, in the AI's own place.
- AIs you added under **Something else** are kept when you restart the app.
- The list of known AIs ships inside Switchboard. Nothing is fetched until you
  press **Check for new AIs**.
- If the tab cannot reach the list just now, it keeps showing what it last
  knew, with a note saying so.

## If something goes wrong

- **An AI I installed still shows under "Not found"**: press **Look again**.
  If it is still not found, check that its program is on your PATH. A new
  PATH entry may only be seen after you restart Switchboard.
- **A row says "unknown"**: that AI did not report it, or did not answer in
  time. Press **Look again**. On a slow computer, a first check can take a few
  seconds.
- **Test says the program was not found**: give its full path in **Command**.
- **Log in does nothing in Switchboard**: the sign-in happens in the AI's own
  window or in your browser. Finish it there, then press **Look again**.

---

[← Back to Contents](contents.md)
