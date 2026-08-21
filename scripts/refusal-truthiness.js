// #440 + #650 — the net under `shared/ipc/refusal.ts`: A REFUSAL IS NOT AN
// ANSWER, and every renderer call site has to say so before it uses one.
//
// Since #346 the IPC broker refuses a capability-denied `invoke` by RESOLVING
// an `IpcRefusal` object (`{__ipcRefused: true, channel, reason}`) instead of
// throwing. That was the right call — a throw reaches third-party code as an
// unhandled rejection — but it left the brand loose in the renderer, where it
// gets misread in two opposite ways.
//
//   THE SILENT ONE (#440). An object is truthy:
//
//       if (await window.switchboard.sessions.isDirectory(p)) …
//
//   A caller told "you may not do that" reads "yes", and the branch that
//   exists to handle "no" never runs. Wrong way, in silence, no log line
//   anywhere. #439 found the first (`lib/composer.ts`, where a refusal
//   suppressed the terminal fallback and silently reinstated the #154 defect)
//   and pinned it with `=== true`; #440 swept the other nineteen.
//
//   THE LOUD ONE (#650). The same object used as the ANSWER:
//
//       events.list().then((l) => setEvents(l as EventDto[]))
//
//   `l.map` on the next render is `l.map is not a function`, inside a `.then`
//   nobody catches — an unhandled rejection, or a dead component tree. Where
//   the site reads a field instead of a method it is quieter but no better:
//   `status.files` off the brand is `undefined`, and the pane renders as if
//   git had answered. Two of these wore an `as` CAST (`as EventDto[]`,
//   `as FeedBlockDto[]`) over a channel declared `Promise<unknown[]>`, which
//   is the brand laundered INTO a typed store under a promise it cannot keep.
//
// Loud is better than silent. Neither is FAIL-OPEN, and fail-open is a hard
// constraint (PHILOSOPHY §3, litmus #3): our breakage never blocks a session.
// So the rule this file enforces is one rule for both classes —
//
//     LAUNDER A BROKERED ANSWER BEFORE YOU USE IT, IN ANY WAY AT ALL.
//
// — and the degraded value is the site's own already-written "nothing came
// back" path: an empty list, a `null` that means "we do not know", a state
// left on the default it mounted with.
//
// WHY A SCANNER AND NOT A LINT RULE OR A TYPE.
//
//   * NOT `no-restricted-syntax`. That rule is an esquery selector over one
//     node, and the defect is a two-node fact: a VALUE that came from the
//     bridge, reaching a BOOLEAN position. A selector can express "if (await
//     …)" and would then flag `if (await mainTook(…))`, which is correct code,
//     while missing `const r = await bridge.x(); if (r)` entirely. That matters
//     more than it sounds: NOT ONE of the nineteen real sites was
//     `if (await bridge.x())` — ten separated the two nodes by a `.then`
//     callback, five by a statement, four handed the answer to a React setter
//     point-free. The repo's other custom rules (raw hex, `ipcMain`, monaco
//     imports) are all genuinely one-node facts, which is why they fit there
//     and this does not.
//
//   * NOT the type system — and #628 is what makes that a finding rather than
//     an excuse. `src/` is now on `recommendedTypeChecked`, so a type-AWARE
//     rule is available here for the first time, and it still does not reach
//     this. Two reasons, both structural:
//
//       - The declared types say the defect is impossible. `isDirectory` is
//         `Promise<boolean>`, so `if (await bridge.isDirectory(p))` is a plain
//         boolean test that no rule has grounds to object to. Making it
//         objectionable means widening ~60 preload signatures to
//         `| IpcRefusal` — which #346 considered and declined IN WRITING: the
//         first-party renderer holds every capability, so its declared types
//         are exact, and the obligation belongs where a refusal can land.
//       - Even widened, TypeScript truthiness-tests a union happily. The only
//         rule that would object is `strict-boolean-expressions`, which is in
//         no preset (not even `strictTypeChecked`) and would have to be turned
//         on by hand — whereupon it fires on every `if (folder)` in the tree,
//         refusal or not, because `string | null` is not a boolean either.
//         That is a repo-wide sweep that still cannot tell a refusal from a
//         path.
//
// So: parse the renderer, find the bridge calls, follow their results one hop,
// and fail if any of them is READ — as a boolean (`booleanPositionOf`) or as a
// value (`valuePositionOf`) — before going through a launderer. A hop that
// cannot be followed at all is its own finding (`unfollowable-then`) rather
// than a silent pass. One hop is deliberate; see WHAT THIS DOES NOT SEE.
//
// THE FIX AT A CALL SITE is never "add a cast" — a cast is the defect, not the
// remedy. It is one of:
//
//     took(result)          — `=== true`, for the boolean channels
//     answered(result)      — the handler's answer, or `undefined` if refused
//     result === true/false — an explicit comparison, where the two non-answers
//                             must be told apart (App.tsx's `decidePermission`)
//
// …followed by whatever this site already does with "nothing came back":
//
//     setEvents(answered(l) ?? [])                  — an empty list
//     const p = answered(raw); if (!p) return;      — leave the state alone
//     answered(gs)?.map(…) ?? null                  — where `null` means "we do
//                                                     not know" and `[]` would
//                                                     mean "there are none"
//
// That last one is not a stylistic choice. `SessionGrid`'s layout restore
// prunes persisted records against a list of known cards; degrading a refusal
// to `[]` there would delete every pin, policy and draft in the app. WHICH
// empty value is right is a per-site judgement — that there must BE one is not.
//
// The launderers live in `src/shared/ipc/refusal.ts` next to the contract.
// Once a value has been through one, this scanner stops tracking it, because
// it is no longer a value that can be a refusal.
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
 * The same peel, upwards: the outermost wrapper this node is buried in.
 * `strip` finds the value inside `x as T`; this finds the `x as T` around it,
 * which is what tells you what the value is actually being HANDED TO.
 */
function unwrapped(node) {
  let e = node;
  while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isNonNullExpression(e.parent) ||
         ts.isAsExpression(e.parent) || ts.isTypeAssertionExpression(e.parent) ||
         ts.isSatisfiesExpression(e.parent))) {
    e = e.parent;
  }
  return e;
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
 * read as an answer, silently. Four of the real sites wore exactly that shape.
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
 * The VALUE position this node sits in, or `null` if it is not read as one
 * (#650).
 *
 * The sibling of `booleanPositionOf`, and the other half of the same defect.
 * #440 swept the SILENT direction — a refusal read as a yes. What it left
 * behind, and named in its own blind-spot list, was the LOUD direction: a
 * refusal used as the ANSWER. `list.map(…)` on the brand throws `list.map is
 * not a function`; `status.staged` reads `undefined`; `setEvents(l as
 * EventDto[])` launders the brand straight into a typed store under a cast
 * that says it cannot be there.
 *
 * Loud is better than silent, but it is still not fail-open, and fail-open is
 * a hard constraint (PHILOSOPHY §3): our breakage never blocks a session. A
 * `TypeError` inside a `.then` on the session-list refresh is an unhandled
 * rejection; inside a render or a click handler it takes the component tree
 * with it. So a brokered answer must be laundered BEFORE it is used at all —
 * `answered(x) ?? <the empty/inert answer>` — and this reports every first
 * read that is not.
 *
 * COMPARISONS ARE NOT REPORTED (`r === null`, `typeof r`, `r === true`).
 * A comparison cannot itself misbehave on a refusal, and whatever the code
 * does with `r` afterwards is a read this catches on its own. Reporting them
 * too would fire twice on one defect and make the explicit-comparison escape
 * hatch that `booleanPositionOf`'s doc-comment recommends unusable.
 */
function valuePositionOf(node) {
  const p = node.parent;
  if (!p) return null;
  if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p)) {
    // A cast does not make the brand go away — `l as EventDto[]` is the shape
    // this exists to catch — so peel it and judge what the cast is handed to.
    return valuePositionOf(p);
  }
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === node) {
    // `list.map`, `status.staged`, `r?.ok` — `?.` included on purpose: it
    // answers `undefined` for a refusal, which is the "reads undefined off the
    // brand" half of the defect rather than a guard against it.
    return 'property-read';
  }
  if (ts.isCallExpression(p) && p.expression === node) return 'called';
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(node)) {
    // `setEvents(l)`, `enqueue(list)` — the answer handed on unchecked.
    return 'passed-on';
  }
  if (ts.isSpreadElement(p) || ts.isJsxSpreadAttribute(p)) return 'spread';
  if (ts.isForOfStatement(p) && p.expression === node) return 'iterated';
  if (ts.isReturnStatement(p)) return 'returned';
  if (ts.isArrowFunction(p) && p.body === node) return 'returned';
  if (ts.isJsxExpression(p)) return 'rendered';
  if (ts.isTemplateSpan(p) && p.expression === node) return 'stringified';
  if (ts.isPropertyAssignment(p) && p.initializer === node) return 'stored';
  if (ts.isShorthandPropertyAssignment(p)) return 'stored';
  if (ts.isArrayLiteralExpression(p)) return 'stored';
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      p.right === node) {
    return 'assigned';
  }
  // `prev ?? s` — the RIGHT of `??` is the value that gets used when the left
  // is missing, which is the opposite side from `booleanPositionOf`'s
  // `nullish` and just as much a way for the brand to become the answer.
  // Same for either arm of a ternary.
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      p.right === node) {
    return 'stored';
  }
  if (ts.isConditionalExpression(p) && (p.whenTrue === node || p.whenFalse === node)) return 'stored';
  // `const {hits} = await bridge.search()` — the blind spot named in WHAT THIS
  // DOES NOT SEE. A plain `const b = a` rename is followed instead (null here),
  // but a destructuring pattern reads properties off the brand and cannot be.
  if (ts.isVariableDeclaration(p) && p.initializer === node) {
    return ts.isIdentifier(p.name) ? null : 'destructured';
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
    // `Promise.resolve(bridge.x?.())` — the wrapper `WorkspaceNoticeBanner`
    // uses so an optional-chained call that answers `undefined` is still
    // thenable. It changes nothing about the value, so see through it (#650);
    // without this the whole file read as bridge-free.
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve' &&
        callee.expression.getText(sf) === 'Promise' && e.arguments.length === 1) {
      return isBridgeCall(e.arguments[0]);
    }
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
  //
  // NOT scope-aware: an inner binding that reuses the name is followed as if it
  // were the tracked one, so a shadowed `f` in a nested callback can be reported
  // when the outer `f` was laundered correctly. That direction is deliberate —
  // a false positive costs a rename, a false negative costs the defect — and
  // nothing in this tree currently trips it.
  const trackBinding = (name, scope, seen = new Set()) => {
    if (!scope || seen.has(name)) return;
    seen.add(name);
    (function walk(node) {
      if (ts.isIdentifier(node) && node.text === name &&
          !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
          !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
          !(ts.isBindingElement(node.parent) && node.parent.name === node)) {
        const pos = booleanPositionOf(node);
        if (pos) report(node, pos, guardOf(node));
        // …and the other half of the same defect: read as a VALUE without
        // being laundered first (#650). Checked only when the boolean test did
        // not fire, so one site never reports twice.
        else if (!isLaundered(node)) {
          const vpos = valuePositionOf(node);
          if (vpos) report(node, vpos, guardOf(node));
        }
        // `const b = answer;` — the trail continues under the new name. #440's
        // OWN fixes introduced this shape (`const record = answered(answer)`),
        // and without this rule deleting the launderer left the scanner green:
        // the boolean read is on the second name, not the tracked one.
        //
        // The rename is looked for OUTSIDE the wrappers (#650): `const next = s
        // as GitStatusDto` is a rename wearing a cast, and reading `node.parent`
        // literally found the `as` and ended the trail there — which is how
        // `DiffPane.tsx`'s `git.status()` answer, one of the two casts this
        // item was filed to fix, was invisible to the first version of this.
        const decl = unwrapped(node).parent;
        if (ts.isVariableDeclaration(decl) && decl.initializer &&
            strip(decl.initializer) === node && ts.isIdentifier(decl.name)) {
          trackBinding(decl.name.text, scope, seen);
        }
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
  /** is this node an ARGUMENT of `took` / `answered` / `isIpcRefusal`? */
  const isLaundered = (node) => {
    const outer = unwrapped(node);
    const p = outer.parent;
    return (
      !!p && ts.isCallExpression(p) && LAUNDERERS.includes(p.expression.getText(sf)) &&
      p.arguments.includes(outer)
    );
  };

  (function pass2(node) {
    // `await bridge.x()` used directly as a boolean
    if (ts.isAwaitExpression(node) && isBridgeCall(node.expression) && !isLaundered(node)) {
      const pos = booleanPositionOf(node) ?? valuePositionOf(node);
      if (pos) report(node, pos, guardOf(node));
    }
    // `const r = await bridge.x()` — then every boolean read of `r`
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        ts.isAwaitExpression(strip(node.initializer)) &&
        isBridgeCall(strip(node.initializer).expression)) {
      trackBinding(node.name.text, enclosingBody(node));
    }
    // `took(bridge.x())` — a laundered result with the `await` FORGOTTEN. Both
    // helpers take the resolved value, so a Promise means `took` is a permanent
    // silent `false` and `answered` hands the Promise itself straight on. The
    // signature cannot catch it (`took` takes `unknown` on purpose, so it can
    // judge junk), and it looks exactly like the correct code, so it is caught
    // here instead.
    if (ts.isCallExpression(node) && LAUNDERERS.includes(node.expression.getText(sf))) {
      for (const arg of node.arguments) {
        if (isBridgeCall(arg)) report(arg, 'un-awaited', guardOf(node));
      }
    }
    // `bridge.x().then(cb)` — every boolean read of the value `cb` receives
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'then' && isBridgeCall(node.expression.expression)) {
      const cb = node.arguments[0];
      const inline = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb));
      const p0 = inline ? cb.parameters[0] : undefined;
      if (inline && !p0) {
        // `.then(() => …)` discards the answer. Nothing to misread.
      } else if (inline && ts.isIdentifier(p0.name)) {
        trackBinding(p0.name.text, cb.body);
      } else {
        // POINT-FREE (`.then(setAutoTrust)`) or a destructured parameter
        // (`.then(({hits}) => …)`). Neither can be followed, and the point-free
        // form is where four of #440's real sites hid: the raw answer goes
        // straight into a React setter, so a refusal becomes the state and the
        // next render reads a chip, a length or a `.map` off the brand. Report
        // the SHAPE — the fix is to launder before handing it on.
        report(cb ?? node, 'unfollowable-then', guardOf(node));
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
    `[refusal-truthiness] ${offenders.length} unlaundered bridge result(s) —`,
    '  a refused call RESOLVES an IpcRefusal object (#346). Read as a boolean it',
    '  is truthy and lies (#440); read as a value it throws or answers undefined',
    '  off a field it does not have (#650). Neither is fail-open.',
    '  Launder it AT THE BOUNDARY, then use the site\'s own empty answer:',
    '    took(x)                     — the boolean channels',
    '    answered(x) ?? []           — a list',
    '    const v = answered(x); if (!v) return;   — a record',
    '    x === true / x === false    — where the two non-answers differ',
    '  See src/shared/ipc/refusal.ts.',
    ...offenders.map((o) => `  ${o.file}:${o.line}  [${o.kind}]  ${o.source}`),
  ];
}

module.exports = {
  PRELOAD,
  RENDERER,
  LAUNDERERS,
  invokeBackedMethods,
  booleanPositionOf,
  valuePositionOf,
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
//   * A result carried further than one hop THROUGH A CALL. Handing it to one
//     is now REPORTED (`passed-on`), and so is storing it (`stored`,
//     `assigned`), returning it (`returned`) and rendering it (`rendered`) —
//     but what the callee then does with it is not followed. A plain rename,
//     `const b = answer` (or `const b = answer as T`, which #650 added), IS
//     followed: #440's own fixes wear that shape, and without following it
//     deleting a launderer left this green. Anything further needs a type
//     checker and a symbol table; this is a net for the shape the defect
//     actually wears, which in every real site so far was the value's FIRST
//     read.
//   * A bridge method reached through an INJECTED DEPENDENCY rather than the
//     global. Nothing static can tell that an injected closure calls the
//     bridge, so each of these launders CENTRALLY — in the one place that can
//     see the value — and each is covered by unit tests instead of by this
//     scanner. There are five:
//       - `lib/markdown-links.ts` takes `openExternal` typed `Promise<unknown>`
//         ON PURPOSE, which forces its call site to narrow. The best guard of
//         the five, where the signature is ours to choose.
//       - `lib/latest-wins.ts` takes a whole FETCH closure (#440).
//       - `lib/terminal-shadow.ts` takes `read: () => pty.snapshot(id)` (#650):
//         a refusal replayed into the shadow terminal is a 0×0 screen that
//         finds nothing in a scrollback nobody was allowed to read.
//       - `lib/terminal-attach.ts` takes `attach: () => pty.attach(id)` (#650):
//         a refusal has no `epoch`, and the epoch test then drops every chunk
//         for ever — #117's failure mode through the path written to avoid it.
//       - `components/DocumentViewer.tsx`'s `files()` accessor (#650): a
//         refusal used to degrade to `{ok: undefined}` = "unreadable", which
//         was fail-safe by accident; it now says so, with the same `UNREADABLE`
//         value the no-bridge branch uses.
//   * Destructuring at the boundary. Both forms are now reported: the callback
//     one (`.then(({binding}) => …)`) as `unfollowable-then`, the statement one
//     (`const {hits} = await bridge.search()`) as `destructured` (#650).
//     Nothing in the tree writes either today.
//   * A `.then`/`.catch` chained BEFORE the value is read
//     (`await bridge.x().catch(() => null)`). The chain is not a bridge call, so
//     nothing is tracked — but the FIRST `.then` in the chain is followed, and
//     that is where the value is actually read. SessionGrid's
//     `groups.list().then(gs => …).catch(() => null)` used to rely on the
//     `.catch` to turn a refusal's TypeError into `null`; #650 laundered it in
//     the `.then` instead, so the `.catch` is back to catching real failures.
//   * `src/main`, `src/preload` and `src/shared`. None of them calls `invoke`;
//     the broker is the thing answering, not asking.
//
//   * COMPARISONS, deliberately: `r === null`, `typeof r`, `r === true`. A
//     comparison cannot itself misbehave on the brand, and whatever the code
//     does with `r` afterwards is a read this catches on its own — reporting
//     the comparison too would fire twice on one defect and would outlaw the
//     explicit `=== true` / `=== false` form the contract recommends.
//
// A NOTE ON THE ASYMMETRY between point-free and inline `.then`, because it is
// a choice and not an oversight. `.then(setEvents)` is reported
// (`unfollowable-then`: the uses cannot be seen, so unknown is treated as
// unsafe) while `.then((l) => setEvents(answered(l) ?? []))` is not (inline —
// the uses CAN be seen, and every one of them goes through a launderer). The
// rule is "judge what you can see, report what you cannot", and it lands on
// the safe side of both.
