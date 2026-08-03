// #176 — a stderr filter for ONE known-benign crash dump, and nothing else.
//
// On Windows, node-pty's `kill()` forks `conpty_console_list_agent.js` to ask
// the OS which processes share the shell's console, and then — synchronously,
// on the very next line — destroys the pseudoconsole. Booting the forked agent
// takes a few hundred ms, so by the time it runs, the console it was asked to
// attach to is gone: `AttachConsole` fails, the agent dies with an uncaught
// exception, and Node dumps a nine-frame stack trace onto the stderr it
// inherited from us. node-pty expects this — the caller has a 5 s timeout that
// falls back to the shell PID — so the kill still completes correctly. Proven
// locally: forking the agent against a LIVE pty pid returns the process list;
// forking it against the same pid after `kill()` produces exactly this trace.
//
// The dump is therefore pure noise, but `npm run check:pty` spawns twelve PTYs,
// so a PASSING check printed twelve stack traces and read like a failure.
//
// This filter removes that one dump and nothing else. It is a state machine,
// not a regex sweep: a candidate block is BUFFERED and vetted line by line
// against the shape below, because the dump is written by a DIFFERENT process
// (node-pty forks the agent non-silent, so it shares our child's stderr pipe)
// and a line from the check itself really can land in the middle of one.
//
//     <path>/node-pty/lib/conpty_console_list_agent.js:<line>   <- AGENT_HEADER
//     var consoleProcessList = getConsoleProcessList(shellPid); <- SOURCE_LINE
//                              ^                                <- CARET
//     (blank)
//     Error: AttachConsole failed                               <- ERROR_LINE
//         at Object.<anonymous> (…:13:26)                       <- STACK_FRAME
//     (blank)                                                   <- ends write #1
//     Node.js v24.18.0                                          <- FOOTER, write #2
//
// Until the block is PROVEN — its exact error line plus at least one real V8
// frame — every single line must match a pattern pinned to node-pty's own
// source, and the first deviation writes the whole buffer out verbatim,
// INCLUDING the line that caused it. So nothing a check prints can be lost
// before that point.
//
// The footer is OPTIONAL after that, and that is not laziness. Node writes a
// fatal dump in two `write()` calls — the trace, then `Node.js v…` — and
// `check:pty` kills twelve PTYs at once, so on a loaded machine twelve agents
// braid their writes and the footers arrive detached and batched (observed
// verbatim: traceA 1-15, traceB 1-15, footerA, footerB). A proven block is
// therefore closed by the first line that is not part of it — that line is put
// straight back through the normal path, so it still prints — and its orphaned
// footer is swallowed later only while a proven block is still owed one.
//
// What that costs, stated plainly so nobody widens it by accident: BETWEEN the
// error line and the blank that ends write #1, a line from another writer that
// is itself shaped exactly like a V8 frame (`    at x (f.js:1:1)`) is
// indistinguishable from a real one and is dropped with the block. That window
// is at most MAX_BLOCK_LINES long, closes at the first blank line, and costs a
// stack frame — not a message. Everything else is bounded the same way: exactly
// one blank line is absorbed, and `owedFooters` is cleared the moment any
// unrelated line goes through, so a legitimate `Node.js v…` printed later in
// the run is never mistaken for an orphan.
//
// One deliberate trade-off, fail-safe: stderr is line-buffered here, and a
// trailing partial line is only released when the stream ends. Diagnostics end
// in newlines, so this only affects things like spinners — on stderr, from a
// headless check script.
'use strict';

/** the line that opens a candidate block (a path — so no spaces before it) */
const AGENT_HEADER = /^\S*node-pty[\\/]lib[\\/]conpty_console_list_agent\.js:\d+$/;
/** node-pty's own source line, echoed by Node under the header */
const SOURCE_LINE = /getConsoleProcessList\(/;
/** the `^` pointer Node prints under the offending source line */
const CARET = /^\s*\^+\s*$/;
/** the ONLY error this filter is allowed to swallow */
const ERROR_LINE = /^Error: AttachConsole failed$/;
/** a real V8 frame always ends in :line:col — `    at least 3 ptys leaked` does not */
const STACK_FRAME = /^ {4}at \S.*:\d+:\d+\)?$/;
/** Node's `Node.js v24.18.0` footer closes the dump */
const FOOTER = /^Node\.js v[\d.]+$/;
/** a real dump is ~16 lines; well past that, stop trusting the match */
const MAX_BLOCK_LINES = 40;
/** never hoard more than this without a newline (a child spewing binary) */
const MAX_PENDING = 1024 * 1024;

/**
 * @param {(s: string) => void} write sink for everything that survives.
 * @returns {{ push(chunk: string): void, end(): void, readonly suppressed: number,
 *             readonly swallowedFooters: number }}
 */
function createAttachConsoleFilter(write) {
  /** bytes received since the last newline */
  let pending = '';
  /** the candidate block being vetted, or null when passing lines straight through */
  let block = null;
  /** proven blocks whose `Node.js v…` footer was written separately and is still owed */
  let owedFooters = 0;
  let suppressed = 0;
  let swallowedFooters = 0;

  /** give up on the candidate: everything buffered goes out untouched */
  function abort() {
    const lines = block.lines;
    block = null;
    write(lines.map((l) => l + '\n').join(''));
  }

  /** the candidate matched all the way through — drop it */
  function accept(withFooter) {
    block = null;
    suppressed++;
    if (!withFooter) owedFooters++;
  }

  function feedLine(raw) {
    // match against a \r-stripped copy; emit the raw line, so pass-through is
    // byte-for-byte identical to what the child wrote
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (block === null) {
      if (AGENT_HEADER.test(l)) {
        block = { lines: [raw], phase: 'source', frames: 0 };
      } else if (owedFooters > 0 && FOOTER.test(l)) {
        owedFooters--; // the detached tail of a dump already dropped
        swallowedFooters++;
      } else {
        // Real output means the braided burst is over, so stop expecting
        // orphans. Without this the counter never expires and a legitimate
        // `Node.js v…` printed much later in the run gets eaten. A BLANK line
        // is not real output — one stray blank between the braided traces and
        // their batched footers is common, and resetting on it was observed
        // letting a footer through on an otherwise clean run.
        if (l !== '') owedFooters = 0;
        write(raw + '\n');
      }
      return;
    }

    block.lines.push(raw);
    if (block.lines.length > MAX_BLOCK_LINES) return abort();

    switch (block.phase) {
      case 'source':
        if (!SOURCE_LINE.test(l)) return abort();
        block.phase = 'caret';
        return;
      case 'caret':
        if (!CARET.test(l)) return abort();
        block.phase = 'error';
        return;
      case 'error':
        if (l === '') return; // the blank between the caret and the message
        if (!ERROR_LINE.test(l)) return abort(); // a DIFFERENT error — keep it
        block.phase = 'stack';
        return;
      case 'stack':
        if (STACK_FRAME.test(l)) {
          block.frames++;
          return;
        }
        // nothing below is proof on its own: without a real frame this is not
        // the dump, whatever else it looks like
        if (block.frames === 0) return abort();
        // the blank that ends write #1 closes the trace. Only ONE is absorbed,
        // so a later blank from another writer survives.
        if (l === '') {
          block.phase = 'footer';
          return;
        }
        if (FOOTER.test(l)) return accept(true); // no trailing blank on this Node
        return closeProven(raw);
      default: // 'footer' — the trace is complete; only its own footer may follow
        if (FOOTER.test(l)) return accept(true);
        return closeProven(raw);
    }
  }

  /**
   * A proven block met a line that is not part of it. Drop the block, and put
   * the intruder straight back through the pass-through path — it is not ours
   * to eat. `block` is already null by then, so this recurses exactly once.
   */
  function closeProven(raw) {
    block.lines.pop();
    accept(false);
    return feedLine(raw);
  }

  return {
    push(chunk) {
      pending += chunk;
      let i;
      while ((i = pending.indexOf('\n')) !== -1) {
        feedLine(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
      if (pending.length > MAX_PENDING) {
        if (block !== null) abort();
        write(pending);
        pending = '';
      }
    },
    end() {
      // same rule as mid-stream: proven blocks go, unproven ones get printed
      if (block !== null) {
        if (block.frames > 0 && (block.phase === 'stack' || block.phase === 'footer')) {
          accept(true);
        } else {
          abort();
        }
      }
      if (pending !== '') {
        write(pending); // no trailing newline: the child did not write one
        pending = '';
      }
    },
    get suppressed() {
      return suppressed;
    },
    /** orphan `Node.js v…` lines dropped alongside them, reported separately */
    get swallowedFooters() {
      return swallowedFooters;
    },
  };
}

module.exports = { createAttachConsoleFilter };
