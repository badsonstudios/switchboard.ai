// PROBE (#1088). What does the history picker actually list?
//
// The owner, 2026-10-06: *"when I click the previous conversations clock icon at
// the top of a session. It lists all sorts of crap in there."*
//
// So: the app's own `listHistory`, pointed at this machine's real transcripts
// for this repo's folder, with the same title reader the app uses — and every
// row printed, classified by what its description is made of.
import { describe, it } from 'vitest';
import os from 'os';
import path from 'path';
import { listHistory, clearHistoryCache } from '../../../src/main/transcripts/history';

const FOLDER = process.env.PROBE_FOLDER ?? 'C:\\Projects\\Switchboard.ai';

/** the CLI's own `ai-title` line — the shape the app's provider reads */
function readTitle(line: Record<string, unknown>): string | undefined {
  if (line.type === 'ai-title' && typeof line.aiTitle === 'string') return line.aiTitle;
  return undefined;
}

function kind(description: string): string {
  const d = description.trim();
  if (!d) return 'EMPTY';
  if (/^<[a-z-]+>/i.test(d)) return 'XML-WRAPPER';
  if (/^\/[a-z][\w:-]*/i.test(d)) return 'SLASH-COMMAND';
  if (/^(Base directory for this skill|Caveat:|\[Request interrupted)/i.test(d)) return 'HARNESS-TEXT';
  if (/^(You are|Read-only review|Your task|PROBE|Reply with|Say |Summari[sz]e|Write a (short|one))/i.test(d))
    return 'LOOKS-AUTOMATED';
  if (d.length < 12) return 'VERY-SHORT';
  return 'ok';
}

describe('probe #1088', () => {
  it('prints what the picker would list', () => {
    clearHistoryCache();
    const res = listHistory(
      { scope: 'folder', folder: FOLDER, limit: 500 },
      { projectsRoot: path.join(os.homedir(), '.claude', 'projects'), readTitle, claimed: () => [] }
    );
    if (res.status !== 'ok') {
      console.log('probe1088: status', JSON.stringify(res).slice(0, 300));
      return;
    }
    const rows = res.rows;
    const counts: Record<string, number> = {};
    const from: Record<string, number> = {};
    for (const r of rows) {
      const k = kind(r.description);
      counts[k] = (counts[k] ?? 0) + 1;
      from[r.descriptionFrom] = (from[r.descriptionFrom] ?? 0) + 1;
    }
    console.log(`probe1088: ${rows.length} rows for ${FOLDER}; other keys: ${Object.keys(res).join(',')}`);
    console.log(`probe1088: description from: ${JSON.stringify(from)}`);
    console.log(`probe1088: by kind: ${JSON.stringify(counts)}`);
    for (const r of rows.slice(0, 70)) {
      const when = new Date(r.lastActiveMs).toISOString().slice(0, 16);
      console.log(
        `probe1088: ${when} [${r.descriptionFrom.padEnd(6)}] ${kind(r.description).padEnd(15)} ${JSON.stringify(r.description.slice(0, 110))}`
      );
    }
  });
});
