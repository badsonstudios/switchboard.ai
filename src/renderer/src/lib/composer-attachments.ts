// Composer attachments — what a paste (P2-E10-09) or a drop (P2-E10-10) turns
// into.
//
// The clipboard/drop half of the composer, kept away from the DOM for the same
// reason `composer-size.ts` is: this is the part that can be WRONG about a
// transfer (which items count as a file, what a text+image clipboard means,
// whether a `.md` is text, when something is too big to send), and a rule
// pinned in a pure test cannot quietly regress into "whatever the handler
// happens to do today".
//
// The component's job is only to hand over a `DataTransfer` and await bytes.
//
// ONE AFFORDANCE, TWO ENTRY POINTS — deliberately, and the same way the
// reference does it: its paste handler and its drop handler both end in a
// single `onAddFiles(FileList)`, so there is exactly one place that decides
// what a file becomes. `Attachment` is a *carrier*, not "the pasted bitmap":
// a dropped `.md` is the same struct with a different `kind`, so the chip
// strip, the removal, the height accounting and the send path are written once.
//
// The RULES — the accepted types, the size ceiling, the count cap, the
// classifier — are not here. They live in `shared/prompt-attachments.ts`
// because main enforces the same ones independently before anything reaches
// the CLI's stdin, and a second copy is how the two ends come to disagree.
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_PAYLOAD_BYTES,
  MAX_ENCODED_FILE_BYTES,
  classifyAttachment,
  utf8Bytes,
  type AttachmentKind,
  type ImageMediaType,
  type PromptAttachment,
} from '../../../shared/prompt-attachments';

export {
  IMAGE_MEDIA_TYPES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_PAYLOAD_BYTES,
  MAX_ENCODED_FILE_BYTES,
  PDF_MEDIA_TYPE,
  TEXT_FILE_EXTENSIONS,
  classifyAttachment,
  isImageMediaType,
  isTextAttachment,
} from '../../../shared/prompt-attachments';
export type {
  AttachmentKind,
  ImageMediaType,
  PromptAttachment,
} from '../../../shared/prompt-attachments';

/** Fields every attachment has, whatever it turned out to be. */
interface AttachmentBase {
  /** stable within a draft — the strip's React key and the remove target */
  id: string;
  /** what the chip says, and the `title` the document block carries */
  name: string;
  /** size of the SOURCE file, for the chip — not the size of the payload */
  bytes: number;
}

/**
 * One thing riding along with the prompt.
 *
 * A DISCRIMINATED UNION, so the payload field cannot be read as the wrong
 * thing. An image and a PDF carry `data` (base64, no `data:` prefix); a text
 * file carries `text` (the decoded contents, in the clear). Those are genuinely
 * different — see `StreamDocumentBlock` — and a single `data: string` field
 * holding either one is precisely the bug where base64 gets sent as a
 * `type:"text"` source and the model is shown gibberish.
 */
export type Attachment =
  | (AttachmentBase & { kind: 'image'; mediaType: ImageMediaType; data: string })
  | (AttachmentBase & { kind: 'pdf'; mediaType: 'application/pdf'; data: string })
  | (AttachmentBase & { kind: 'text'; mediaType: string; text: string });

/** Why a paste or a drop produced no attachment. `null` means it did. */
export type AttachmentRejection =
  | 'too-large'
  | 'too-many'
  | 'unreadable'
  | 'unsupported'
  | 'directory'
  | 'empty';

export interface AttachOutcome {
  /** the files to attach, in the order they were given */
  attachments: Attachment[];
  /**
   * The first thing that went wrong, or null. ONE, not a list: the strip has
   * room for one line of explanation and a user who dropped a folder of forty
   * files needs to be told that once, not forty times.
   */
  rejected: AttachmentRejection | null;
}

/**
 * Every file on a clipboard, in order — NOT just the ones we can use.
 *
 * The classification happens in `readAttachments`, on purpose: the reference's
 * paste handler takes every item whose `kind === "file"` and lets the
 * downstream classifier reject what it cannot use, WITH A VISIBLE MESSAGE.
 * Filtering here instead would turn a pasted TIFF into a paste that does
 * nothing and says nothing, which is the outcome #163 taught us costs a bug
 * report.
 *
 * `DataTransfer.files` and not `.items`: a paste that carries both text and a
 * bitmap has an item per FLAVOUR (`text/plain`, `text/html`, `image/png`), and
 * `.files` is already the subset whose items are files.
 */
export function filesFrom(dt: Pick<DataTransfer, 'files' | 'getData'>): File[] {
  return Array.from(dt.files ?? []);
}

/** What a drop contained, once folders have been told apart from files. */
export interface DroppedItems {
  files: File[];
  /** names of the folders in the drop, which cannot be attached */
  directories: string[];
}

/**
 * Split a DROP into files and folders.
 *
 * WHY THIS EXISTS AND PASTE HAS NO EQUIVALENT: you cannot paste a folder, but
 * you can certainly drag one, and a dragged folder arrives in `dataTransfer
 * .files` looking exactly like a zero-byte file with an empty MIME type. The
 * reference does nothing about this at all — `webkitGetAsEntry`, `isDirectory`
 * and `webkitRelativePath` all count ZERO in both of its bundles — so a folder
 * named `readme` dropped on the VS Code extension is classified as text by its
 * NAME and sent as an empty document. We refuse it instead, which is a
 * DELIBERATE DIVERGENCE and the one the issue asked for by name.
 *
 * `webkitGetAsEntry()` is the only reliable way to tell the two apart, and it
 * must be called SYNCHRONOUSLY inside the drop handler — a `DataTransfer` is
 * neutered the moment the event finishes, so this cannot be moved behind an
 * `await`. That is why it is a separate function from `readAttachments`, which
 * is async: the splitting happens now, the reading happens later.
 *
 * If the entry API is missing (an engine we have not met, a synthetic event in
 * a test), we fall back to `.files` and a folder simply arrives as a zero-byte
 * file — which `readAttachments` refuses as `empty` rather than sending a
 * hollow document block. The message is less specific; nothing is sent wrong.
 */
export function filesFromDrop(dt: Pick<DataTransfer, 'files' | 'items'>): DroppedItems {
  const items = dt.items;
  const files: File[] = [];
  const directories: string[] = [];
  // `items` exists but the entry API may not; a list we cannot interrogate is
  // no better than no list, so both fall through to `.files`
  const usable =
    items != null &&
    items.length > 0 &&
    typeof (items[0] as DataTransferItem | undefined)?.webkitGetAsEntry === 'function';
  if (!usable) return { files: Array.from(dt.files ?? []), directories };
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    let entry: FileSystemEntry | null = null;
    try {
      entry = item.webkitGetAsEntry();
    } catch {
      entry = null;
    }
    if (entry?.isDirectory) {
      directories.push(entry.name);
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, directories };
}

/**
 * Does this clipboard also carry text the user expects to land in the box?
 *
 * The rule the composer follows, and the one the manual documents: a clipboard
 * with BOTH is not a conflict to resolve, it is two things to keep. The text
 * pastes exactly as it always did (we do not `preventDefault`) and the image
 * attaches beside it. Losing either one silently is the outcome worth avoiding
 * — a user who copied a cell range out of a spreadsheet has both, and either
 * half alone is a bug report.
 */
export function hasPlainText(dt: Pick<DataTransfer, 'files' | 'getData'>): boolean {
  try {
    return (dt.getData('text/plain') ?? '') !== '';
  } catch {
    // getData throws outside a real paste/drop event in some engines; a
    // clipboard we cannot ask about is treated as file-only, which at worst
    // suppresses a text paste that was not there.
    return false;
  }
}

/** `image/png` -> `png` — the extension the generated name gets. */
function extensionFor(mediaType: ImageMediaType): string {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length);
}

/**
 * A name for something the clipboard gave us anonymously.
 *
 * Chromium hands a pasted bitmap over as `image.png` for every paste, so the
 * chips would all read the same. A short time stamp is enough to tell two
 * screenshots apart in a strip, and is the same thing the CLI's own scratch
 * files are named after. Only the PASTE route uses this: a dropped file keeps
 * the name the file system gave it, even if that name is .
 */
export function pastedImageName(mediaType: ImageMediaType, at = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}` +
    `-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
  return `pasted-${stamp}.${extensionFor(mediaType)}`;
}

/** base64 of an ArrayBuffer, without a `data:` prefix. */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // chunked: `String.fromCharCode(...bytes)` blows the argument limit somewhere
  // around a hundred thousand bytes, and every image here is bigger than that
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Decode a file's bytes as UTF-8 — and a DELIBERATE, SMALL DIVERGENCE.
 *
 * The reference reads every file with `readAsDataURL` and then recovers the
 * text ones with `atob(u)`. `atob` returns a latin1 "binary string": every BYTE
 * becomes one code point, so a UTF-8 source file containing an em-dash, an
 * accent or a CJK character arrives at the model MOJIBAKE'D (`—` as `â€”`).
 * There is no `TextDecoder` anywhere on that path — verified, not assumed.
 *
 * We decode as UTF-8 instead. The WIRE SHAPE is identical (a `type:"text"`
 * document source carrying the file's contents); the only difference is that
 * ours are the characters the file actually holds. Matching the reference here
 * would mean deliberately corrupting non-ASCII files, which is not what
 * "match, don't invent" is asking for.
 *
 * A leading BOM is dropped by `TextDecoder` on its own — worth knowing, because
 * Windows editors write one and a stray `U+FEFF` at the head of a prompt block
 * is exactly the kind of invisible character that costs an hour.
 */
export function decodeUtf8(buffer: ArrayBuffer): string {
  return new TextDecoder('utf-8').decode(buffer);
}

/** Bytes -> "12 KB". Chip-sized, and never a fraction of a byte. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let counter = 0;

/**
 * Read files from a clipboard or a drop into attachments.
 *
 * `existing` is how many the draft already holds, so the cap is on the DRAFT
 * and not on the transfer — four pastes of two files each has to stop in the
 * same place one drop of eight does.
 *
 * Nothing here throws: a drop is user input arriving at an input box, and the
 * composer's contract is that a transfer it cannot use leaves the draft exactly
 * as it found it (fail-open, PHILOSOPHY §3).
 */
export async function readAttachments(
  files: File[],
  existing = 0,
  origin: 'paste' | 'drop' = 'paste',
  now: () => Date = () => new Date()
): Promise<AttachOutcome> {
  const attachments: Attachment[] = [];
  let rejected: AttachmentRejection | null = null;

  for (const file of files) {
    if (existing + attachments.length >= MAX_ATTACHMENTS) {
      rejected ??= 'too-many';
      break;
    }
    // lower-cased before anything looks at it, exactly as the reference's own
    // classifier does (`Git(e){ return Hbe(e.type.toLowerCase(), e.name) … }`)
    const mediaType = file.type.toLowerCase();
    const kind: AttachmentKind | 'unsupported' = classifyAttachment(mediaType, file.name);
    if (kind === 'unsupported') {
      // the reference names the escape hatch rather than shrugging: an
      // unsupported file is referenced by absolute path in the prompt instead
      rejected ??= 'unsupported';
      continue;
    }
    // A zero-byte file is refused rather than sent as a hollow block. It is
    // also, in practice, what a dragged FOLDER looks like when the entry API
    // did not answer — so this doubles as the safety net under `filesFromDrop`.
    if (file.size === 0) {
      rejected ??= 'empty';
      continue;
    }
    // Cheap check first: the file's own size rules out the huge ones before we
    // spend a copy of them in memory. Text is not encoded, so it is measured
    // against the payload ceiling directly; image and PDF are base64'd on the
    // way out and get the 3/4 allowance.
    const ceiling = kind === 'text' ? MAX_ATTACHMENT_PAYLOAD_BYTES : MAX_ENCODED_FILE_BYTES;
    if (file.size > ceiling) {
      rejected ??= 'too-large';
      continue;
    }

    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      rejected ??= 'unreadable';
      continue;
    }

    if (kind === 'text') {
      const text = decodeUtf8(buffer);
      // A file with bytes whose decode is empty is not a file we can send; the
      // block would claim to carry the file and carry nothing.
      if (text.length === 0) {
        rejected ??= 'empty';
        continue;
      }
      // RE-CHECK THE DECODED SIZE, for the same reason the base64 kinds
      // re-check their encoded length below: `file.size` is an ESTIMATE of what
      // travels, not a guarantee. Bytes that are not valid UTF-8 each decode to
      // U+FFFD, which re-encodes to THREE bytes — so a 4 MB latin-1 `.csv` full
      // of high bytes crosses the ceiling on the way through. Without this the
      // chip appears, the user presses Enter, and main's own check refuses the
      // whole submission with "the session may have stopped", which is a wrong
      // diagnosis they cannot act on.
      if (utf8Bytes(text) > MAX_ATTACHMENT_PAYLOAD_BYTES) {
        rejected ??= 'too-large';
        continue;
      }
      attachments.push({
        id: `att-${++counter}`,
        name: file.name,
        kind: 'text',
        mediaType: mediaType || 'text/plain',
        bytes: file.size,
        text,
      });
      continue;
    }

    let data: string;
    try {
      data = toBase64(buffer);
    } catch {
      rejected ??= 'unreadable';
      continue;
    }
    if (data.length > MAX_ATTACHMENT_PAYLOAD_BYTES) {
      // the encoded length is what travels; the size check above is an estimate
      // of this one and a 4/3 ratio is not a guarantee
      rejected ??= 'too-large';
      continue;
    }
    if (kind === 'pdf') {
      attachments.push({
        id: `att-${++counter}`,
        name: file.name,
        kind: 'pdf',
        mediaType: 'application/pdf',
        bytes: file.size,
        data,
      });
      continue;
    }
    // ONLY A PASTE gets a generated name. Chromium hands every pasted bitmap
    // over as `image.png`, so keeping it would make every chip in the strip
    // read the same — but a DROPPED file genuinely called `image.png` is an
    // ordinary file whose real name we must not throw away. The origin is the
    // only thing that can tell those two apart.
    const anonymous = origin === 'paste' && (!file.name || file.name === 'image.png');
    attachments.push({
      id: `att-${++counter}`,
      name: anonymous ? pastedImageName(mediaType as ImageMediaType, now()) : file.name,
      kind: 'image',
      mediaType: mediaType as ImageMediaType,
      bytes: file.size,
      data,
    });
  }

  return { attachments, rejected };
}

/**
 * Strip the draft-only fields and hand main what goes on the wire.
 *
 * The chip's `id` and `bytes` are ours and stop here — main gets exactly what
 * `sanitizePromptAttachments` expects to validate, and no more. `name` becomes
 * `title`, which is what the reference's `title:c.file.name` is.
 */
export function toPromptAttachments(attachments: readonly Attachment[]): PromptAttachment[] {
  return attachments.map((a) => {
    if (a.kind === 'image') return { kind: 'image', mediaType: a.mediaType, data: a.data };
    if (a.kind === 'pdf') return { kind: 'pdf', title: a.name, data: a.data };
    return { kind: 'text', title: a.name, text: a.text };
  });
}
