// `ais.json` under userData: the custom AIs and the chosen default AI (E40
// item 08, #1291).
//
// Its own small file rather than more fields in `workspace.json`: what lives
// here DEFINES PROGRAMS THE APP WILL LAUNCH, and keeping that out of the file
// every layout change rewrites keeps the two failure domains apart.
//
// The house rules for a persisted settings file, smaller:
//   - ATOMIC SAVE: tmp + rename, retried once (a scanner holding the file on
//     Windows is over in well under a second);
//   - FAIL-OPEN LOAD: a missing file is an empty one; a corrupt one is logged,
//     moved aside as `ais.json.bad` (the post-mortem), and the app starts with
//     no custom AIs and Claude as the default. It never prevents startup;
//   - TOLERANT READ: an entry that is not a well-formed custom AI is dropped
//     with a log line, and the rest survive.
import fs from 'fs';
import path from 'path';
import type { CustomAi } from '../../shared/ais';
import { errorText } from '../../shared/error-text';
import { validCustomAi } from './custom-ais';

export const AIS_FILE = 'ais.json';
const VERSION = 1;

interface AisFile {
  version: number;
  /** the provider id the user chose for new sessions; absent = never chosen */
  defaultAi?: string;
  custom: CustomAi[];
}

export interface AisStoreLog {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
}

export class AisStore {
  private state: AisFile = { version: VERSION, custom: [] };
  /** the file exists but could not be read: never write over it this run */
  private noSave = false;
  readonly file: string;

  constructor(
    dir: string,
    private readonly log: AisStoreLog,
    private readonly fsx: Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync' | 'existsSync'> = fs
  ) {
    this.file = path.join(dir, AIS_FILE);
  }

  load(): void {
    if (!this.fsx.existsSync(this.file)) return;
    let text: string;
    try {
      text = this.fsx.readFileSync(this.file, 'utf8');
    } catch (err) {
      // Could not READ it (a scanner holding it, a permissions problem): the
      // file may be perfectly good, so it is neither set aside nor overwritten
      // — this run keeps its changes in memory only.
      this.noSave = true;
      this.log.warn('ais.json could not be read; this run will not save AI settings over it', { error: errorText(err) });
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      this.setAside(errorText(err));
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.setAside('the file is not a JSON object');
      return;
    }
    const o = raw as Record<string, unknown>;
    const custom: CustomAi[] = [];
    for (const c of Array.isArray(o.custom) ? o.custom : []) {
      const ok = validCustomAi(c);
      if (ok && !custom.some((x) => x.id === ok.id)) custom.push(ok);
      else this.log.warn('an AI in ais.json was unusable and was skipped', { entry: JSON.stringify(c)?.slice(0, 200) });
    }
    this.state = {
      version: VERSION,
      custom,
      ...(typeof o.defaultAi === 'string' && o.defaultAi ? { defaultAi: o.defaultAi } : {}),
    };
    this.log.info('AIs settings loaded', { custom: custom.length, defaultAi: this.state.defaultAi ?? null });
  }

  private setAside(why: string): void {
    const bad = `${this.file}.bad`;
    try {
      this.fsx.renameSync(this.file, bad);
      this.log.warn('ais.json was unreadable; it was set aside and the AIs settings start empty', { why, setAside: bad });
    } catch (err) {
      // The post-mortem is still sitting at `this.file`, and the next save's
      // rename would destroy it: this run does not save.
      this.noSave = true;
      this.log.warn('ais.json was unreadable and could not be set aside; the AIs settings start empty and will not be saved this run', {
        why,
        error: errorText(err),
      });
    }
    this.state = { version: VERSION, custom: [] };
  }

  customAis(): CustomAi[] {
    return this.state.custom.map((c) => ({ ...c, args: [...c.args], ...(c.env ? { env: { ...c.env } } : {}) }));
  }

  defaultAi(): string | undefined {
    return this.state.defaultAi;
  }

  /** Persist. False when the write failed twice (logged); memory keeps the change. */
  setDefaultAi(id: string | undefined): boolean {
    if (id) this.state.defaultAi = id;
    else delete this.state.defaultAi;
    return this.save();
  }

  addCustom(ai: CustomAi): boolean {
    this.state.custom = [...this.state.custom.filter((c) => c.id !== ai.id), ai];
    return this.save();
  }

  removeCustom(id: string): boolean {
    const before = this.state.custom.length;
    this.state.custom = this.state.custom.filter((c) => c.id !== id);
    if (this.state.custom.length === before) return false;
    return this.save();
  }

  private save(): boolean {
    if (this.noSave) return false;
    const tmp = `${this.file}.tmp`;
    const body = JSON.stringify(this.state, null, 2);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        this.fsx.mkdirSync(path.dirname(this.file), { recursive: true });
        this.fsx.writeFileSync(tmp, body);
        this.fsx.renameSync(tmp, this.file);
        return true;
      } catch (err) {
        if (attempt === 2) {
          this.log.warn('could not save ais.json', { error: errorText(err) });
          return false;
        }
      }
    }
    return false;
  }
}
