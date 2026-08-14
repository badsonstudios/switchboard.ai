// Pasted-image attachments for the composer (P2-E10-09, §5.10).
//
// The clipboard half of the composer, kept away from the DOM for the same
// reason `composer-size.ts` is: this is the part that can be WRONG about a
// clipboard (which items count as an image, what a text+image clipboard means,
// when a bitmap is too big to send), and a rule pinned in a pure test cannot
// quietly regress into "whatever the paste handler happens to do today".
//
// The component's job is only to hand over a `DataTransfer` and await bytes.
//
// SHARED WITH #476 (drag & drop files) BY DESIGN: `Attachment` is a *carrier*,
// not "the pasted bitmap". A dropped file arrives as the same struct with a
// `name` from the file system instead of a generated one — so the chip strip,
// the removal, the height accounting and the send path are written once here
// and there is nothing for the drop item to fork.
//
// The RULES — the accepted media types, the size ceiling, the count cap — are
// not here. They live in `shared/prompt-images.ts` because main enforces the
// same ones independently before anything reaches the CLI's stdin, and a
// second copy is how the two ends come to disagree.
import {
  MAX_ATTACHMENTS,
  MAX_IMAGE_BASE64_BYTES,
  MAX_IMAGE_FILE_BYTES,
  type ImageMediaType,
  isImageMediaType,
} from '../../../shared/prompt-images';

export {
  IMAGE_MEDIA_TYPES,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BASE64_BYTES,
  MAX_IMAGE_FILE_BYTES,
  isImageMediaType,
} from '../../../shared/prompt-images';
export type { ImageMediaType } from '../../../shared/prompt-images';

/** One thing riding along with the prompt. */
export interface Attachment {
  /** stable within a draft — the strip's React key and the remove target */
  id: string;
  /** what the chip says. A pasted bitmap has no name, so we make one. */
  name: string;
  mediaType: ImageMediaType;
  /** decoded size, for the chip */
  bytes: number;
  /** base64, WITHOUT a `data:` prefix — exactly what the wire block carries */
  data: string;
}

/** Why a paste produced no attachment. `null` means it did. */
export type AttachmentRejection = 'too-large' | 'too-many' | 'unreadable' | 'unsupported';

export interface PasteOutcome {
  /** the images to attach, in clipboard order */
  attachments: Attachment[];
  /**
   * The first thing that went wrong, or null. ONE, not a list: the strip has
   * room for one line of explanation and a user who pasted a 40 MB screenshot
   * needs to be told that once, not four times.
   */
  rejected: AttachmentRejection | null;
}

/**
 * Every file on a clipboard (or a drop), in order — NOT just the images.
 *
 * The classification happens in `readImageAttachments`, on purpose: the
 * reference's paste handler takes every item whose `kind === "file"` and lets
 * the downstream classifier reject what it cannot use, with a visible message.
 * Filtering here instead would turn a pasted TIFF into a paste that does
 * nothing and says nothing, which is the outcome #163 taught us costs a bug
 * report.
 *
 * `DataTransfer.files` and not `.items`: a paste that carries both text and a
 * bitmap has an item per FLAVOUR (`text/plain`, `text/html`, `image/png`), and
 * `.files` is already the subset whose items are files. Reading `.items` and
 * filtering by `kind === 'file'` reaches the same list the long way round.
 */
export function filesFrom(dt: Pick<DataTransfer, 'files' | 'getData'>): File[] {
  return Array.from(dt.files ?? []);
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
    // clipboard we cannot ask about is treated as image-only, which at worst
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
 * files are named after.
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

/** Bytes -> "12 KB". Chip-sized, and never a fraction of a byte. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let counter = 0;

/**
 * Read the image files off a clipboard into attachments.
 *
 * `existing` is how many the draft already holds, so the cap is on the DRAFT
 * and not on the paste — four pastes of two images each has to stop in the same
 * place one paste of eight does.
 *
 * Nothing here throws: a clipboard is user input arriving at an input box, and
 * the composer's contract is that a paste it cannot use leaves the draft exactly
 * as it found it (fail-open, PHILOSOPHY §3).
 */
export async function readImageAttachments(
  files: File[],
  existing = 0,
  now: () => Date = () => new Date()
): Promise<PasteOutcome> {
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
    if (!isImageMediaType(mediaType)) {
      // the reference names the escape hatch rather than shrugging: an
      // unsupported file is referenced by absolute path in the prompt instead
      rejected ??= 'unsupported';
      continue;
    }
    // Cheap check first: the file's own size rules out the huge ones before we
    // spend a copy of them in memory encoding to base64.
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      rejected ??= 'too-large';
      continue;
    }
    let data: string;
    try {
      data = toBase64(await file.arrayBuffer());
    } catch {
      rejected ??= 'unreadable';
      continue;
    }
    if (data.length > MAX_IMAGE_BASE64_BYTES) {
      // the encoded length is what the API measures; the size check above is
      // an estimate of this one and a 4/3 ratio is not a guarantee
      rejected ??= 'too-large';
      continue;
    }
    attachments.push({
      id: `att-${++counter}`,
      name: file.name && file.name !== 'image.png' ? file.name : pastedImageName(mediaType, now()),
      mediaType,
      bytes: file.size,
      data,
    });
  }

  return { attachments, rejected };
}
