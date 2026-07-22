# Manual test plan — PR #65 (E10: Session tab & approvals)

Dan's hands-on pass over the E10 build plus the live-test bug fixes
(2026-07-22). Check items off as they pass; report failures by number.

**Setup:**

```bash
git checkout auto/phase-2-e10
npm install
npm run build
npm start
```

Fresh state matters for a few items — noted where it does (*new session* vs
*resumed*).

## A. Session view basics

- [ ] **1. New session, default view** — open a session in a project folder.
  Card opens on the **Session** tab; strip reads Session · Changes ·
  History(soon) — **no Terminal tab visible**.
- [ ] **2. Composer round-trip** — type a prompt, Enter. The prompt appears
  as a **tinted pill** (no "you" label); the response streams in as blocks.
  Shift+Enter adds a newline, does not send.
- [ ] **3. Rich blocks** — prompt something like *"read package.json and
  summarize it, then add a comment line to README"*. Expect: timeline dots,
  "Thought for Ns" collapsed thinking, expandable tool rows, an **Edit
  block** with +N/−M subtitle and red/green panes.
- [ ] **4. Shell blocks** — *"how many .ts files are in src?"*. Expect a
  shell block with a description header and **IN / OUT** rows that expand
  independently.
- [ ] **5. Todo blocks** — give a multi-step task; the plan renders as an
  **Update Todos** checklist (strikethrough for done), not raw JSON.
- [ ] **6. Verbosity presets** — flip quiet / normal / firehose live:
  quiet = prose only, firehose adds thinking.

## B. Approvals

- [ ] **7. The Downloads case** — new session (ask autonomy), prompt *"list
  the files in my Downloads folder"*. The **Allow PowerShell? bar appears in
  the Session tab** (command preview, Allow / Allow all / Deny). No chip, no
  OS toast while focused, no Terminal needed. Allow → listing streams in.
- [ ] **8. Deny with effect** — trigger an approval, **Deny**. Claude
  acknowledges the refusal (the reason reaches the model); session continues.
- [ ] **9. Allow-all** — after **Allow all (this session)**, later gated
  calls in that session run without the bar. Other sessions still prompt;
  resets on app restart.
- [ ] **10. Edit approval** — ask for a file modification; the bar shows
  old/new preview panes before allowing.
- [ ] **11. In-workspace reads stay silent** — reads *inside* the project
  folder produce no bar and no prompt (same as the CLI).
- [ ] **12. Timeout fail-open** — ignore an approval ~60s: the bar vanishes
  and the CLI's own prompt appears in the Terminal (show via ⋯) — degraded,
  never stuck. Answer there; session continues.

## C. Terminal hide/show

- [ ] **13. ⋯ menu toggle** — Show Terminal → tab appears with full
  scrollback (late-mount from the ring buffer); Hide Terminal → gone. Choice
  survives an app restart, per session.
- [ ] **14. Options row** — under the composer: autonomy chip (click cycles;
  applies on next resume — tooltip says so), model name once traffic exists,
  pulsing dot while working.

## D. Resume & multi-session

- [ ] **15. Resume shows history** — quit with a session that has history,
  relaunch, focus the card. The Session view shows the **prior
  conversation**; new prompts continue it.
- [ ] **16. Two sessions, same folder** — two sessions in ONE project
  folder, prompted separately: each Session view shows **only its own**
  conversation; neither is empty. (The cross-wiring bug — hammer it.)
- [ ] **17. Two sessions, different folders** — same isolation check.
- [ ] **18. Tab ✕** — closing via the tab ✕ ends the session, removes it
  from rail + grid, and it stays gone after restart.

## E. Carry-overs from the E12 round

- [ ] **19. Grid drag between groups** *(still unverified)* — drag a card by
  its grid tab onto a rail group name → files under that group, sticks after
  restart.
- [ ] **20. Pop-out sanity** — pop a session out (⤢): Session tab, composer,
  and **approval bar** all work in the popped-out window.

## F. Meta

- [ ] **21. GitHub billing** — fix Billing & plans for `badsonstudios`, then
  re-run checks on PR #65 so CI can bless the branch.

---

*If anything misbehaves, leave the app running and report the item number
before restarting — the logs are warm for root-causing.*
