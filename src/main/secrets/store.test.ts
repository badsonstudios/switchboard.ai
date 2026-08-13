// The OS credential store (P2-E14-06, §5.29).
//
// The crypto is a fake, so what is under test is the STORE's contract, not
// electron's: what reaches disk, what comes back, what happens when the machine
// has no keyring, and — the assertion this whole item rests on — that a value
// handed to `set` never appears in a log line.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SECRETS_FILE, SecretCrypto, SecretStore, MAX_SECRET_LENGTH } from './store';
import { LogFields, Logger } from '../log/logger';

const SECRET = 'nt-topic-8f3a-VERY-SECRET';

interface LogLine {
  level: string;
  msg: string;
  fields?: LogFields;
}

/**
 * A reversible stand-in for DPAPI/Keychain/libsecret.
 *
 * Deliberately NOT a no-op: reversing the string means a test that forgot to
 * encrypt would still round-trip, but the bytes on disk would contain the
 * secret — and there is a test below that reads those bytes.
 */
function fakeCrypto(available = true): SecretCrypto & { calls: number } {
  return {
    calls: 0,
    isEncryptionAvailable: () => available,
    encryptString(s: string) {
      this.calls++;
      return Buffer.from([...s].reverse().join(''), 'utf8');
    },
    decryptString: (b: Buffer) => [...b.toString('utf8')].reverse().join(''),
  };
}

function harness(crypto: SecretCrypto = fakeCrypto()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-secrets-'));
  const logs: LogLine[] = [];
  const rec =
    (level: string) =>
    (msg: string, fields?: LogFields): void => void logs.push({ level, msg, fields });
  const log = {
    debug: rec('debug'),
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    child: () => log,
  } as unknown as Logger;
  const store = new SecretStore({ dir, crypto, log });
  return {
    dir,
    store,
    logs,
    file: path.join(dir, SECRETS_FILE),
    /** every log line, flattened — what a "no secrets in the log" scan reads */
    logText: () => JSON.stringify(logs),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('SecretStore', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });
  afterEach(() => h.cleanup());

  it('round-trips a credential through the file', () => {
    expect(h.store.set('ntfy.topic', SECRET)).toBe(true);
    expect(h.store.get('ntfy.topic')).toBe(SECRET);
    expect(h.store.has('ntfy.topic')).toBe(true);
    // a fresh instance reads the same file — nothing lives only in memory
    const second = new SecretStore({ dir: h.dir, crypto: fakeCrypto() });
    expect(second.get('ntfy.topic')).toBe(SECRET);
  });

  it('writes CIPHERTEXT: the plaintext is not in the file', () => {
    h.store.set('ntfy.topic', SECRET);
    const bytes = fs.readFileSync(h.file, 'utf8');
    expect(bytes).not.toContain(SECRET);
    expect(bytes).toContain('ntfy.topic'); // the slot name is not a secret
  });

  // The claim the item is graded on. A scan, not a spot-check: every line, every
  // field, whatever the level.
  it('never writes a credential to the log', () => {
    h.store.set('ntfy.topic', SECRET);
    h.store.get('ntfy.topic');
    h.store.clear('ntfy.topic');
    h.store.set('pushover.token', 'x'.repeat(MAX_SECRET_LENGTH + 1)); // refused
    expect(h.logText()).not.toContain(SECRET);
    expect(h.logText()).not.toContain('xxxxxxxxxx');
    // …and it still says WHICH slot moved, or the log would be useless
    expect(h.logText()).toContain('ntfy.topic');
  });

  it('trims what it is handed, and refuses an empty value', () => {
    expect(h.store.set('ntfy.topic', `  ${SECRET}\n`)).toBe(true);
    expect(h.store.get('ntfy.topic')).toBe(SECRET);
    expect(h.store.set('ntfy.topic', '   ')).toBe(false);
    // the refusal changed nothing
    expect(h.store.get('ntfy.topic')).toBe(SECRET);
  });

  it('refuses an absurdly long value rather than storing it', () => {
    expect(h.store.set('webhook.url', 'y'.repeat(MAX_SECRET_LENGTH + 1))).toBe(false);
    expect(h.store.has('webhook.url')).toBe(false);
  });

  it('clear() forgets one slot and leaves the others', () => {
    h.store.set('ntfy.topic', SECRET);
    h.store.set('webhook.url', 'https://example.test/hook');
    expect(h.store.clear('ntfy.topic')).toBe(true);
    expect(h.store.get('ntfy.topic')).toBeNull();
    expect(h.store.get('webhook.url')).toBe('https://example.test/hook');
    expect(h.store.clear('ntfy.topic')).toBe(false); // nothing left to forget
  });

  it('an absent file is the first-run case, not an error', () => {
    expect(h.store.get('ntfy.topic')).toBeNull();
    expect(h.store.has('webhook.url')).toBe(false);
    expect(h.logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('a corrupt file costs the credentials and nothing else', () => {
    fs.writeFileSync(h.file, '{not json at all');
    expect(h.store.get('ntfy.topic')).toBeNull();
    expect(h.logs.some((l) => l.level === 'warn')).toBe(true);
    // …and it can still be written back over
    expect(h.store.set('ntfy.topic', SECRET)).toBe(true);
    expect(h.store.get('ntfy.topic')).toBe(SECRET);
  });

  it('a value this machine cannot decrypt reads as absent, not as a crash', () => {
    h.store.set('ntfy.topic', SECRET);
    const hostile: SecretCrypto = {
      isEncryptionAvailable: () => true,
      encryptString: () => Buffer.from(''),
      decryptString: () => {
        throw new Error('wrong machine');
      },
    };
    const other = new SecretStore({ dir: h.dir, crypto: hostile });
    expect(other.get('ntfy.topic')).toBeNull();
    expect(other.has('ntfy.topic')).toBe(false);
  });

  describe('when the machine has no credential store', () => {
    it('refuses to store, and writes NOTHING to disk', () => {
      const none = harness(fakeCrypto(false));
      try {
        expect(none.store.available()).toBe(false);
        expect(none.store.set('ntfy.topic', SECRET)).toBe(false);
        // the point: no plaintext fallback file appeared
        expect(fs.existsSync(none.file)).toBe(false);
        expect(none.logText()).not.toContain(SECRET);
      } finally {
        none.cleanup();
      }
    });

    it('answers "unavailable" instead of throwing when the OS check itself throws', () => {
      const throwing: SecretCrypto = {
        isEncryptionAvailable: () => {
          throw new Error('no keyring');
        },
        encryptString: () => Buffer.from(''),
        decryptString: () => '',
      };
      const none = harness(throwing);
      try {
        expect(none.store.available()).toBe(false);
        expect(none.store.set('ntfy.topic', SECRET)).toBe(false);
      } finally {
        none.cleanup();
      }
    });
  });

  // Forget is the one operation where a comfortable lie is worst: a "cleared"
  // that did not clear leaves the dialog saying "not set" over a credential
  // that comes back on the next launch (review finding).
  it('clear() reports FALSE when the write failed, and keeps no false memory', () => {
    h.store.set('ntfy.topic', SECRET);
    // make the write fail: the file's directory disappears under it
    fs.rmSync(h.dir, { recursive: true, force: true });
    fs.writeFileSync(h.dir, 'not a directory'); // now the path cannot hold a file
    expect(h.store.clear('ntfy.topic')).toBe(false);
    expect(h.store.get('ntfy.topic')).toBe(SECRET); // still there, and known to be
    fs.rmSync(h.dir, { force: true });
    fs.mkdirSync(h.dir, { recursive: true }); // so afterEach can clean up
  });

  it('leaves no .tmp file behind after a write', () => {
    h.store.set('ntfy.topic', SECRET);
    expect(fs.readdirSync(h.dir)).toEqual([SECRETS_FILE]);
  });

  it('forgetCached() makes the next read hit the file again', () => {
    const crypto = fakeCrypto();
    const store = new SecretStore({ dir: h.dir, crypto });
    store.set('ntfy.topic', SECRET);
    // rewrite the file underneath it
    fs.writeFileSync(
      path.join(h.dir, SECRETS_FILE),
      JSON.stringify({
        version: 1,
        entries: { 'ntfy.topic': crypto.encryptString('a-different-topic').toString('base64') },
      })
    );
    expect(store.get('ntfy.topic')).toBe(SECRET); // cached
    store.forgetCached();
    expect(store.get('ntfy.topic')).toBe('a-different-topic');
  });
});
