// What may be attached to a prompt, and how much of it (P2-E10-09/10, §5.10).
//
// In `shared/` because BOTH ends have to agree and neither may be the only one
// that checks. The renderer decides what a paste or a drop is allowed to
// become; main decides what it is allowed to put on the CLI's stdin. A renderer
// that gets it wrong — a bug, a future contribution point, a window that is not
// the one we think it is — must not be able to write an arbitrary blob onto the
// wire, and the only way that holds is if the rule has one definition and main
// enforces it independently rather than trusting the message it was handed.
//
// NAMED `prompt-attachments` SINCE #476: it was `prompt-images` when the only
// thing that could ride a prompt was a pasted bitmap. Drag & drop brought text
// files and PDFs, which are a DIFFERENT block type (`document`, not `image`),
// and a file called `prompt-images` holding the rule for a `.md` file is how
// the next reader learns the wrong thing first.

/**
 * The three things a file can become, plus the refusal. The reference's own
 * classification, not a shape of ours — see `classifyAttachment`.
 */
export type AttachmentKind = 'image' | 'text' | 'pdf';

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
 */
export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export function isImageMediaType(type: string): type is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(type.toLowerCase());
}

/** The one media type that becomes a base64 `document` block. */
export const PDF_MEDIA_TYPE = 'application/pdf';

/**
 * Non-`text/*` media types that are nevertheless text (the reference's `Kit`).
 *
 * Verbatim from the 2.1.226 webview bundle. `application/json` is the reason
 * this list has to exist at all: Windows reports `.json` as `application/json`,
 * so a MIME-prefix test alone would refuse the single most likely file anyone
 * drags onto a coding agent.
 */
export const TEXT_MEDIA_TYPES: readonly string[] = [
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-javascript',
  'application/x-typescript',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/x-shellscript',
  'application/sql',
  'application/graphql',
  'application/toml',
  'application/x-toml',
];

/**
 * Filename extensions that mean "text" when the MIME does not say so (the
 * reference's `Bbe`), verbatim from the same bundle and in its order.
 *
 * This list carries the weight in practice: the OS hands most source files over
 * with an EMPTY `type`, so `.ts`, `.rs` and `.py` are recognised by their
 * extension or not at all. It doubles as a set of whole FILE NAMES — that is
 * how extensionless `Makefile`, `Dockerfile` and `.gitignore` are accepted, and
 * it is deliberate in the original rather than a coincidence we are copying.
 */
export const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config', 'env', 'properties',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyw', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs', 'fs', 'fsx', 'swift', 'php', 'pl', 'pm',
  'lua', 'r', 'jl', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'cljc', 'elm', 'hs',
  'ml', 'mli', 'v', 'sv', 'vhd', 'vhdl', 'asm', 's',
  'html', 'htm', 'xhtml', 'xml', 'svg', 'css', 'scss', 'sass', 'less',
  'vue', 'svelte', 'astro',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'bat', 'cmd',
  'csv', 'tsv', 'sql', 'graphql', 'gql', 'prisma',
  'md', 'mdx', 'markdown', 'rst', 'txt', 'text', 'rtf', 'tex', 'latex', 'org',
  'adoc', 'asciidoc',
  'makefile', 'cmake', 'gradle', 'dockerfile', 'containerfile', 'vagrantfile',
  'rakefile', 'gemfile', 'podfile', 'fastfile', 'brewfile', 'procfile',
  'lock', 'sum', 'log', 'diff', 'patch',
  'gitignore', 'gitattributes', 'editorconfig', 'prettierrc', 'eslintrc',
  'babelrc', 'npmrc', 'nvmrc', 'yarnrc',
]);

/**
 * Extensionless names that mean text (the reference's six hardcoded ones).
 *
 * `LICENSE` and `README` with no extension are the two files most likely to be
 * dragged out of a repository root, which is presumably why they were spelled
 * out rather than left to the extension set.
 */
export const TEXT_BARE_NAMES: readonly string[] = [
  'license',
  'readme',
  'changelog',
  'authors',
  'contributors',
  'copying',
];

/**
 * Is this file text? A faithful port of the reference's `Zit(mime, name)`:
 *
 *   function Zit(e,t){
 *     if(e.startsWith("text/"))return!0;
 *     if(Kit.includes(e))return!0;
 *     let i=t.split(".").pop()?.toLowerCase(); if(i&&Bbe.has(i))return!0;
 *     let n=t.toLowerCase();
 *     if(Bbe.has(n)||n==="license"||n==="readme"||…)return!0;
 *     return!1 }
 *
 * FOUR checks, first match wins, MIME BEFORE FILENAME. The order matters and is
 * not interchangeable: a `.txt` file the OS typed as `text/plain` is settled by
 * check 1 without the extension set ever being consulted, and — the case that
 * actually bites — a file with NO extension and no MIME falls all the way to
 * check 4, which is the only one that can accept it.
 *
 * Note `"noext".split(".").pop()` is `"noext"`, so check 3 already sees a bare
 * name; check 4 is not redundant with it because check 4 also matches the six
 * names above, and because a name like `my.notes` reaches check 4 with the
 * whole string rather than just the tail.
 */
export function isTextAttachment(mediaType: string, fileName: string): boolean {
  const mime = mediaType.toLowerCase();
  if (mime.startsWith('text/')) return true;
  if (TEXT_MEDIA_TYPES.includes(mime)) return true;
  const name = fileName.toLowerCase();
  const ext = name.split('.').pop();
  if (ext && TEXT_FILE_EXTENSIONS.has(ext)) return true;
  return TEXT_FILE_EXTENSIONS.has(name) || TEXT_BARE_NAMES.includes(name);
}

/**
 * What a dropped or pasted file becomes — the reference's `Hbe(mime, name)`:
 *
 *   function Hbe(e,t){ if(qit.includes(e))return"image";
 *                      if(e==="application/pdf")return"pdf";
 *                      if(Zit(e,t))return"text"; return"unsupported" }
 *
 * IMAGES FIRST, and by MIME ONLY. That is why a `.png` renamed to `.dat` is
 * still an image (the OS still types it) while a `.dat` full of PNG bytes is
 * not — and why `svg` sitting in the text extension set is not a contradiction:
 * an SVG arrives as `image/svg+xml`, which is not in the image allow-list, so
 * it falls through to `isTextAttachment` and is sent as its own source code.
 * That is the reference's behaviour and it is a good one — the model can read
 * SVG far better than it could read a rasterised version of it.
 */
export function classifyAttachment(
  mediaType: string,
  fileName: string
): AttachmentKind | 'unsupported' {
  const mime = mediaType.toLowerCase();
  if (isImageMediaType(mime)) return 'image';
  if (mime === PDF_MEDIA_TYPE) return 'pdf';
  if (isTextAttachment(mime, fileName)) return 'text';
  return 'unsupported';
}

/**
 * The most one attachment may put on the wire — and a DELIBERATE DIVERGENCE
 * from the reference, called out here so nobody later reads it as parity.
 *
 * **The VS Code extension enforces no size limit at all**, on any type. That
 * was measured twice, not assumed: for images in #475 (`maxImage`, `MAX_IMAGE`,
 * `MAX_SIZE`, `downscale`, `toDataURL`, `createImageBitmap`, `OffscreenCanvas`,
 * `toBlob` all ZERO across both bundles) and again narrowly for text in #476
 * (`readAsText`, `MAX_CHARS`, `MAX_LENGTH`, `file.size` all ZERO in the
 * webview; every `.size>` hit is a `Set`/`Map`). It reads the file, encodes it,
 * and writes it on one NDJSON line to the CLI's stdin — a 50 MB `.log` becomes
 * a 50 MB line, and whatever happens next is the API's problem. The only
 * truncation anywhere on that path is 50,000 characters applied to the TYPED
 * PROMPT, never to an attachment.
 *
 * We do not match that, for a reason the reference does not have: those bytes
 * cross an IPC boundary in OUR app. An unbounded attachment is an unbounded
 * `invoke` payload and an unbounded string held in main, and "our breakage
 * never blocks a session" is a hard constraint here in a way it is not inside
 * a webview that can be reloaded.
 *
 * What we DO match is the part that instruction is really about: **no
 * downscaling, no re-encoding, no truncation, no silent "helpful"
 * transformation.** The bytes the user attached are the bytes the model is
 * shown, or they are refused out loud.
 *
 * ONE number for all three kinds, applied to WHAT TRAVELS — the base64 length
 * for an image or a PDF, the UTF-8 byte length for text. Not the source file's
 * size: base64 inflates by 4/3, so a 4 MB PNG is a 5.4 MB block and would sail
 * past a check that looked at 4 MB and shrugged.
 */
export const MAX_ATTACHMENT_PAYLOAD_BYTES = 5 * 1024 * 1024;

/**
 * The source-file size that can still fit under it once base64'd, for a cheap
 * up-front check on the kinds that get encoded. Text is not encoded, so text is
 * measured against `MAX_ATTACHMENT_PAYLOAD_BYTES` directly.
 */
export const MAX_ENCODED_FILE_BYTES = Math.floor((MAX_ATTACHMENT_PAYLOAD_BYTES / 4) * 3);

/**
 * How many may ride one turn. The reference caps nothing here either; the
 * composer strip is one row of a prompt box, not an upload manager, and this
 * exists so a stuck paste key or a dropped folder's worth of files cannot build
 * a 300 MB draft — not to express a policy.
 */
export const MAX_ATTACHMENTS = 8;

/**
 * Something on its way into a turn.
 *
 * A DISCRIMINATED UNION rather than three arrays, because ORDER ACROSS KINDS is
 * part of the contract: the reference pushes attachments in the order the user
 * gave them and only then the typed prompt, so "look at the diagram and the log
 * next to it" has to arrive with the diagram and the log in that order. Three
 * arrays cannot express that, and re-deriving it at the far end is guesswork.
 */
export type PromptAttachment =
  /** base64, WITHOUT a `data:` prefix */
  | { kind: 'image'; mediaType: ImageMediaType; data: string }
  /** base64, WITHOUT a `data:` prefix */
  | { kind: 'pdf'; title: string; data: string }
  /** the DECODED file contents — plain text, not base64. See `userMessage`. */
  | { kind: 'text'; title: string; text: string };

/**
 * base64 and nothing else — no `data:` prefix, no whitespace, no newlines.
 *
 * The LENGTH check beside it matters as much as the alphabet: base64 encodes
 * three bytes into four characters, so a payload whose length is not a
 * multiple of four is malformed however valid its characters are.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64.test(value);
}

/** UTF-8 byte length of a string — what a text attachment actually costs. */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * A title main is willing to put on the wire.
 *
 * The reference sends `c.file.name` — the bare `File.name`, never a path
 * (`webkitRelativePath` counts ZERO in both bundles). We hold it to that: a
 * title is a LABEL, and letting a renderer put `../../etc/passwd` or a 4 KB
 * string in a field the model reads is a needless seam. Any separator means the
 * value did not come from `File.name` and the submission is refused.
 */
const MAX_TITLE_LENGTH = 255;

function isCleanTitle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TITLE_LENGTH &&
    !value.includes('/') &&
    !value.includes('\\') &&
    // control characters have no business in a label and are how a payload
    // smuggles a newline into something that gets rendered
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * Main's own check on what the renderer asked it to send.
 *
 * Returns the attachments to send, or **null** meaning "refuse this submission
 * entirely". Null and not "send the text without them", deliberately: a prompt
 * that says "what's wrong with this screenshot?" is worse than useless once the
 * screenshot has been dropped, and the renderer's fallback path can only make a
 * sensible decision if it is told the whole thing was refused.
 *
 * Absent attachments are `[]`, not null — a plain text prompt is the
 * overwhelmingly common case and must not be able to trip this.
 */
export function sanitizePromptAttachments(value: unknown): PromptAttachment[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const out: PromptAttachment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const { kind, mediaType, data, text, title } = raw as Record<string, unknown>;
    if (kind === 'image') {
      if (typeof mediaType !== 'string' || typeof data !== 'string') return null;
      const type = mediaType.toLowerCase();
      if (!isImageMediaType(type)) return null;
      // Length before shape: the regex is linear but running it over an
      // unbounded string is the cost we are trying not to pay.
      if (data.length === 0 || data.length > MAX_ATTACHMENT_PAYLOAD_BYTES) return null;
      if (!isBase64(data)) return null;
      out.push({ kind: 'image', mediaType: type, data });
    } else if (kind === 'pdf') {
      if (typeof data !== 'string' || !isCleanTitle(title)) return null;
      if (data.length === 0 || data.length > MAX_ATTACHMENT_PAYLOAD_BYTES) return null;
      if (!isBase64(data)) return null;
      out.push({ kind: 'pdf', title, data });
    } else if (kind === 'text') {
      if (typeof text !== 'string' || !isCleanTitle(title)) return null;
      // An EMPTY text attachment is refused rather than sent as an empty
      // document block. The reference would send it (nothing guards a 0-byte
      // file there), but a block that says "here is the file" and carries
      // nothing is worse than no block: it is indistinguishable, to the model,
      // from a file that genuinely is empty, and the far more likely cause is
      // that we failed to read it.
      if (text.length === 0) return null;
      // The cheap character check first, then the real UTF-8 cost. A string
      // cannot be more than 3 bytes per UTF-16 unit in UTF-8, so anything under
      // a third of the ceiling is provably fine without encoding it.
      if (text.length > MAX_ATTACHMENT_PAYLOAD_BYTES) return null;
      if (
        text.length > MAX_ATTACHMENT_PAYLOAD_BYTES / 3 &&
        utf8Bytes(text) > MAX_ATTACHMENT_PAYLOAD_BYTES
      )
        return null;
      out.push({ kind: 'text', title, text });
    } else {
      return null;
    }
  }
  return out;
}
