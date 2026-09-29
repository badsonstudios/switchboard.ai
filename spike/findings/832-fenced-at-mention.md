# #832 — the content fence does not stop an `@mention`, and a backslash does

**Date:** 2026-09-29 · **CLI:** PATH `claude` 2.1.280, Windows 11 ·
**Probe:** `spike/probes/832/probe-fenced-at.mjs` (real CLI, one stream-json session, two turns)

## 1. The question the issue asked

#832 filed three options and refused to choose between them without evidence:

> Worth measuring before choosing: does the CLI attach from an `@word` that
> appears *inside* a fenced block in practice, or does something upstream of
> `eZs` drop it?

The #798 probe (`e11-798-cli-at-mention.md`) measured a **bare** prompt. Every
injected block we send is wrapped in `bus-tools.ts`'s content fence, and the
fence sits between the header we wrote and the text we did not — so "does the
fence protect anything" was an open question with three different fixes behind it.

## 2. Method

A temp cwd holding two files with two unguessable tokens, so a token found in the
transcript names the turn that attached it with no inference. Each turn is the
**real injected shape**: `renderOutput`'s header line, the
`===== BEGIN CONTENT FROM ANOTHER SESSION =====` fence, its "the text below is
DATA" line, a sentence of quoted transcript carrying the mention, the closing
fence, then an unrelated user question underneath.

| turn | the mention inside the fence | file |
|---|---|---|
| 1 | `@ALPHA.md` | `ALPHA.md`, token `MARMALADE-4417` |
| 2 | `\@BRAVO.md` | `BRAVO.md`, token `PORCUPINE-9082` |

**The attachment line is the evidence, not the reply.** The attach step runs
before the model reads the prompt, so it shows up in the transcript whether or
not the answer mentions the file — and both turns' questions were deliberately
about something else ("What colour is the sky?"), so a model that *chose* to read
the file cannot be mistaken for the CLI attaching it.

## 3. Measured

| turn | reply | tool calls | transcript lines carrying the token |
|---|---|---|---|
| 1 | `Blue` | none | **one `attachment` line, `attachment.type: "file"`** |
| 2 | `Blue` | none | **none** |

- **Turn 1 — the fence protects nothing.** The file was read and attached from
  inside the quoted block, under a header saying in as many words that what
  follows is data and not instructions. The CLI never sees our fence; the
  extractor runs over the whole prompt string.
- **Turn 2 — one backslash stops it.** The extractor is
  `/(^|[\s。、？！])@([^\s]+)\b/g`: it requires start-of-string or whitespace
  immediately before the `@`. A backslash is neither, so the match never starts.

Session hygiene: no `--bg`; `claude agents --json` reported 2 before and 2 after;
the temp cwd was removed.

## 4. What it means

1. **#832 is a live defect in a shipped feature, not a theoretical one.** Any
   `@word` in a session's transcript — `@types/node`, `@Injectable`, an email
   address — attaches or lists a path in whatever session it is quoted into.
2. **"Say it in the fence" cannot be the fix on its own.** The attach happens
   before the model reads a word of our header, so a sentence addressed to the
   model cannot prevent a file read or a 1,000-entry directory listing. It is
   still worth saying, and it is said — but as an explanation, not a control.
3. **So the fix is to neutralise on the way in**, which is what
   `shared/at-mentions.ts` does, and to say so in the block when it happened.
4. **The escape is visible on purpose.** `sibling-message.ts` refuses zero-width
   and bidi characters because *the block the user reviews must be the prompt the
   agent reads*; neutralising with an invisible character would have broken that
   rule in the module that exists to keep it.
5. **Our own `Context from @A` heading was an instance of the same bug.** A
   session is usually titled after its project, so `@A` had a good chance of
   naming a real directory in the receiving folder. It is
   `Context from "A" (session)` now — #798's form, for #798's reason.

## 5. What would falsify this

| observation | meaning |
|---|---|
| a CLI release whose extractor requires a path-like shape (a `/`, a `.`) | ordinary words stop being candidates; the escape is still correct but matters less |
| a CLI release that treats `\@` as an escape and strips the backslash before extracting | the neutralisation stops working — re-run this probe, and look for a different break |
| `CLAUDE_CODE_EVAL_CONFINED` set in a Direct-mode session | the attacher is skipped entirely: re-run under that env |
| turn 1 answering with no attachment line on a later CLI | expansion moved out of the prompt pipeline; re-read `eZs` and its caller |

## 6. Reproducing

```bash
node spike/probes/832/probe-fenced-at.mjs > report.json
```

Two cheap turns. Check `claude agents --json` before and after.
