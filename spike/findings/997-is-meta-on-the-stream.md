# #997 — `is_meta` on the stream: the flag is real, the frame never came

**Probe:** `spike/probes/997/probe-is-meta-on-stream.mjs`
**CLI:** 2.1.280 (PATH), Windows 11 native
**Date:** 2026-09-30
**Session:** `c10a7680-c199-461a-9402-36605013b748` (temp cwd, removed)

---

## The one-line answer

**No `is_meta` frame reached our stream**, on the only turn shape that could
plausibly produce one, with both harness assertions passing. But the flag is
**not** a misreading: `is_meta` is a declared optional field on the CLI's
outbound wire schemas for *both* message types the Feed parses, and the CLI's
own wire reader drops it. So the finding is exactly the one the issue offered as
an acceptable outcome — **the check was spelled for one transport and applied to
two** — and the shipped change is a guard on a declared field, not a fix for
anything a user can see today.

`blocks.ts` now reads `entry.isMeta === true || entry.is_meta === true`.

---

## 1. The frame the issue was filed about is unreachable from our spawn

The issue asks for a `PushNotification` `tool_use` frame with `is_meta: true` to
be provoked. **It cannot be, and reading the binary is what says so** — this was
settled before a single token was spent, which is why the probe targets
something else entirely.

The builder is a one-liner in the PATH binary:

```js
var Ve = "PushNotification";
function eao(e, r) {
  return { type:"assistant",
           message:{ …, model: zl /* "<synthetic>" */, role:"assistant",
                     stop_reason:"tool_use",
                     content:[{ type:"tool_use", id:x(), name:Ve,
                                input:{ message:e, status:"proactive" }}] },
           parent_tool_use_id:null, is_meta:!0, session_id:r, uuid:x() };
}
```

`eao(` has **exactly two occurrences in the whole binary** — its definition and
one call site. The call site is this:

```js
case "connected": {
  …
  if (ai && !cn.current && !Sn.current) {
    let Zi = nLr();
    if (Zi && rLr(Zi, is, xs)) {
      if (cn.current = !0, Zi.probability >= 1 || Math.random() < Zi.probability)
        ai.writeSdkMessages([eao(VDr, K())]), oLr(Zi, Xe)
    }
  }
  break }
```

Four independent reasons that is out of reach:

1. **It is in the interactive REPL.** The enclosing state machine is the
   repl-bridge hook — the same function logs `[bridge:repl]` and drives
   `replBridgeConnected` / `replBridgeSessionActive` / `replBridgeSessionUrl`
   through a React setter. Our spawn is `--output-format stream-json
   --input-format stream-json`; there is no REPL to mount it.
2. **It fires on a Remote Control bridge connecting** — `case "connected"` of
   that bridge's lifecycle. We never connect one.
3. **It writes to the bridge, not to stdout.** `writeSdkMessages` is the
   remote-bridge egress (`[remote-bridge] Queued N SDK event(s) during flush`,
   `[bridge:sdk] …`). Its frames go to the phone/web surface.
4. **Two remote configs, both defaulting off.**
   - `nLr()` returns `null` unless `cJ()` — which is
     `x("tengu_kairos_push_notifications", false)` — is on, **and**
     `x("tengu_kairos_ready_nudge", null)` is a non-null object. Both defaults
     are off/absent.
   - `rLr()` then refuses on `Tt() || bE() != null`, and caps impressions at 5
     via `remoteControlReadyPushCount` in the user's config.

For the record, the message it would carry is
`"Your Claude Code session is ready — continue from your phone anytime."` — a
mobile-onboarding nudge. The `PushNotificationTool` itself is behind the same
`tengu_kairos_push_notifications` gate (`isEnabled()` is literally that call),
so the model cannot invoke it either.

**This is proof by code reading, not by probe**, and it is stated as such. What
it rules out is "the frame we happen to know about". It does not rule out the
field.

## 2. So the probe went after a producer that IS reachable — and it changed the answer

The same read of the binary turned up a second `is_meta: true` builder, in the
internal→wire converter, on a path that needs no gate and no bridge:

```js
case "attachment":
  if (n.attachment.type === "hook_system_message")
    return [{ type:"assistant", message: Sc({content:$n(n.attachment)}).message,
              parent_tool_use_id:null, is_meta:!0, session_id:K(),
              uuid:n.uuid, timestamp:n.timestamp }];
```

A **hook whose JSON output carries `systemMessage`** becomes a
`hook_system_message` attachment. Hooks are not exotic — switchboard writes its
own on every spawn (`buildHookSettings`, passed through `--settings`), and so
does anyone with a `settings.json`. That made it the right target: one cheap
turn, and a real chance of an `is_meta` frame.

**It did not happen.** The probe fired a `UserPromptSubmit` hook and a `Stop`
hook, both returning `{"systemMessage": "…"}`, and the attachment demonstrably
existed — three transcript entries prove it — but on the wire the same event
arrived as:

```json
{"type":"system","subtype":"informational",
 "content":"UserPromptSubmit says: SB997-HOOK-SYSTEM-MESSAGE [UserPromptSubmit]",
 "level":"notice","uuid":"…","session_id":"…"}
```

and again for `Stop`. **No `is_meta`, no synthetic `assistant` frame.** On
2.1.280 this build routes `hook_system_message` down the
`system:informational` converter for an SDK spawn; the `is_meta: true` assistant
converter is present in the binary but is not the one on this path.

> This is the single most useful thing the probe did, and it is a correction to
> my own prediction. The binary said "this becomes an `is_meta` assistant
> frame"; the CLI, driven, said "it becomes `system:informational`". **Locating
> a builder is not verifying it** — §1.2.1 vs §1.2.2 of
> `docs/reference-implementations.md`, in a new shape.

### The harness assertions, both green

`hookRan: true`, invocations `["UserPromptSubmit","Stop"]` (the hook appends to
a marker file, so "it ran" is provable with nothing on the stream) and
`controlWorked: true`, `controlText: "MARMALADE-9971"`. Without both, "no
`is_meta` frame" would be a statement about the probe.

### The full flag census over that session's stream

Every key matching `/^is[_A-Z]/`, at the frame's top level and inside
`message`, over all 18 frames:

| where | key | values |
|---|---|---|
| `frame` | `isReplay` | `true` (×1, the `--replay-user-messages` echo) |
| `frame` | `is_error` | `false` (×1, on `result`) |

Nothing else. Frame types: `system:init` 1, `system:informational` 2,
`system:status` 1, `user` 1, `stream_event` 10, `assistant` 1,
`rate_limit_event` 1, `result:success` 1.

And over the transcript's 26 entries: `isSidechain: false` only. Not one of
`isMeta`, `isVisibleInTranscriptOnly`, `isCompactSummary` appeared on either
side of this session — which is expected for one plain turn and is why the
census is reported as a set rather than as three pass/fail assertions.

## 3. Why the guard ships anyway: the CLI declares the field, twice

The probe's silence is about *one turn shape on one build*. These two facts are
about the **contract**, and they are what make the change a contract fix rather
than a speculative hedge.

**(a) `is_meta` is in the outbound wire schema for both shapes the Feed
parses.** Two separate zod definitions, each with Anthropic's own
`.describe()`:

```
user shape:       is_meta: A(!0).optional()
  "@internal True when the message was synthesized by the loop
   (not user keyboard input)."
assistant shape:  is_meta: A(!0).optional()
  "@internal True when the message was synthesized by the loop
   (not a model response)."
```

`deriveIntents` reads `type: 'user'` and `type: 'assistant'`. Both.

**(b) The CLI's own wire reader drops it — and renames it in the same
function.** `UFe()` is the wire→internal ingest converter (its arguments are
`wire_tool_inputs` and `wire_ingest_context`, so there is no ambiguity about
which direction it faces):

```js
function UFe(e){ return e.flatMap((r)=>{ switch(r.type){ case "assistant":
  if (typeof r.local_command_source === "string")
    return [{ type:"system", subtype:"local_command", …, isMeta:!1, … }];
  if (r.is_meta === !0) return [];        // <- reads the WIRE spelling
  …
```

One function reads `is_meta` off the wire and writes `isMeta` into the internal
shape. **The rename is the transport boundary**, not version drift — which means
it will not "settle" on a future build, and a reader that handles one spelling
is permanently half-right. It also means our `=== true` matches theirs exactly.

## 4. The sibling flags (the issue's item 3) — and one gap left open

The issue asks about `isVisibleInTranscriptOnly` and `isCompactSummary`. Both
have snake_case wire twins, on the **user** shape, alongside a third we had not
noticed:

| wire key | hits | the CLI's own description |
|---|---|---|
| `is_meta` | 8 | synthesized by the loop |
| `is_visible_in_transcript_only` | 2 | "stored in the transcript but **not rendered in the live UI**" |
| `is_virtual` | 12 | "Display-only: rendered in the UI but filtered before API send" |
| `is_compact_summary` | 2 | "this user message is a compact-summary synthetic message" |

Where we stand on each:

- **`isCompactSummary` is fine.** Its only reader is
  `isCompactSummaryEntry` in `sessions/context-package.ts`, which is a
  **transcript-only** consumer by construction. camelCase is the correct and
  complete spelling there. No change.
- **`isVisibleInTranscriptOnly` is read by NOTHING, in either spelling.** Our
  only mention of it is a comment. The CLI's description is blunt — *not
  rendered in the live UI* — so an entry carrying it is one the Feed is being
  told to skip, and the Feed does not.

  **Deliberately not fixed here.** #997 is a spelling fix to a drop rule we
  already have; adding `isVisibleInTranscriptOnly` is a **new drop rule with
  different semantics** (transcript-visible-but-not-live is not the same claim
  as loop-synthesized), it was not observed either, and bundling it would hide
  a behaviour change inside a rename. It wants its own issue. Raised in the
  hand-off.

## 5. Method notes worth keeping

- **A silent probe is worth suspecting over a silent CLI** (S-09's lesson, and
  #760's). Two independent assertions — a hook marker file and an echoed
  control token — are what let "no `is_meta` frame" be written down at all.
- **Census, don't assert.** Scanning every frame for `/^is[_A-Z]/` and
  reporting the set found `isReplay` and the *absence* of three named flags in
  one pass, and would have caught a spelling nobody predicted. Three
  `expect(frame.isFoo)` checks would have found nothing and said nothing.
- **`--permission-mode default` and a prompt with no reason to act.** #760's
  `bypassPermissions` probe was not contained by its cwd and went reading this
  machine's other live sessions. This one needed no tools, so it was given
  none.
- **Cost: one model turn** (a single-word reply), plus free binary reads. The
  expensive question — the PushNotification frame — was answered for free, and
  the token spend went to the question reading could not settle.
