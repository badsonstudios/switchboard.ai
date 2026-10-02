# Changes & git

> Status: draft

## The branch line

Each card header shows where the session's folder stands in git: the branch
name (**⎇ main**), how many files have changed (**·3 changed**), and how many
commits you're ahead of the remote (**↑2**). It updates as Claude works.

If the folder isn't a git repository, the line simply doesn't appear.

## The Changes tab

Open the **Changes** tab on a card to see what this session has actually done to
your files. It used to be one flat list of full file paths; it is now grouped the
way every git tool groups things.

### The groups

| Group | What is in it |
|---|---|
| **Merge conflicts** | files git could not merge on its own — **always listed first**, because nothing else can be committed until these are sorted out |
| **Staged changes** | what a commit would capture right now |
| **Changes** | what has changed since you staged, or everything if you have staged nothing |
| **Untracked** | files git has never seen before |

A group only appears if it has something in it, each shows its own count, and you
can fold any of them shut by clicking the heading.

**A file can be in two groups at once.** If you staged a change and then edited
the file again, it appears under both **Staged changes** and **Changes** — with
*different* numbers in each, because those are two different sets of changes. That
is not a duplicate; it is the difference between what committing would capture and
what it would leave behind.

### The rows

Each row is: a coloured letter, the file's **name**, then its folder in grey.

| Letter | Meaning |
|---|---|
| **M** | modified |
| **A** | added |
| **D** | deleted |
| **R** | renamed |
| **C** | copied |
| **T** | type changed — a file replaced by a symlink or a folder |
| **U** | untracked |
| **!** | in conflict |

**The name comes first on purpose.** Before this, rows showed the whole path and
cut off the end when it didn't fit — which meant `…/components/FeedView.tsx` and
`…/FeedView.test.tsx` looked identical, and the only part that told them apart was
the part that got cut. Now the folder is what shortens, from the *front*, so what
you can always read is the filename.

Click a row to see that file before and after. Hover it — or Tab to it — and the
line counts swap for buttons: **⧉** to open the diff in its own panel, **↗** to
open the file itself in the reader, and **⏱** to see that one file's history.

**⏱** switches the card to the **History** tab and filters it to the commits
that touched that file, with a chip at the top naming it. That is its own
section of the [History](22-history.md) page, including how to get back.

### The numbers

Each row shows how many lines were added and removed, and the bar at the top adds
them up along with a file count.

Some things genuinely have no line count, and switchboard shows nothing rather
than a zero:

- **An untracked file.** Git doesn't compare a file it has never seen, so there is
  nothing to count. `+0 −0` would read as "this new file is empty".
- **A binary file** — an image, a PDF. The row says **binary** instead.

When anything is uncounted, the top bar says **(some uncounted)** rather than
implying a total it can't know.

### The top line

The header shows the branch (**⑂ main**), and arrows if your branch tracks one on
a remote: **↑3** for commits you haven't pushed, **↓1** for commits you haven't
pulled. Neither appears if you're level with the remote — or if your branch doesn't
track one at all.

**⟲** re-reads the project. Nothing watches your folder in the background, so if
you've changed files outside the app, that's the button.

### Filtering

Type in the box to narrow the list. It matches the whole path, so `lib/` finds
everything in a `lib` folder, not just a file called `lib`.

**It remembers where you were.** Leave the Changes tab for the conversation and
come back, and it reopens on the same file, at the same line —
you do not have to find your place again. If that file has stopped being a
change while you were away, because you committed or discarded it, the tab
opens clean instead of showing you a blank comparison. This lasts for as long
as the app is running; a restart starts fresh.

When there's nothing to show you'll see **Working tree clean**, or **Not a git
repository** if that's the situation.

### A flat list, or a folder tree

Beside the filter box are two small buttons: **☰** for a flat list and **⊟** for a
folder tree. The flat list is the default, and the choice is remembered for the
whole app, not just the one session.

The tree groups the changed files by folder, and it **collapses folders that have
only one thing in them** — so you get one row reading
`src/renderer/src/components` rather than four nested rows that each contain
nothing but the next. Click a folder to fold it; the number on the right tells you
how many changed files are inside, so a folded folder never hides how much
changed.

A few things worth knowing:

- **In tree mode the rows stop repeating the folder**, because the folder is the
  row above them. In the flat list the folder is shown after each name, which is
  the point of that mode.
- **The rows are otherwise identical** — same letter, same numbers, same buttons
  when you hover.
- **The filter still works**, and the tree is built from what survives it: you
  will not see a folder whose only changed file the filter has hidden.
- **Which folders you have folded is forgotten when you leave the tab.** The
  flat-or-tree choice is remembered; the folding is not.

**Why flat is the default**, when a tree might look tidier: this tab is mostly
answering "what did the agent just change?", and a flat list answers that at a
glance where a tree asks you to expand things first. The tree earns its keep on a
big change set, which is exactly when you'll want to reach for it.

## Staging, unstaging and discarding

Hover a row and you get up to five buttons. Three of them just show you things
(⧉, ↗, ⏱); the other two **change your repository**:

| Button | What it does |
|---|---|
| **＋** | **Stage** this file — tell git you want this change in the next commit |
| **−** | **Unstage** it — take it back out |
| **↶** | **Discard** the change — throw it away |

**Which buttons a row gets depends on which group it's in**, and that's
deliberate:

- A row under **Staged changes** only gets **−**. A ＋ would be a button for
  something already done, and a ↶ there would throw away a change you'd
  deliberately kept.
- A row under **Changes** or **Untracked** gets **↶** and **＋**.
- A row under **Merge conflicts** gets **neither**. "Discard this conflict" could
  mean three different things (keep yours, keep theirs, abandon the merge) and git
  has a separate command for each — so switchboard doesn't guess. Resolve it, or
  use git directly.

The same buttons appear on each **group heading**, and there they act on
everything in that group.

### Discard asks first, and it means it

**Discarding is the only thing switchboard does that can destroy work nothing else
has a copy of.** A modified file that's already been committed can always be
brought back; a brand-new file you discard is simply gone — not in git's history,
not in its index, not recoverable with a git command.

So discard always asks, and **the question names what's at stake**: one file by
name, or a count for a group. If you say no, nothing happens at all.

### If it doesn't work, it says so

Git can refuse for all sorts of reasons — another program holding the repository's
index, a file permission, a hook. When that happens you get a line at the top of
the list **in git's own words**, because that's the message that tells you what to
do about it. The list refreshes either way, so what you see is always what's
really there.

### Staging part of a file

Sometimes one file holds two unrelated changes and you only want to commit one.
Hover a row under **Changes** and press **⊞**.

A list appears at the bottom of the pane, one line per *part* of the file — each
saying where it starts and how much it changes (*"From line 42 — +6 −2"*). Press
**＋** beside a part to stage just that part.

Afterwards the file appears under **both** *Staged changes* and *Changes*: the
part you picked is ready to commit, and the rest isn't.

A few things worth knowing:

- **Nothing on disk is touched.** Staging a part only changes what git has
  recorded as ready — your file is exactly as you left it. That's why this has no
  confirmation step, unlike discarding.
- **The list refreshes after every ＋**, because staging one part moves the
  others.
- **⊞ only appears on unstaged, already-tracked files.** A brand-new file has no
  "parts" — git has never seen it — and a staged row's remaining change is on the
  other side of the list.
- **If git won't apply something, you'll see git's own words.** It also leaves
  everything exactly as it was — a refused patch changes nothing.

**What isn't here yet: picking individual LINES.** The parts are whole blocks of
change. Line-by-line picking needs a different mechanism, and the first attempt at
it was found to stage *the wrong lines* while looking like it worked — so it's
been left out rather than shipped. That's tracked separately.

## Committing

Above the filter box there's a message box and a **Commit** button.

Type a message and press **Commit** — or **Ctrl+Enter** (**Cmd+Enter** on a Mac)
without leaving the box. Plain **Enter** makes a new line, because commit messages
often have more than one.

**The button tells you what it will capture** — *"Commit 3 staged files"* — and
that count is of everything you've staged, **not** of what the filter is showing.
`git commit` takes the whole staged set, so a count that followed the filter would
promise three files and commit thirty.

**The button is off until it can work, and it says why**: either you haven't
written a message, or you haven't staged anything. Those are two different
problems with two different fixes, so they get two different explanations.

**If the commit doesn't happen, you keep your message.** A rejected commit — a
hook said no, nothing was staged — never costs you the words you wrote.

### Your project's hooks run

If your project has a `pre-commit` hook — a formatter, a linter, a test run —
**it runs**, exactly as it would if you'd typed `git commit` yourself. If it
fails, the commit doesn't happen and **you see the hook's own output**, because
that's the message that tells you what to fix.

This is deliberate, and it's different from everything else switchboard does with
git. When switchboard *reads* your project — which it does constantly, without
being asked — it refuses to let the project run any program at all. A commit is
different: you pressed a button, and a commit that silently skipped your own
checks wouldn't really be a commit.

### The ⋯ options

Three things sit behind the **⋯** beside the Commit button. They're options on the
one commit, never a second button that also commits:

- **Amend the last commit** — replaces it instead of adding a new one. ⚠️ **This
  rewrites history**: if you've already pushed that commit, your next push will
  need to be forced. Because of that, when amend is on the button *changes its
  words* and a note appears under it, so you can't forget. Amend also works with
  nothing staged — fixing a message you just wrote is the main reason to use it.
- **Add a Signed-off-by line** — appends the trailer some projects require.
- **Skip this project's commit hooks** — the escape hatch for when a hook is
  wrong and you know it.

## Fetching, pulling, pushing

The branch line at the top has had **↑ 3 ↓ 1** style counts for a while with
nothing to do about them. Now it has buttons:

| Button | What it does |
|---|---|
| **⟳** | **Fetch** — ask the remote what's new. Changes nothing of yours. |
| **↓** | **Pull** — bring those commits down. Only appears when there are some. |
| **↑** | **Push** — send your commits up. Only appears when you have some. |

**↓ and ↑ are absent, not greyed, when there's nothing to do.** The counts beside
them tell you whether there is.

**They disable themselves while they're working.** These are the only things
switchboard does that talk to another machine, so they can take a few seconds — and
a button that didn't show it was busy would get pressed twice, which for a push
means pushing twice.

### Pull either works completely or does nothing

**Pull only fast-forwards.** If your branch and the remote have both moved,
switchboard won't try to merge them — it says so and changes nothing.

That's deliberate. A normal `git pull` either merges or rebases, and both can stop
half-way with a conflict. A one-click button that left you in the middle of a merge,
with no screen in switchboard for finishing it, would be worse than a button that
declines. So: it tells you, and you deal with it where you normally would.

### Publishing a new branch

A branch you've never pushed has no "upstream", and git refuses to guess which
remote you meant. When that happens you'll see the message and an extra **↑**
appears — *"Publish this branch to the remote"*. That's a **second, deliberate
press**: switchboard won't publish a branch because you pressed Push once.

### Making a branch

On the **History** tab, every commit row has a **⑂** — *"New branch from here"*.
It asks for a name and starts the branch at that commit, which is what the commit
graph is for.

Names are checked before git sees them: letters, digits, `.` `_` `/` `-`, and not
starting with a dash.

### Your credentials work as they always do

switchboard stops git from asking for a password **on a terminal** — there isn't
one, so it would just hang for ever. It doesn't touch how you're actually
authenticated: Windows Credential Manager, the macOS keychain, a `gh` helper, an
SSH key — all exactly as they are outside switchboard.

**What switchboard deliberately won't do:** **force-push**. A force-push can
destroy commits on the remote that exist nowhere else — possibly somebody else's —
and there's no confirmation box that makes that safe. That one stays in your
terminal.

## Side by side, or inline

Above the diff there's a pair of buttons: **Side by side** shows the old file
and the new one in two columns; **Inline** stacks the changes in a single
column, with removed lines above the ones that replaced them.

Side by side is the default. Your choice applies to every Changes tab — this
session's and every other one's, including any in a popped-out window — and
it's remembered, so the app comes back the way you left it. You can also
change it from the command palette (**Ctrl+K** / **⌘K**) with *Toggle
side-by-side / inline diff*.

One exception, and only for genuinely tiny panes: squeeze the Changes tab below
about 400 pixels and two columns would hold roughly 18 characters each, which
isn't a diff. Below that width it's drawn inline whatever you chose, and the
tab tells you so — *Too narrow for two columns*. The button stays selected;
**the quickest fix is the ⧉ button described below** — or widen the card, hide
the sessions rail with **Ctrl+B**, or pop the session out into its own window,
and the second column comes back on its own.

## Giving a diff its own space — ⧉

A card's tabs are one-at-a-time: while you're reading a diff in the Changes tab
you can't see the conversation that produced it. The **⧉** button, beside the
side-by-side / inline pair, fixes that. Click it with a file selected and that
file's diff opens as **its own panel** next to your sessions — so the diff and
the conversation are on screen together, and the diff gets the width it wants.

Inside that panel there's a **⧉** of its own, which moves it to **a separate
window** — another monitor, if you have one. The same button then reads **⇤** to
put it back.

Things worth knowing:

- **The Changes tab still works exactly as it did.** ⧉ is an extra route, not a
  replacement: clicking a file still shows its diff in place. If you never press
  ⧉, nothing about the tab has changed.
- **Asking twice doesn't open twice.** Press ⧉ again for the same file and
  switchboard brings the panel you already have to the front — and raises its
  window if it's in one.
- **The panel shows the file's full path** along the top, because a tab is only
  wide enough for the name and `index.ts` is the commonest name there is.
- **It's one file, fixed.** A panel shows the comparison it was opened on for as
  long as it's open; clicking a different file in the Changes tab opens a new
  panel rather than re-pointing the one you were reading.
- **A diff panel never opens as a tab inside a session**, and a new session never
  opens on top of one.
- **Closing the app closes them.** Diff panels aren't restored on the next launch
  — the same as the file reader. Your sessions and layout come back; the diffs
  you were reading don't.
- **One gap, so you aren't surprised by it:** `Ctrl+F` doesn't work inside a diff
  panel yet. In the Changes tab it does. That's being fixed separately.

## Everything in one scroll — ⧉

Beside the flat-or-tree buttons there's a **⧉**. It opens a panel containing
**every changed file, stacked in one scroll** — each with its own heading that
sticks to the top as you pass it, so you always know which file you're in.

This is the surface for reading what an agent just did. Instead of clicking
seventeen files one at a time, you scroll from top to bottom.

Like a single diff, it's a panel rather than a tab, so you can read it **beside
the conversation** rather than instead of it.

### Large files start folded, and say why

Opening a comparison is real work for the app — about as much per file as the
Changes tab does for the one file you clicked. So the panel decides, before it
opens, how much to show immediately:

- It opens files until it has shown **about 400 changed lines**, or **ten
  files**, whichever comes first.
- Everything else starts **folded**, with one line saying why — *"folded to keep
  this panel quick to open"*.
- A single file bigger than that whole allowance says something different:
  *"4,312 changed lines — too large to open with everything else"*. That's a
  different fact and it gets a different sentence.
- **A folded file never costs you the information that it changed.** Its
  heading, its status letter and its line counts are all still there.

Click any heading to open or fold that file. The **⊟** button in the toolbar
folds everything at once, and becomes **⊞** to open it all again.

**Your folding sticks.** If you fold a huge file away and the panel notices the
project changed underneath it, that file stays folded — it won't spring back
open.

### The rest of the toolbar

- **Split / Inline** works as it does in the Changes tab, for every file at once.
- **⧉** on a single file's heading opens just that file in its own panel — handy
  when you want to keep one file in view while scrolling the rest.
- **⧉** at the far right moves the whole panel into its own window.

**What isn't here yet:** the **＋ Stage** buttons the design sketches for each
file. They need the ability to change your repository, which switchboard doesn't
have yet, so they're left out rather than drawn and dead.

## Syntax colouring

Code in the diff is coloured for its language, worked out from the file's name
— `.ts`, `.py`, `.rs`, `.go`, `.md`, `Dockerfile` and around a hundred other
names and extensions between them. Colours follow the app's light or dark
setting, and switch with it.

A file switchboard doesn't recognise is shown as plain text rather than
coloured wrongly, so an unfamiliar extension costs you colour, never accuracy.
For the same reason a few extensions it *could* guess at are left plain
deliberately — `.m` is Objective-C about as often as it's MATLAB, so it stays
uncoloured rather than being coloured wrong half the time.

A few languages borrow a near neighbour's rules, the two you'll notice being
**JSON** (coloured as JavaScript, which agrees with it on everything JSON has)
and **TOML** (coloured as INI).

This is colouring only — no squiggly error underlines, no hovers, no
autocomplete. The Changes tab is for reading what happened, not for editing,
and warnings about half-finished work in progress would be noise.

The app's four themes collapse to two here: **daylight** gives the diff its
light colours and the other three give it dark ones. A palette tuned to
**high-contrast** specifically is a later change.

## See also

The **History** tab beside this one shows the project's commits — what landed,
when, and which branches and tags point where. See [History](22-history.md).

## Good to know

- switchboard **shows** you changes — it doesn't commit, push, stage, or revert
  anything. Git is yours to drive, wherever you normally do it.
- The diff reflects what's on disk right now, including changes you made
  yourself outside the app.
- **switchboard ignores instructions a project leaves for it to run a program.**
  A git repository can be set up to run a command of its choosing whenever
  anything reads its files — normally to speed up very large projects, or to
  handle big binary files — and it can leave scripts in a hidden folder that git
  runs for the same reason. switchboard reads your projects constantly to draw
  this tab, so it declines all of that: a session that can edit files shouldn't
  be able to get the app to run something for it. Handlers you installed
  yourself, **Git Large File Storage** being the common one, keep working
  exactly as before — only ones written into the project folder itself are
  skipped, and this covers a project's sub-projects too.

  The one setup this can't help: if you turned on Large File Storage **for a
  single project only** (`git lfs install --local`) and never installed it for
  your account, switchboard won't be able to read that project's changes — the
  tab tells you so, and quotes what git said. Running `git lfs install` once,
  without `--local`, fixes it for good.

## When the tab says it couldn't read your project's git

Most of the time the Changes tab has three things to say: your changed files,
**Working tree clean**, or **Not a git repository** for a folder that simply
isn't under version control. A fourth message means something went wrong:

> switchboard couldn't read this project's git — *…*

The part after the dash is the reason, and usually it's git's own words. Some
you might see:

- **git could not be started** — git isn't installed, or isn't somewhere the app
  can find it.
- **that folder no longer exists** — the session's project folder has been
  moved, deleted, or is on a drive that isn't connected.
- **detected dubious ownership…** — git refuses to touch a repository owned by a
  different user account, which on Windows usually means the folder was created
  by an installer, a different login, or an elevated command prompt. Tell git the
  folder is fine with `git config --global --add safe.directory <the folder>`.
- **git could not enumerate this repository's own configuration** — the project's
  git settings can't be read at all, which usually means a damaged checkout.
- **this git is too old…** — git needs to be version 2.31 or newer for the
  safety rule described above. Upgrading git fixes it.
- **switchboard could not check whether this git applies its safety overrides**
  — that check didn't finish in time, usually a very slow or network drive.
  This one often clears by itself; switch away from the tab and back.

The point of this message is that it is *not* **Not a git repository**. Until
now every one of these failures said that instead, which is a confident claim
about your project that happened to be false — and one that reads as "switchboard
has lost my work" when the real problem is a disconnected drive.

Nothing else in the app changes when this happens: the session keeps running,
and the git line on the session's card simply goes quiet rather than showing you
a branch and a change count it couldn't actually check.
