// Joining what the SESSION has to what the FILES declare (#729).
//
// Two sources, and neither is a superset of the other in every way:
//
//   `mcp_status`  every server the session really has — connectors, plugin
//                 servers, builtins, all sixteen. Needs a LIVE session. Carries
//                 status, version and the tool list, which no file holds.
//                 FROZEN AT SPAWN — see `notLoaded`.
//   the config    only the three file-backed scopes. Works with NO session at
//                 all. Carries the env/header KEY NAMES, the approval state and
//                 the WRITE-SIDE SCOPE, none of which `mcp_status` reports.
//                 Always current, because it is a file read.
//
// So the runtime list is the INVENTORY and the config is the MUTABILITY PROOF.
// A row that no file declares cannot be removed — there is nothing for
// `claude mcp remove` to edit — and #729 asks for that to be VISIBLE rather than
// a button that fails.
//
// ── ONE MATCH FUNCTION, AND THAT IS THE POINT ────────────────────────────────
//
// "Is this row mutable?" and "which config entry backs it?" are THE SAME
// QUESTION, and an earlier draft answered them in two functions with two copies
// of the rule. That is a bug waiting for its first divergence: the row would
// show a Remove button derived from one answer and send a scope derived from the
// other. `matchConfig` answers once; everything else reads its result.
//
// ── WHY THE MATCH IS EXACT, AND ONLY EXACT ───────────────────────────────────
//
// `readInventory` produces exactly three scopes — `project`, `local`, `user`;
// nothing else is reachable from the files. `mcp_status` spells those three the
// same way (measured), so an exact `scope:name` match already covers EVERY
// removable row. There is nothing left for a name-only fallback to catch except
// rows whose scope the files cannot express — and for those, a same-name config
// entry is by construction NOT the definition that produced the row. It is a
// SHADOWED one, and offering Remove for it deletes a definition the user is not
// looking at while the row stays on screen.
//
// A draft of this file had that fallback, reasoning that `builtin`/`dynamic`/
// `skills` "carry no contradiction". Review found the counter-example:
// `enterprise` and `managed` ARE file-backed and outrank user scope, so an org
// policy defining `github` over the user's own `github` produced one runtime row
// with a Remove button wired to the user's copy. `unknown` is worse still — it
// exists precisely because we do not know what the scope is, so it cannot be
// asserted as not-file-backed. The module's own failure direction settles it: a
// missing button, never a button that deletes the wrong thing.
//
// `config.ts` deliberately does not deduplicate across scopes, and showing that
// collision is what the manager is FOR — which is the other reason a name-only
// match was never safe here.
import type { McpRuntimeServer, McpServerWire } from '../../shared/mcp';

/**
 * The config entry that backs each runtime row, or `null` where none does.
 *
 * Parallel to `runtime` by index, so a caller never has to re-derive the
 * pairing. `null` is the common and expected case on a real machine — it is
 * every claude.ai connector, every plugin server and every builtin.
 */
export function matchConfig(
  runtime: readonly McpRuntimeServer[],
  configured: readonly McpServerWire[]
): (McpServerWire | null)[] {
  // Built once rather than per row, so the join stays linear on the
  // sixteen-server machine this exists for.
  const exact = new Map<string, McpServerWire>();
  for (const c of configured) {
    // FIRST WINS on a duplicate `scope:name`. `config.ts` can legitimately
    // produce one (the case-variant `projects` keys #724 is about), and either
    // entry is an equally true answer to "can this be removed" — what must not
    // happen is the pairing changing between renders.
    if (!exact.has(`${c.scope}:${c.name}`)) exact.set(`${c.scope}:${c.name}`, c);
  }
  return runtime.map((r) => exact.get(`${r.scope}:${r.name}`) ?? null);
}

/**
 * The runtime rows, with everything only the config files know folded in.
 *
 * FOUR FACTS FLOW BACKWARDS from the file to the runtime row: whether it can be
 * removed, the SCOPE to remove it with, the env/header key names, and the
 * APPROVAL state. All four come from the one match, which is why this is a
 * single pass rather than a chain of enrichers that could disagree.
 *
 * `readMcpStatus` sets `readOnly: true` on everything and this is the only thing
 * that lowers it — the safe direction, because the failure mode of a missed
 * match is a Remove button that does not appear rather than one that deletes
 * something the CLI does not own.
 *
 * MUTATES NEITHER INPUT. The pane re-runs this whenever either list changes, and
 * a version that edited rows in place made the second run see the first run's
 * output.
 */
export function enrichRuntime(
  runtime: readonly McpRuntimeServer[],
  configured: readonly McpServerWire[]
): McpRuntimeServer[] {
  const matches = matchConfig(runtime, configured);
  return runtime.map((r, i) => {
    const c = matches[i];
    if (!c) return { ...r, readOnly: true, envKeys: [], headerKeys: [] };
    return {
      ...r,
      readOnly: false,
      removeScope: c.scope,
      envKeys: c.envKeys,
      headerKeys: c.headerKeys,
      // APPROVAL COMES FROM THE FILE AND ONLY THE FILE. `mcp_status` has no
      // field for it — it is derived from two LISTS on the project entry
      // (`enabledMcpjsonServers` / `disabledMcpjsonServers`) that `config.ts`
      // reads. Without carrying it across, "waiting for your approval" would
      // stop rendering on the path most sessions are on, and an unapproved
      // `.mcp.json` server would report "not connected" — the symptom instead
      // of the cause, which is the precedence `rowStatus` documents at length.
      approval: c.approval,
    };
  });
}

/**
 * The config entries NO runtime row accounts for — "in your files, but this
 * session has not loaded them".
 *
 * ⚠️ THIS IS NOT AN EDGE CASE, IT IS THE ADD BUTTON. **`mcp_status` is frozen at
 * session start** — measured (`spike/probes/721/probe-mcp-add-live.mjs`,
 * 2026-08-29): a server added with `claude mcp add` while a session ran never
 * appeared in that session's `mcp_status`, across three polls over ten seconds,
 * and a server removed never disappeared from it. The CLI resolves its MCP set
 * once, at spawn, which is exactly why Reconnect exists at all.
 *
 * So a pane that drew ONLY the runtime rows would say "Added github." over a
 * list that did not change, and would answer Remove by leaving the row on screen
 * — flipping it to read-only, because the config entry backing it had just gone.
 * Both read as bugs. Found in review of #729 PR 1, which had shipped exactly
 * that regression against #714.
 *
 * These rows keep the ordinary config rendering — approval state, a working
 * Remove — under a heading saying the session has not picked them up yet.
 */
export function notLoaded(
  runtime: readonly McpRuntimeServer[],
  configured: readonly McpServerWire[]
): McpServerWire[] {
  const seen = new Set(runtime.map((r) => `${r.scope}:${r.name}`));
  // BY NAME AS WELL AS BY SCOPE. A file-backed server the CLI resolved under a
  // scope word the files do not use — an org policy shadowing a user entry — is
  // still loaded, and listing it here as "not loaded" would put a second, wrong
  // row on screen for one server. Under-reporting is the safer direction: a
  // server that IS loaded and goes unlisted here still appears in the runtime
  // list above, so nothing vanishes.
  const byName = new Set(runtime.map((r) => r.name));
  return configured.filter((c) => !seen.has(`${c.scope}:${c.name}`) && !byName.has(c.name));
}
