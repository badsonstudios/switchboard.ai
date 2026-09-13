# Probes for #779 — transcript schema drift

Findings: [`spike/findings/e11-779-schema-drift.md`](../../findings/e11-779-schema-drift.md).

Both probes are **pure reads of transcripts already on disk** — no CLI spawn, no
tokens spent — so they are cheap to re-run against any later CLI release, which is
the point of committing them. Re-run them rather than re-deriving the numbers.

| Probe | Question it answers |
|---|---|
| `corpus-drift.ts` (via `run.mjs`) | Which keys does the **shipped** `drift.ts` not know about, across every transcript on the machine — and what CLI versions wrote each one? |
| `usage-details.mjs` | Is `message.usage.output_tokens_details.thinking_tokens` a **breakdown of** `output_tokens`, or a quantity to add on top? |

```bash
node spike/probes/779/run.mjs            # [transcriptsRoot]
node spike/probes/779/usage-details.mjs  # [transcriptsRoot]
```

Default root is `~/.claude/projects`.

## Three things these were built to avoid

**Measure the detector we ship, not a copy of it.** `corpus-drift.ts` imports
`src/main/transcripts/drift.ts` and is bundled by `run.mjs` with esbuild (already
a dependency) for exactly this reason. A hand-written second walker would measure
the walker, and the question is what *our* detector does not know about.

**A corpus without version stamps is a pile.** Every transcript line carries the
CLI `version` that wrote it, so the probe reports each key's version *range*.
That is what separates "the CLI added this in 2.1.261" from "this has been here
since 2.1.226 and our corpus was too small to contain it" — two findings that
look identical in a count and lead to completely different work.

**Every trial needs a control, including its denominator** (#776's round-3 probe
reported two bypasses "held" when its own setup had made them impossible).
`usage-details.mjs` prints three counters beside its violation count: how many
lines carry the field, how many were **actually comparable**, and how many have a
non-zero value. The middle one is a review finding — the first version silently
skipped lines with no numeric `output_tokens`, so "0 violations over 42,374
lines" could have meant "0 over the 3 that were compared" with nothing on screen
to show it.

## What the answers were

- **30 findings** over 3,259 files / 244,916 lines / 0 malformed — not the 5 that
  `check:transcripts` reports off one `-p` turn. Precisely: **26 unknown field
  names + 4 unknown line `type` values**. Zero under `message` or
  `message.content.*`.
- **`thinking_tokens` is a breakdown**: 42,374 lines carry it, all 42,374
  comparable, 26,078 with a non-zero value, it exceeded `output_tokens` **zero**
  times, max ratio 0.9928.
- After the fix: **0 findings** over 246,579 lines, same probe. That before/after
  pair is the control on the fix itself.

## Not a probe, but read alongside them

The 38 line types now in `KNOWN_LINE_TYPES` came from **grepping the PATH binary**
(`docs/reference-implementations.md` §2.1), not from either probe — two
independent routing tables inside CLI 2.1.261 enumerate the same 38, and the
reducer beside them names the payload field read for each. Nothing there needed a
probe; it needed someone to look.
