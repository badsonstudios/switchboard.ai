// What the composer's `/` popup offers for a session (P2-E10-07, §5.17), per
// AI since #1288: the provider's builtins, plus the user's own command and
// skill FILES when the provider can find them (`commandFiles`; Claude's read
// `.claude/`). A provider without that capability offers its builtins alone.
//
// NEVER REJECTS. A scan that throws falls open to the builtins and says so at
// `warn` — the line you grep for after "my commands vanished".
import { errorText } from '../shared/error-text';
import { mergeCommands, type SlashCommand } from '../shared/slash-commands';
import type { ProviderAdapter } from './extensibility/contributions';

export async function slashCommandsFor(
  adapter: Pick<ProviderAdapter, 'slashCommands' | 'capabilities'> | undefined,
  folder: string,
  warn: (msg: string, meta?: Record<string, unknown>) => void
): Promise<SlashCommand[]> {
  let builtins: SlashCommand[] = [];
  try {
    builtins = adapter?.slashCommands?.() ?? [];
  } catch (err) {
    warn('slash-command builtins threw', { error: errorText(err) });
  }
  const files = adapter?.capabilities?.commandFiles;
  // Through `mergeCommands` either way, so both paths come back de-duplicated
  // and sorted the same.
  if (!files) return mergeCommands(builtins);
  let scanned: SlashCommand[] = [];
  try {
    scanned = await files.scan(folder, (msg) => warn(msg));
  } catch (err) {
    warn('slash-command scan threw', { error: errorText(err) });
  }
  return mergeCommands(builtins, scanned);
}
