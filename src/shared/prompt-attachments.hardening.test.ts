// Hostile input at the composer's seam (#499): a prompt of any length, and a
// file name that reorders the text around it.
//
// The characters are BUILT FROM CODE POINTS, never typed into this file: an
// override in a source file reorders the source, and `check:nul` exists to
// keep control characters out of the tree.
import { describe, expect, it } from 'vitest';
import {
  MAX_PROMPT_CHARS,
  cleanAttachmentTitle,
  isPromptTooLong,
  sanitizePromptAttachments,
} from './prompt-attachments';

const cp = (n: number): string => String.fromCodePoint(n);
const RLO = cp(0x202e); // right-to-left override
const LRO = cp(0x202d); // left-to-right override
const PDF = cp(0x202c); // pop directional formatting
const RLI = cp(0x2067); // right-to-left isolate
const RLM = cp(0x200f); // right-to-left mark
const ZWSP = cp(0x200b); // zero-width space
const BOM = cp(0xfeff);
const TAG_A = cp(0xe0041); // an invisible "A"
const ZWJ = cp(0x200d); // emoji joiner: kept
const VS16 = cp(0xfe0f); // emoji variation selector: kept
/** every character a person cannot see and a renderer reorders text on */
const INVISIBLE = new RegExp(
  `[${cp(0x200b)}${cp(0x200e)}${cp(0x200f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x2064)}${cp(0x2066)}-${cp(0x2069)}${cp(0xfeff)}${cp(0xe0000)}-${cp(0xe007f)}]`,
  'u'
);

describe('a prompt’s length (#499)', () => {
  it('is fine up to a million characters, and too long one past it', () => {
    expect(MAX_PROMPT_CHARS).toBe(1_000_000);
    expect(isPromptTooLong('')).toBe(false);
    expect(isPromptTooLong('a'.repeat(50_000))).toBe(false); // the reference's number is not a limit here
    expect(isPromptTooLong('a'.repeat(MAX_PROMPT_CHARS))).toBe(false);
    expect(isPromptTooLong('a'.repeat(MAX_PROMPT_CHARS + 1))).toBe(true);
  });
});

describe('a file’s name, made safe to show and to send (#499)', () => {
  it('takes the direction overrides out, so the name reads as it is spelled', () => {
    // the classic: shown as `invoiceexe.pdf`, really `invoice…fdp.exe`
    const spoofed = `invoice${RLO}fdp.exe`;
    const clean = cleanAttachmentTitle(spoofed);
    expect(clean).toBe('invoicefdp.exe');
    expect(INVISIBLE.test(clean)).toBe(false);
  });

  it('a name FULL of them comes out inert, whatever the mix', () => {
    const hostile = `${RLO}${LRO}a${RLI}b${PDF}${RLM}c${ZWSP}d${BOM}${TAG_A}.txt${RLO}`;
    const clean = cleanAttachmentTitle(hostile);
    expect(clean).toBe('abcd.txt');
    expect(INVISIBLE.test(clean)).toBe(false);
  });

  it('cannot leave an override open to reverse what the app prints AFTER the name', () => {
    // the name is printed in the middle of a sentence ("Not restored: a, b.")
    const sentence = `Not restored: ${cleanAttachmentTitle(`report${RLO}`)}, next.log.`;
    expect(INVISIBLE.test(sentence)).toBe(false);
  });

  it('keeps what a person can type: other scripts, emoji joined and coloured', () => {
    expect(cleanAttachmentTitle('отчёт.pdf')).toBe('отчёт.pdf');
    expect(cleanAttachmentTitle('تقرير.pdf')).toBe('تقرير.pdf');
    const family = `${cp(0x1f469)}${ZWJ}${cp(0x1f4bb)}${VS16}.png`;
    expect(cleanAttachmentTitle(family)).toBe(family);
  });

  it('turns a tab or a newline into a space, and trims', () => {
    expect(cleanAttachmentTitle(`  a${cp(9)}b${cp(10)}c.txt `)).toBe('a b c.txt');
  });

  it('a name that was nothing but invisible characters gets a plain one', () => {
    expect(cleanAttachmentTitle(`${RLO}${ZWSP}${BOM}`)).toBe('file');
    expect(cleanAttachmentTitle('', 'pasted')).toBe('pasted');
  });

  it('is a no-op on an ordinary name, and on its own output', () => {
    for (const name of ['server.log', 'My Résumé (final).pdf', 'a.b.c.tar.gz']) {
      expect(cleanAttachmentTitle(name)).toBe(name);
      expect(cleanAttachmentTitle(cleanAttachmentTitle(name))).toBe(name);
    }
  });
});

describe('main’s own check on a title (#499)', () => {
  const doc = (title: string): unknown[] => [{ kind: 'text', title, text: 'contents' }];

  it('accepts a title the composer cleaned', () => {
    const clean = cleanAttachmentTitle(`invoice${RLO}fdp.exe`);
    expect(sanitizePromptAttachments(doc(clean))).toEqual([{ kind: 'text', title: clean, text: 'contents' }]);
  });

  it('REFUSES the submission when a title still carries one: it did not come from the composer', () => {
    for (const bad of [`a${RLO}b.txt`, `a${RLI}b.txt`, `a${ZWSP}b.txt`, `a${TAG_A}b.txt`, `${BOM}a.txt`]) {
      expect(sanitizePromptAttachments(doc(bad)), JSON.stringify(bad)).toBeNull();
      expect(sanitizePromptAttachments([{ kind: 'pdf', title: bad, data: 'AAAA' }])).toBeNull();
    }
  });
});
