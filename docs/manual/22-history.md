# History

> ⚠️ **Status: draft, and the tab is NOT CLICKABLE YET.** Written ahead of the
> surface it describes, so it is here the day the tab lights up rather than a week
> after. What exists today is the machinery behind it — switchboard can now read
> your project's commit history — and the tab is still greyed out.
>
> **This warning is not boilerplate.** This whole piece of work exists because two
> of switchboard's own documents described this exact tab as finished when it was
> an empty placeholder, and nobody noticed until the tab was clicked. A page that
> describes an unbuilt thing in the present tense is the same mistake in a
> friendlier font.
>
> TODO: screenshots · the search box · the incoming and outgoing rows · what the
> lanes drawn down the left of the rows mean · opening a commit to see its files.

## What it will be

Every session's card has a **History** tab beside **Changes** and **Files**. It
will show the commits in that session's project — who made each one, when, what
it was called, and how many lines it touched.

## What a row tells you

| Part of the row | What it is |
|---|---|
| The subject | the commit's first line — what the author called it |
| The author | who wrote it, and when |
| **+12 −3** | lines added and removed across the whole commit |
| The short code (`b2723f66`) | the commit's identifier, shortened to eight characters |
| Chips | the branches and tags that point at this commit |

**A branch chip and a tag chip look different, and that matters.** A branch and
a tag can have the same name — `release` as a branch and `release` as a tag are
two different things pointing at two possibly different commits — so switchboard
asks git for the long form of every name and draws them as separate kinds of
chip. The branch you currently have checked out is marked.

## Things git does that look like bugs and are not

- **The oldest commit in a project shows every file as new.** It is: the first
  commit has nothing before it to compare against, so every line in it is an
  addition. Git itself has no other answer to give.
- **A commit can show no line counts at all.** An empty commit — one made
  deliberately with no file changes, which some release and checkpoint workflows
  do — has no numbers, and switchboard shows nothing rather than showing you a
  zero it made up.
- **A merge shows the changes it brought in.** The line counts on a merge are
  measured against the branch you were on, so they tell you what arrived, not
  what the whole merge contained.
- **The list may not be in strict date order.** Commits are ordered so that a
  branch's commits stay together, which is what makes the shape of the history
  readable. A commit made on a side branch last Tuesday appears with its branch,
  not between Tuesday's other commits.

## It loads in pages

The tab asks git for fifty commits at a time, not for your whole history. On a
project with a thousand commits, asking for all of them takes about three
seconds; fifty takes well under one. There is more below when you want it.

This is a deliberate trade and it is measured, not guessed: almost all of that
time is git working out the line counts for each commit, which it does by
comparing every commit against the one before it.

## When it cannot read the history

The tab says so, in git's own words, the same way the **Changes** tab does — see
[Changes & git](08-changes-and-git.md), "When the tab says it couldn't read your
project's git", for the list of reasons and what to do about each. Two answers
are specific to this tab and are **not** errors:

- **This project has no commits yet.** A folder where you have run `git init`
  and nothing else. It is a repository, it just has no history to show.
- **This folder is not a git repository.** Same as the Changes tab: not an
  error, just a folder that is not under version control.

As everywhere else in switchboard, a failure here costs you the history and
nothing else — the session keeps running and the other tabs keep working.
