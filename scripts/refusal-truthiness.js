// #440 — the net under `shared/ipc/refusal.ts`: a REFUSAL IS TRUTHY.
//
// Since #346 the IPC broker refuses a capability-denied `invoke` by RESOLVING
// an `IpcRefusal` object (`{__ipcRefused: true, channel, reason}`) instead of
// throwing. That was the right call — a throw reaches third-party code as an
// unhandled rejection — but it opened a quieter hole on the other side:
//
//     if (await window.switchboard.sessions.isDirectory(p)) …
//
// An object is truthy. So a caller that was told "you may not do that" reads
// "yes", and the branch that exists to handle "no" never runs. It fails the
// wrong way, in silence, with no log line anywhere. #439 found the first one
// (`lib/composer.ts`, where a refusal suppressed the terminal fallback and
// silently reinstated the #154 defect) and pinned it with `=== true`; #440
// swept the rest. This is what stops the next one being written.
//
// WHY A SCANNER AND NOT A LINT RULE OR A TYPE.
//
//   * NOT `no-restricted-syntax`. That rule is an esquery selector over one
//     node, and the defect is a two-node fact: a VALUE that came from the
//     bridge, reaching a BOOLEAN position. A selector can express "if (await
//     …)" and would then flag `if (await mainTook(…))`, which is correct code,
//     while missing `const r = await bridge.x(); if (r)` entirely — the shape
//     eight of the fifteen real sites actually wore. The repo's other custom
//     rules (raw hex, `ipcMain`, monaco imports) are all genuinely one-node
//     facts, which is why they fit there and this does not.
//
//   * NOT the type system. Making a refusal impossible to miss means widening
//     ~60 preload signatures to `| IpcRefusal`, which #346 considered and
//     declined in writing — the first-party renderer holds every capability, so
//     its declared types are exact and the obligation belongs where a refusal
//     can actually land. Even widened, TypeScript is happy to truthiness-test a
//     union; only `@typescript-eslint/strict-boolean-expressions` would object,
//     and that rule needs the type-checked preset, which in this repo covers
//     `e2e/` alone (#245). Putting `src/` on it to reach one rule is a change
//     an order of magnitude larger than the defect.
//
// So: parse the renderer, find the bridge calls, follow their results one hop,
// and fail if any of them is read as a boolean. One hop is deliberate — see
// WHAT THIS DOES NOT SEE at the bottom.
//
// THE FIX AT A CALL SITE is never "add a cast". It is one of:
//
//     took(result)          — `=== true`, for the boolean channels
//     answered(result)      — the handler's answer, or `undefined` if refused
//     result === true/false — an explicit comparison, where the two non-answers
//                             must be told apart (App.tsx's `decidePermission`)
//
// The first two live in `src/shared/ipc/refusal.ts` next to the contract. Both
// LAUNDER the value: once it has been through one, this scanner stops tracking
// it, because it is no longer a value that can be a refusal.
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

/** Where the bridge is declared, and the tree that consumes it. */
const PRELOAD = 'src/preload/index.ts';
const RENDERER = 'src/renderer';

/** The laundering helpers. A result that goes through one is no longer ours. */
const LAUNDERERS = ['took', 'answered', 'isIpcRefusal'];

const parse = (fileName, source) =>
  ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /* setParentNodes */ true,
    /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Peel the wrappers that do not change what a value IS. */
function strip(node) {
  let e = node;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) ||
        ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) ||
        ts.isSatisfiesExpression(e)) {
      e = e.expression;
      continue;
    }
    return e;
  }
}

/**
 * Every preload method backed by `ipcRenderer.invoke` — i.e. every method that
 * goes through the broker and can therefore be answered with a refusal.
 *
 * READ OFF THE PRELOAD, never a hand-kept list: a hand-kept list is a list that
 * is one PR out of date the first time somebody adds a channel, and the whole
 * point of this file is to be right about a surface that grows every week.
 *
 * `ipcRenderer.on`/`send` methods are deliberately NOT here. The broker guards
 * `handle`/`invoke` and nothing else, so a subscription cannot be refused —
 * and `const off = bridge.x.onY(…)` is a legitimate truthiness test of an
 * unsubscribe function that this must not complain about.
 */
function invokeBackedMethods(preloadSource) {
  const sf = parse(PRELOAD, preloadSource);
  const names = new Set();
  (function walk(node) {
    if (ts.isCallExpression(node) && /^ipcRenderer\??\.invoke$/.test(node.expression.getText(sf))) {
      // the nearest enclosing named binding is the method it is the body of
      let p = node.parent;
      while (p && !ts.isPropertyAssignment(p) && !ts.isMethodDeclaration(p) &&
             !ts.isVariableDeclaration(p) && !ts.isSourceFile(p)) {
        p = p.parent;
      }
      if (p && p.name && ts.isIdentifier(p.name)) names.add(p.name.text);
    }
    ts.forEachChild(node, walk);
  })(sf);
  return names;
}

/**
 * The boolean position this node sits in, or `null` if it is not in one.
 *
 * `??` counts. It is not truthiness — a refusal is neither null nor undefined,
 * so it sails straight through `list ?? []` and lands in the state that was
 * supposed to hold the answer — but it is the identical defect: a non-answer
 * read as an answer, silently. Three of the real sites wore exactly that shape.
 */
function booleanPositionOf(node) {
  const p = node.parent;
  if (!p) return null;
  if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) {
    return booleanPositionOf(p);
  }
  if (ts.isIfStatement(p) && p.expression === node) return 'if-test';
  if (ts.isWhileStatement(p) && p.expression === node) return 'while-test';
  if (ts.isDoStatement(p) && p.expression === node) return 'do-test';
  if (ts.isForStatement(p) && p.condition === node) return 'for-test';
  if (ts.isConditionalExpression(p) && p.condition === node) return 'ternary-test';
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return 'negation';
  if (ts.isBinaryExpression(p)) {
    const k = p.operatorToken.kind;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken) return 'logical';
    if (k === ts.SyntaxKind.QuestionQuestionToken && p.left === node) return 'nullish';
  }
  if (ts.isCallExpression(p) && p.expression.getText() === 'Boolean' && p.arguments.includes(node)) {
    return 'Boolean()';
  }
  return null;
}

/**
 * Every place in ONE file where a brokered bridge result is read as a boolean.
 *
 * @param {string} fileName  used for the report and to pick TS vs TSX
 * @param {string} source
 * @param {Set<string>} invokeMethods  from `invokeBackedMethods`
 */
function scanSource(fileName, source, invokeMethods) {
  const sf = parse(fileName, source);
  const findings = [];

  // ── pass 1: what names in this file ARE the bridge ──────────────────────
  //
  // `window.switchboard` itself, plus any local bound to a chain rooted there:
  // App.tsx's `const bridge = window.switchboard ?? {…}` fail-open shim, and
  // SessionGrid's `const rulesApi = window.switchboard?.rules as …` namespace
  // guards. Bound by the SHAPE of the initializer, not by its text: a closure
  // that merely MENTIONS `window.switchboard` somewhere inside is not an alias
  // of it, and reading it as one made `TerminalPane`'s own shadow-search read
  // as a bridge call (its `read:` callback holds a `pty.snapshot`).
  const aliases = new Set();
  const rootsAtBridge = (node) => {
    const e = strip(node);
    if (ts.isPropertyAccessExpression(e) && e.name.text === 'switchboard') {
      const base = strip(e.expression);
      if (ts.isIdentifier(base) && base.text === 'window') return true;
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isCallExpression(e)) {
      return rootsAtBridge(e.expression);
    }
    // `window.switchboard ?? <shim>` — the shim wears the bridge's type and its
    // methods are the same promises, so the whole expression is the bridge.
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return rootsAtBridge(e.left);
    }
    if (ts.isIdentifier(e)) return aliases.has(e.text);
    return false;
  };
  (function pass1(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) &&
        rootsAtBridge(node.initializer)) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, pass1);
  })(sf);

  /** a call of an invoke-backed method on the bridge (or one of its aliases) */
  const isBridgeCall = (node) => {
    const e = strip(node);
    if (!ts.isCallExpression(e)) return false;
    const callee = strip(e.expression);
    if (!ts.isPropertyAccessExpression(callee) || !invokeMethods.has(callee.name.text)) return false;
    return rootsAtBridge(callee.expression);
  };

  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const report = (node, kind, expr) => {
    findings.push({
      file: fileName,
      line: at(node),
      kind,
      /** the whole guard, so the report reads without opening the file */
      source: (expr ?? node).getText(sf).replace(/\s+/g, ' ').slice(0, 140),
    });
  };
  /** the smallest enclosing guard, for a report a human can act on */
  const guardOf = (node) => {
    let n = node;
    while (n.parent && !ts.isStatement(n.parent) && !ts.isJsxExpression(n.parent) &&
           !ts.isArrowFunction(n.parent) && !ts.isFunctionExpression(n.parent)) {
      n = n.parent;
    }
    return n;
  };

  // ── pass 2: bridge results, followed one hop ────────────────────────────
  const trackBinding = (name, scope) => {
    if (!scope) return;
    (function walk(node) {
      // a shadowing re-declaration ends the trail; deliberately not modelled —
      // nothing in this tree does it, and guessing wrong would mean a MISS
      if (ts.isIdentifier(node) && node.text === name &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
          !(ts.isBindingElement(node.parent) && node.parent.name === node)) {
        const pos = booleanPositionOf(node);
        if (pos) report(node, pos, guardOf(node));
      }
      ts.forEachChild(node, walk);
    })(scope);
  };
  /** the nearest block/expression a binding is visible in — good enough here */
  const enclosingBody = (node) => {
    let p = node.parent;
    while (p && !ts.isBlock(p) && !ts.isSourceFile(p)) p = p.parent;
    return p;
  };
  /** a call of `took` / `answered` / `isIpcRefusal` — the value is laundered */
  const isLaundered = (node) => {
    const p = strip(node).parent;
    return !!p && ts.isCallExpression(p) && LAUNDERERS.includes(p.expression.getText(sf));
  };

  (function pass2(node) {
    // `await bridge.x()` used directly as a boolean
    if (ts.isAwaitExpression(node) && isBridgeCall(node.expression) && !isLaundered(node)) {
      const pos = booleanPositionOf(node);
      if (pos) report(node, pos, guardOf(node));
    }
    // `const r = await bridge.x()` — then every boolean read of `r`
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isAwaitExpression(strip(node.initializer)) &&
        isBridgeCall(strip(node.initializer).expression)) {
      trackBinding(node.name.text, enclosingBody(node));
    }
    // `bridge.x().then((r) => …)` — then every boolean read of `r`
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'then' && isBridgeCall(node.expression.expression)) {
      const cb = node.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
        const p0 = cb.parameters[0];
        if (p0 && ts.isIdentifier(p0.name)) trackBinding(p0.name.text, cb.body);
      }
    }
    ts.forEachChild(node, pass2);
  })(sf);

  return findings;
}

/** Every `.ts`/`.tsx` under `dir` that is not a test. */
function sourceFiles(dir, root) {
  const out = [];
  (function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // Tests are excluded: a spec is allowed to build a refusal and assert on
      // it, and several do (`markdown-links.test.ts` feeds one straight in).
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  })(dir);
  return out.sort();
}

/** Scan the whole checkout. Returns the offenders and what it looked at. */
function scanTree(root) {
  const invokeMethods = invokeBackedMethods(fs.readFileSync(path.join(root, PRELOAD), 'utf8'));
  const files = sourceFiles(path.join(root, RENDERER), root);
  const offenders = [];
  for (const rel of files) {
    offenders.push(...scanSource(rel, fs.readFileSync(path.join(root, rel), 'utf8'), invokeMethods));
  }
  return { offenders, files, invokeMethods };
}

function formatReport({ offenders, files, invokeMethods }) {
  if (offenders.length === 0) {
    return [
      `[refusal-truthiness] clean — ${files.length} renderer files, ` +
        `${invokeMethods.size} brokered bridge methods`,
    ];
  }
  return [
    `[refusal-truthiness] ${offenders.length} bridge result(s) read as a boolean —`,
    '  a refused call resolves an IpcRefusal OBJECT, which is truthy (#346/#440).',
    '  Launder it: took(x) for the boolean channels, answered(x) otherwise,',
    '  or an explicit x === true / x === false. See src/shared/ipc/refusal.ts.',
    ...offenders.map((o) => `  ${o.file}:${o.line}  [${o.kind}]  ${o.source}`),
  ];
}

module.exports = {
  PRELOAD,
  RENDERER,
  LAUNDERERS,
  invokeBackedMethods,
  booleanPositionOf,
  scanSource,
  sourceFiles,
  scanTree,
  formatReport,
};

if (require.main === module) {
  // Root from __dirname, not cwd — the house pattern (bundle-guard,
  // run-electron-node): run from a subdirectory and cwd finds no src/.
  const result = scanTree(path.join(__dirname, '..'));
  console.error(formatReport(result).join('\n'));
  process.exit(result.offenders.length > 0 ? 1 : 0);
}

// WHAT THIS DOES NOT SEE, stated so nobody mistakes green for proof.
//
//   * A result carried further than one hop — stored on a ref, returned from a
//     helper, put in React state. Following those needs a type checker and a
//     symbol table; this is a net for the shape the defect actually wears,
//     which in all fifteen real sites was the value's FIRST read.
//   * A bridge method reached through an injected dependency rather than the
//     global — `lib/markdown-links.ts` takes `openExternal` as a parameter, so
//     nothing here can tell it from any other function. That file declares the
//     parameter as `Promise<unknown>` ON PURPOSE, which forces its call site to
//     narrow and is the better guard where it is available.
//   * `src/main` and `src/preload`. Neither calls `invoke`; the broker is the
//     thing answering, not asking.
