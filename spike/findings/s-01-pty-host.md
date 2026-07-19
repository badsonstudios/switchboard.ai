# S-01 findings — PTY-host the real CLI

**Status:** ✅ **GO** — mechanism proven; interactive checklist passed in full
(Dan, 2026-07-19).
**Harness:** `spike/` — Electron 43 + node-pty 1.1.0 (ConPTY) + xterm.js 6.

## Verdict (so far)

Spawning the real `claude` CLI under ConPTY inside Electron **works**. Direct
spawn of the npm `.cmd` shim succeeds — no `cmd.exe /c` wrapper needed. First
output in **84–96 ms**; full TUI ANSI stream flows through node-pty → IPC →
xterm.js. A full interactive session (slash commands, permission prompts, plan
mode, interrupts, aggressive resize, exit/relaunch) is usable with **no visual
corruption**. The win32-input-mode request (`?9001h`) that xterm.js doesn't
implement caused no observable keyboard problems — Shift+Tab, Esc, Ctrl+C and
menu navigation all worked. **Phase 1 can build on this stack as designed.**

## Build/environment quirks (each cost real time; Phase 1 must plan for them)

1. **`NoDefaultCurrentDirectoryInExePath=1` breaks node-pty's gyp configure.**
   winpty's gyp runs `cd shared && GetCommitHash.bat`; with this var set, cmd
   refuses to execute a `.bat` from the current directory. The var is injected
   by Claude Code's shell sessions (not set machine-wide) — i.e. *builds driven
   from an AI session fail where a human terminal succeeds*. Dogfooding
   implication: switchboard must expect env-hygiene differences in hosted
   sessions. Spike fix: `rebuild.js` unsets it for the child.

2. **node-pty demands Spectre-mitigated MSVC libs (MSB8040).** Dan's VS 18
   Community lacks the component. Spike fix: `rebuild.js` strips the
   `SpectreMitigation` gyp setting (throwaway-acceptable). **Phase 1 decision:
   install the "MSVC Spectre-mitigated libs" VS component in dev/CI instead of
   patching.**

3. **`ELECTRON_RUN_AS_NODE=1` leaks from the host Electron** (VS Code / Claude
   Code terminal) and silently turns our Electron into plain Node
   (`require('electron')` → path string, `app` undefined). Spike fix:
   `launch.js` scrubs it. Product implication: env curation when spawning any
   child, and anyone launching switchboard from an IDE terminal hits this.

4. **No node-pty prebuilds for Electron** — `@electron/rebuild` is mandatory
   after `npm install` (works once quirks 1–2 are handled). Phase 1: wire into
   postinstall; electron-vite templates usually do.

## Spawn mechanics

- `pty.spawn('claude.cmd', [], { useConpty: true, ... })` resolves via PATH and
  works directly. Fallback `cmd.exe /c claude` also works but masks
  missing-CLI errors (shell prints the error and exits — the smoke test treats
  early child exit as FAIL for this reason).
- **Phase 1 note:** resolve the CLI to an absolute path before spawn. A
  PATH-relative `.cmd` spawn with cwd = an arbitrary user project is a
  planted-binary footgun (current-directory search order on Windows).
- Kill-on-window-close works; orphan check is on the interactive checklist.

## Observed TUI behavior (from raw output capture)

On startup claude requests: `?9001h` (**win32-input-mode** — ConPTY-specific
keyboard encoding), `?1004h` (focus reporting), `?2004h` (bracketed paste),
`?2031h` (palette-change notifications), cursor-style query (`>0q`), and sets
the window title (`]0;claude`). xterm.js ignores modes it doesn't implement;
whether win32-input-mode ends up mattering for keys like Shift+Tab is exactly
what the interactive checklist probes.

## Perf notes for S-07

- Harness has **no flow control**: pty → IPC → `term.write` unbounded. Fine for
  one interactive session; S-07 must either measure with backpressure
  (xterm `write(data, cb)` + node-pty `pause()`/`resume()`) or consciously
  record numbers without it.
- "Bytes" figures are UTF-8 byte counts of the decoded stream.

## Interactive checklist results (Dan, 2026-07-19)

**All items passed — no visual corruption on any of them:**

- [x] Welcome/trust TUI renders correctly
- [x] Streamed response clean
- [x] Slash-command menu draws + clears
- [x] Permission prompt navigable (arrows/Enter)
- [x] Shift+Tab mode cycling / Esc interrupt
- [x] Ctrl+C behavior
- [x] Aggressive resize reflow
- [x] Scrollback usable during/after output (detailed characterization of what
      history holds under the TUI deferred to S-04/S-07, where the transcript
      and scrollback-cap work make it load-bearing)
- [x] Clean exit + relaunch; no orphaned processes
