// What may be attached to a prompt, and how much of it (P2-E10-09, §5.10).
//
// In `shared/` because BOTH ends have to agree and neither may be the only one
// that checks. The renderer decides what a paste is allowed to become; main
// decides what it is allowed to put on the CLI's stdin. A renderer that gets it
// wrong — a bug, a future contribution point, a window that is not the one we
// think it is — must not be able to write an arbitrary blob onto the wire, and
// the only way that holds is if the rule has one definition and main enforces
// it independently rather than trusting the message it was handed.

/**
 * The media types an image block may carry.
 *
 * NOT ours to choose: this is the VS Code extension's own allow-list, read out
 * of its webview bundle (2.1.226) rather than guessed —
 *
 *   qit=["image/jpeg","image/png","image/gif","image/webp"]
 *   function Hbe(e,t){ if(qit.includes(e))return"image"; … }
 *
 * — reproduced in its order, because the contract is theirs and the affordance
 * is ours. Their classifier lower-cases the MIME before testing it
 * (`Git(e){ return Hbe(e.type.toLowerCase(), e.name) … }`) and so do we.
 *
 * (Their list also classifies `application/pdf` and text files as `document`
 * blocks — a different block type, arriving by drag & drop rather than off a
 * clipboard bitmap. That is #476, and this list grows there, not here.)
 */
export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export function isImageMediaType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type.toLowerCase());
}

/**
 * The most base64 one image may be — and a DELIBERATE DIVERGENCE from the
 * reference, called out here so nobody later reads it as parity.
 *
 * **The VS Code extension enforces no size limit at all.** That was measured,
 * not assumed: `maxImage`, `MAX_IMAGE`, `MAX_SIZE`, `downscale`, `toDataURL`,
 * `createImageBitmap`, `OffscreenCanvas` and `toBlob` all count ZERO across
 * both bundles, and every numeric candidate that looked like a cap turned out
 * to belong to Monaco or to an SVG path. It reads the file, base64s it, and
 * writes it on one NDJSON line to the CLI's stdin — a 10 MB screenshot becomes
 * a 13.3 MB line, and whatever happens next is the API's problem.
 *
 * We do not match that, for a reason the reference does not have: those bytes
 * cross an IPC boundary in OUR app. An unbounded paste is an unbounded
 * `invoke` payload and an unbounded string held in main, and "our breakage
 * never blocks a session" is a hard constraint here in a way it is not inside
 * a webview that can be reloaded.
 *
 * What we DO match is the part that instruction is really about: **no
 * downscaling, no re-encoding, no silent "helpful" transformation.** The bytes
 * the user pasted are the bytes the model is shown, or they are refused out
 * loud.
 *
 * The number is about where a single image stops being accepted upstream. It
 * is OUR ceiling, not a CLI contract we discovered — and if it is wrong it is
 * wrong in the safe direction: a clear refusal before a turn is spent, rather
 * than a silent one after.
 *
 * The ENCODED length decides, not the source file's byte count, because the
 * encoded length is what travels: base64 inflates by 4/3, so a 4 MB PNG is a
 * 5.4 MB block and would sail past a check that looked at 4 MB and shrugged.
 */
export const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

/** the source-file size that can still fit under it, for a cheap up-front check */
export const MAX_IMAGE_FILE_BYTES = Math.floor((MAX_IMAGE_BASE64_BYTES / 4) * 3);

/**
 * How many may ride one turn. The reference caps nothing here either; the
 * composer strip is one row of a prompt box, not an upload manager, and this
 * exists so a stuck paste key cannot build a 300 MB draft — not to express a
 * policy.
 */
export const MAX_ATTACHMENTS = 8;

/** An image on its way into a turn — base64 WITHOUT a `data:` prefix. */
export interface PromptImage {
  mediaType: ImageMediaType;
  data: string;
}

/** base64 and nothing else — no `data:` prefix, no whitespace, no newlines. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Main's own check on what the renderer asked it to send.
 *
 * Returns the images to send, or **null** meaning "refuse this submission
 * entirely". Null and not "send the text without them", deliberately: a prompt
 * that says "what's wrong with this screenshot?" is worse than useless once the
 * screenshot has been dropped, and the renderer's fallback path can only make a
 * sensible decision if it is told the whole thing was refused.
 *
 * Absent images are `[]`, not null — a plain text prompt is the overwhelmingly
 * common case and must not be able to trip this.
 */
export function sanitizePromptImages(value: unknown): PromptImage[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const out: PromptImage[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const { mediaType, data } = raw as { mediaType?: unknown; data?: unknown };
    if (typeof mediaType !== 'string' || typeof data !== 'string') return null;
    const type = mediaType.toLowerCase();
    if (!isImageMediaType(type)) return null;
    // Length before shape: the regex is linear but running it over an
    // unbounded string is the cost we are trying not to pay.
    if (data.length === 0 || data.length > MAX_IMAGE_BASE64_BYTES) return null;
    if (!BASE64.test(data)) return null;
    out.push({ mediaType: type, data });
  }
  return out;
}
