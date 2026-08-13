// The OS credential store (P2-E14-06, DESIGN §5.29).
//
// §5.29's rule, and the project's, is that user credentials live in the OS
// credential store and never in files. This is that store — the first one this
// codebase has had (`update/token.ts` reserved a slot for it and left the slot
// empty, which was the honest thing to do for an update checker; a phone push
// the user pastes a token into is what finally makes it real).
//
// ── what "the OS credential store" means here ────────────────────────────────
//
// Electron's `safeStorage`. On every platform it hands the *key* to the OS and
// keeps only ciphertext for us:
//
//   • **Windows** — DPAPI, keyed to the logged-in user account.
//   • **macOS** — a key in the login **Keychain**, unlocked with the session.
//   • **Linux** — libsecret: **kwallet** or **gnome-keyring**, whichever the
//     desktop provides. A headless box with neither has NO store, and says so.
//
// The ciphertext lands in `secrets.json` beside the workspace file, which is
// the nuance worth stating plainly rather than hiding behind "credential
// store": what is on disk is an opaque blob that only this OS user on this
// machine can decrypt. Copy the file to another machine and it decrypts to
// nothing — which is the correct outcome, and one the store treats as an
// ordinary "no credential" rather than an error.
//
// ── the rules this file keeps ────────────────────────────────────────────────
//
// 1. **A value never reaches a log line.** Every log here names a KEY. There is
//    no debug flag that turns that off, and `secrets.test.ts` scans the log for
//    the value it just stored.
// 2. **No plaintext fallback, ever.** If the OS has no store, `set` refuses and
//    the caller tells the user. Writing the token to a file "just this once"
//    would make the promise on the setup dialog a lie.
// 3. **Fail-open, like everything on the notification path (P6).** Every method
//    swallows its own failure and answers "no": a corrupt secrets file costs
//    the phone push and nothing else.
import fs from 'fs';
import path from 'path';
import type { Logger } from '../log/logger';

/**
 * The `safeStorage` shape, as an interface so the store is testable without
 * electron — electron's own `safeStorage` satisfies it structurally.
 */
export interface SecretCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The on-disk shape. Values are base64 of `encryptString`'s bytes. */
interface SecretFile {
  version: 1;
  entries: Record<string, string>;
}

/** A pasted credential longer than this is not a credential, it is a mistake. */
export const MAX_SECRET_LENGTH = 4096;

export const SECRETS_FILE = 'secrets.json';

export interface SecretStoreOptions {
  /** the directory the file lives in — `app.getPath('userData')` in the app */
  dir: string;
  crypto: SecretCrypto;
  log?: Logger;
}

export class SecretStore {
  /** decrypted values, cached after the first read; `null` = tried, no value */
  private cache = new Map<string, string | null>();
  private entries: Record<string, string> | null = null;

  constructor(private readonly opts: SecretStoreOptions) {}

  private get file(): string {
    return path.join(this.opts.dir, SECRETS_FILE);
  }

  /** Will this machine keep a secret for us at all? */
  available(): boolean {
    try {
      return this.opts.crypto.isEncryptionAvailable();
    } catch (err) {
      this.opts.log?.warn('the OS credential store could not be reached', { error: String(err) });
      return false;
    }
  }

  /**
   * Store a credential. `false` means it was NOT stored — no store on this
   * machine, an empty value, or a write that failed — and the caller must say
   * so rather than leave a dialog claiming a token is saved.
   */
  set(key: string, value: string): boolean {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_SECRET_LENGTH) {
      this.opts.log?.warn('a credential was refused', {
        key,
        reason: trimmed ? 'too long' : 'empty',
      });
      return false;
    }
    if (!this.available()) {
      this.opts.log?.warn('a credential was not stored: this machine has no credential store', {
        key,
      });
      return false;
    }
    let encoded: string;
    try {
      encoded = this.opts.crypto.encryptString(trimmed).toString('base64');
    } catch (err) {
      this.opts.log?.warn('a credential could not be encrypted', { key, error: String(err) });
      return false;
    }
    const entries = { ...this.read(), [key]: encoded };
    if (!this.write(entries)) return false;
    this.cache.set(key, trimmed);
    this.opts.log?.info('a credential was stored', { key });
    return true;
  }

  /** The credential, or null — an absent one and an undecryptable one are the
   *  same answer to every caller, and neither is an error. */
  get(key: string): string | null {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const encoded = this.read()[key];
    if (typeof encoded !== 'string' || !encoded) {
      this.cache.set(key, null);
      return null;
    }
    let value: string | null = null;
    try {
      value = this.opts.crypto.decryptString(Buffer.from(encoded, 'base64')) || null;
    } catch (err) {
      // A file from another machine or another OS user. Expected, not broken.
      this.opts.log?.warn('a stored credential could not be read back', {
        key,
        error: String(err),
      });
      value = null;
    }
    this.cache.set(key, value);
    return value;
  }

  /** Is there a USABLE credential here? (present *and* decryptable). */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** Forget one. `true` if there was something to forget. */
  clear(key: string): boolean {
    const entries = { ...this.read() };
    if (!(key in entries)) {
      this.cache.set(key, null);
      return false;
    }
    delete entries[key];
    this.write(entries);
    this.cache.set(key, null);
    this.opts.log?.info('a credential was cleared', { key });
    return true;
  }

  /** Drop the in-memory copies (a test seam, and the shape a lock screen wants). */
  forgetCached(): void {
    this.cache.clear();
    this.entries = null;
  }

  private read(): Record<string, string> {
    if (this.entries) return this.entries;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SecretFile>;
      const entries = raw?.entries;
      this.entries =
        entries && typeof entries === 'object' && !Array.isArray(entries)
          ? Object.fromEntries(
              Object.entries(entries).filter(([, v]) => typeof v === 'string')
            )
          : {};
    } catch (err) {
      // Missing is the first-run case and by far the common one, so only a
      // file that EXISTS and would not parse is worth a line.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT')
        this.opts.log?.warn('the credential file could not be read', { error: String(err) });
      this.entries = {};
    }
    return this.entries;
  }

  /**
   * Atomic write, `0600`, tmp + rename — the workspace store's shape, with the
   * file mode added: this file is ciphertext, but a credential file readable by
   * every account on the box is still a smell, and the cost is one option.
   */
  private write(entries: Record<string, string>): boolean {
    const payload: SecretFile = { version: 1, entries };
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.entries = entries;
      return true;
    } catch (err) {
      this.opts.log?.warn('the credential file could not be written', { error: String(err) });
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* the tmp file is not worth a second failure */
      }
      return false;
    }
  }
}
