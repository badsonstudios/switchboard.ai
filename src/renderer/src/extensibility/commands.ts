// Flattening contributed command sets into the one array `dispatch`, the
// palette and `bindingFor` all read.
//
// Pure, and deliberately not inline in App: the flattening has two rules that
// only matter once there is more than one contributor, and both were invisible
// while `App.tsx` simply called `buildCommands(deps)`.
import { Command } from '../lib/commands';
import { CommandDeps } from '../lib/command-set';
import { RendererRegistry } from '../bootstrap';

export interface BuildProblem {
  /** the contribution that misbehaved */
  setId: string;
  kind: 'threw' | 'duplicate-id' | 'duplicate-binding';
  detail: string;
}

/**
 * Build every registered command set.
 *
 * FAIL-OPEN (the §5.23 seam rule, and the reason this isn't a bare flatMap):
 * a contributor that throws is skipped, not fatal. This runs during App's
 * render, so an uncaught throw here unmounts the tree and blanks the window —
 * which has already happened once for a different reason (the E9-02 palette
 * effect), and is exactly what the eslint no-expression-bodied-useEffect rule
 * exists to prevent. `dispatch` already treats a broken command that way; a
 * broken command SET now gets the same treatment.
 *
 * PRECEDENCE: the registry dedupes contribution ids, not the commands inside
 * them. Sets flatten in registration order and both `dispatch` and
 * `bindingFor` take the first match, so first registration wins — reported,
 * because a silently shadowed keybinding is a bug nobody can see.
 */
export function buildContributedCommands(
  registry: RendererRegistry,
  deps: CommandDeps,
  onProblem: (p: BuildProblem) => void = defaultReport
): Command[] {
  const out: Command[] = [];
  const byId = new Map<string, string>(); // command id -> set that claimed it
  const byBinding = new Map<string, string>(); // accelerator -> set that claimed it

  for (const set of registry.list('command-set')) {
    const setId = set.manifest.id;
    let built: Command[];
    try {
      built = set.build(deps);
    } catch (err) {
      onProblem({ setId, kind: 'threw', detail: String(err) });
      continue; // one broken contributor must not cost the user every command
    }
    for (const command of built) {
      const claimedBy = byId.get(command.id);
      if (claimedBy) {
        onProblem({
          setId,
          kind: 'duplicate-id',
          detail: `command "${command.id}" is already contributed by "${claimedBy}"`,
        });
        continue; // first registration wins
      }
      if (command.binding) {
        const bindingOwner = byBinding.get(command.binding);
        if (bindingOwner) {
          onProblem({
            setId,
            kind: 'duplicate-binding',
            detail: `binding "${command.binding}" for "${command.id}" is already claimed by "${bindingOwner}"`,
          });
          // the command still ships — it stays reachable from the palette,
          // which is §5.8's invariant: hiding chrome never removes capability
        } else {
          byBinding.set(command.binding, setId);
        }
      }
      byId.set(command.id, setId);
      out.push(command);
    }
  }
  return out;
}

function defaultReport(p: BuildProblem): void {
  console.error(`[commands] ${p.kind} in set "${p.setId}": ${p.detail}`);
}
