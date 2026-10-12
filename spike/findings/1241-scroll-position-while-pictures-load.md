# #1241 — does the reader move while pictures load in the conversation?

Measured 2026-10-12 on the desktop (Windows 11, a 1400 x 900 window), in the
real app with the fake CLI. Probe: `spike/probes/1241/pictures-scroll.spec.ts`
(copy into `e2e/` to run). **Not measured on the laptop**: the ticket asked for
both machines and only this one was to hand.

## Short answer

**No. A reader who is scrolled up does not move when pictures above them load,
and a reader following the tail stays on the tail.** Nothing had to be
reserved. One thing IS inexact, and it is not the reader's position: after a
restart, the conversation's total height is short by the height of the
pictures in the replayed history until that part is scrolled to. The obvious
fix for that was built, measured, found to MOVE the reader, and taken out.

## Method

Six replies, each with one picture and a paragraph of text; picture heights
80, 200, 420, 700, 300 and 1,000 px (two taller than the conversation's 420 px
cap), then sixty one-line replies so the pictures are far above the tail.

"Moved" is the distance between one block's top edge and the top of the
conversation's pane, read **every animation frame**, so a jump corrected a
frame later still counts. Each case was run with SVGs of a few hundred bytes
(a load is faster than a frame) and with 12 MB bitmaps (a load takes several
frames, so the frames in between are seen).

A first sight is produced by replacing a picture with a fresh `<img>`: no
`width`, no `height`, and one more query parameter on the address. The
parameter matters. A page answers an address it has already shown from its own
memory, at once and with no load at all, so the first version of this probe
(the same address) measured nothing: the conversation's height never changed
in any frame.

## Numbers

| Case | Pictures | Frames | Worst drift of the reader | Frames moved by 1 px or more | Conversation height while it ran |
|---|---|---|---|---|---|
| Following the tail, every picture a first sight | SVG | 62 | 0 | 0 | 459 to 3,013 px |
| Following the tail, every picture a first sight | 12 MB | 62 | 0 | 0 | 459 to 3,009 px |
| Scrolled up 1,000 px; all pictures above load as first sights (4 of them in skipped blocks) | SVG | 51 | 0.5 px | 0 | 5,023 to 5,025 px |
| The same | 12 MB | 73 | 0.1 px | 0 | **4,592 to 5,012 px** |
| After a restart, opened at the tail | SVG | 90 | 0 | 0 | 3,190 px |
| After a restart, opened at the tail | 12 MB | 90 | 0 | 0 | 3,190 to 4,182 px |

- **Following the tail** ends 0 px from the bottom in every run. In 6 to 8 of
  about 62 frames it was up to 420 px off the bottom: the frames between a
  block landing and the re-pin. That is every block's arrival, not a
  picture's.
- **Scrolled up, 12 MB pictures**: the conversation really did collapse by
  420 px and grow back while the reader watched, across several frames, and
  the reader's block moved a tenth of a pixel. That is the browser's scroll
  anchoring, which the conversation leaves on (`lib/feed-pin.ts` says why).
- **After a restart**: the conversation opens 1 px from its tail and stays
  there.

Then, after the restart, one notch of the wheel at a time (100 px) up to the
top, asking at each notch whether the text moved 100 px:

| Pictures | Notches | Notches where the text did not move 100 px | Height at the tail | Height at the top | Correction |
|---|---|---|---|---|---|
| SVG | 45 | **0** | 3,190 px | 5,023 px | 1,833 px in 5 steps |
| 12 MB (run 1) | 45 | **0** | 3,190 px | 5,011 px | 1,821 px in 5 steps |
| 12 MB (run 2) | 45 | **0** | 4,182 px | 5,011 px | 829 px in 2 steps |

So the ticket's third worry is half right. A picture inside a skipped block
does not report its growth, and **the total height is inexact until it is
scrolled to**: 3,190 of a true 5,023 px here, which is the sum of the six
pictures' drawn heights (1,840 px). But **the correction does not arrive as a
jump**: 0 of 45 notches. What the user can see is the scrollbar's thumb, which
is too long after a restart and shortens in steps on the way up.

What the ticket's four cases come to:

| The ticket said | Measured |
|---|---|
| Following the tail: fine | Fine. 0 px at the end, every run. |
| Reading further up, a picture loading above: rests on the browser | Holds. 0.1 to 0.5 px, no frame moved. |
| A picture inside a skipped block: the correction arrives as a jump | No jump (0 of 45). The total height is short until it is scrolled to. |
| First sight: nothing is reserved | True, and it does not move the reader. |

Also seen, and not this ticket's: leaving the Session tab and coming back
opens the conversation at its tail, not where the reader was. The reading
position is kept across a panel move, not across the tab's whole tree being
torn down.

## What was tried for the inexact height, and why it is not in

When a picture loads at a size nothing had reserved, tell the skipping, which
drops the stored height of the group the picture is in so that group is laid
out once and measured again (`regroup`, the path a changed child list already
takes). Built, with unit tests, and measured on the same probe:

| Case | Before | With the change |
|---|---|---|
| Scrolled up, pictures above load (SVG) | 0.5 px | **299.5 px, 55 of 57 frames** |
| Scrolled up, pictures above load (12 MB) | 0.1 px | **418.7 px, 55 of 57 frames** |
| Height correction after a restart | 1,833 px | 1,833 px (unchanged) |

It moved the reader by a picture's height and did not fix the thing it was
for. Un-skipping a group above the view is a layout change the browser's
anchoring does not hold against, and after a restart the pictures load before
their groups have a stored height to drop, so there was nothing to re-measure.
Reverted. **A re-measure of a skipped group above the reader is a way to move
them**; anything that wants the total height exact after a restart has to
know a picture's size BEFORE the block is first laid out (from main, with the
block), not correct it afterwards.

That is not built. The cost of leaving it: a scrollbar thumb that is too long
after a restart, in a conversation whose replayed history holds pictures,
until that history is scrolled through once.

## What is pinned

`e2e/feed-picture-scroll.spec.ts`: a reader scrolled up does not move (under
2 px in any frame) while every picture above them loads as a first sight, and
a conversation that was following its tail still is.
