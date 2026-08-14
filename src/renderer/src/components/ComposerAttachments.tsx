// The strip of things riding along with the next prompt (P2-E10-09, §5.10).
//
// Its own file rather than another hundred lines in `FeedView.tsx`, because
// #476 (drag & drop files into the composer) lands on exactly this strip: a
// dropped file becomes the same `Attachment` and the only thing that changes is
// where the chip's name came from.
//
// WHY THE PREVIEW IS PAINTED ONTO A CANVAS AND NOT PUT IN AN `<img src>`
// ---------------------------------------------------------------------
// Our CSP is `default-src 'self'` with no `img-src` (`shared/csp.ts`), so an
// `<img>` pointing at a `data:` or `blob:` URL is REFUSED — that is not an
// oversight, it is the same policy §5.30 leans on to stop a markdown file
// fetching a tracking pixel, and `document-render.ts` already accepts a chip
// instead of an image for exactly this reason.
//
// A canvas is not subject to it at all: `createImageBitmap` decodes BYTES WE
// ALREADY HOLD and `drawImage` paints them. Nothing is fetched, no URL exists,
// and the strictest security setting in the app keeps its value. So the user
// sees the picture they pasted AND the policy stays where §5.30 put it.
//
// The paint is best-effort. jsdom has no 2D context and a decode can fail, so
// the chip — icon, name, size, remove button — is the thing that must always be
// there and the pixels are a bonus on top of it.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Attachment, formatBytes } from '../lib/composer-attachments';

/** the square the preview is drawn into, in CSS px */
const THUMB = 28;

/**
 * Paint `data` into the canvas, cover-cropped to a square.
 *
 * Cancels on unmount via a captured flag: an attachment removed while its
 * bitmap is still decoding must not paint into a canvas React has detached.
 */
function useThumbnail(
  data: string,
  mediaType: string
): React.RefObject<HTMLCanvasElement | null> {
  const ref = React.useRef<HTMLCanvasElement | null>(null);
  React.useEffect(() => {
    let live = true;
    const canvas = ref.current;
    // jsdom has no canvas backend — depending on the build it answers null or
    // THROWS "not implemented" — and a real engine can refuse a context too.
    // All of those mean "no pixels", which the chip survives; none of them may
    // take the composer down with them (fail-open, PHILOSOPHY §3).
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas?.getContext?.('2d') ?? null;
    } catch {
      ctx = null;
    }
    if (!canvas || !ctx) return;
    void (async () => {
      try {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: mediaType }));
        if (!live) {
          bitmap.close();
          return;
        }
        const dpr = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
        canvas.width = Math.round(THUMB * dpr);
        canvas.height = Math.round(THUMB * dpr);
        // cover: the shorter side fills the square, the longer one is cropped
        // evenly at both ends — a 4000x100 banner should still read as a thin
        // strip of itself, not as a 4000px-wide sliver of its left edge
        const side = Math.min(bitmap.width, bitmap.height);
        ctx.drawImage(
          bitmap,
          (bitmap.width - side) / 2,
          (bitmap.height - side) / 2,
          side,
          side,
          0,
          0,
          canvas.width,
          canvas.height
        );
        bitmap.close();
      } catch {
        // an undecodable attachment keeps its chip and loses its picture
      }
    })();
    return () => {
      live = false;
    };
  }, [data, mediaType]);
  return ref;
}

/**
 * The square at the head of the chip.
 *
 * An IMAGE gets its own pixels — that is the whole reason the canvas dance
 * above exists. A text file or a PDF has no pixels to show, so it gets a glyph
 * instead: rendering a page of source into a 28px square would be a smudge, and
 * the useful signal at this size is "this is a text file", which two letters
 * carry better than a thumbnail would.
 */
function AttachmentIcon({ attachment }: { attachment: Attachment }): React.JSX.Element {
  const box: React.CSSProperties = {
    inlineSize: THUMB,
    blockSize: THUMB,
    borderRadius: 4,
    background: 'var(--chip)',
    flexShrink: 0,
  };
  // The union is what makes this safe: `data` only exists on the two kinds that
  // have bytes to decode, so the canvas cannot be handed a text file's contents.
  if (attachment.kind === 'image')
    return <ImageThumbnail data={attachment.data} mediaType={attachment.mediaType} style={box} />;
  return (
    <span
      aria-hidden="true"
      data-attachment-icon={attachment.kind}
      style={{
        ...box,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        color: 'var(--muted)',
      }}
    >
      {attachment.kind === 'pdf' ? 'PDF' : 'TXT'}
    </span>
  );
}

function ImageThumbnail({
  data,
  mediaType,
  style,
}: {
  data: string;
  mediaType: string;
  style: React.CSSProperties;
}): React.JSX.Element {
  const canvas = useThumbnail(data, mediaType);
  return <canvas ref={canvas} aria-hidden="true" style={style} />;
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const label = `${attachment.name} · ${formatBytes(attachment.bytes)}`;
  return (
    <span
      data-composer-attachment={attachment.name}
      data-attachment-kind={attachment.kind}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxInlineSize: 200,
        padding: '2px 4px 2px 2px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-chip)',
        background: 'var(--panel)',
      }}
    >
      <AttachmentIcon attachment={attachment} />
      <span
        style={{
          fontSize: 10,
          color: 'var(--muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minInlineSize: 0,
        }}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('feedView.attach.remove', { name: attachment.name })}
        title={t('feedView.attach.remove', { name: attachment.name })}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--faint)',
          cursor: 'pointer',
          fontSize: 11,
          lineHeight: 1,
          padding: '2px 3px',
          flexShrink: 0,
        }}
      >
        {t('feedView.attach.removeIcon')}
      </button>
    </span>
  );
}

/**
 * Out of flow entirely, so the always-mounted live region below costs the
 * composer no height and no flex gap when it has nothing to say.
 *
 * Not `display:none` and not `hidden`: either one takes the region out of the
 * accessibility tree, which defeats the whole point of mounting it early.
 */
const SILENT: React.CSSProperties = {
  position: 'absolute',
  inlineSize: 1,
  blockSize: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
};

/**
 * Everything attached to the next prompt, plus the one line of explanation a
 * refused paste is owed.
 *
 * A FRAGMENT, not a wrapper: both halves are direct children of the composer's
 * own root, and the chip row is only there when there are chips. That is the
 * half of "must not fight the height clamp" that belongs here — a composer
 * with nothing attached is exactly the composer that shipped in #406. (The
 * other half is `FeedView`'s: the strip lives INSIDE the composer's root, so
 * `roomForBox` counts it as chrome and the textarea re-measures against the
 * room actually left.)
 */
export function ComposerAttachments({
  attachments,
  notice,
  onRemove,
}: {
  attachments: Attachment[];
  notice: string | null;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {attachments.length > 0 && (
        <div
          role="group"
          aria-label={t('feedView.attach.label')}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}
        >
          {attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} onRemove={() => onRemove(a.id)} />
          ))}
        </div>
      )}
      {/* A refused paste is news the user has to be able to READ, not a console
          line: they pressed Ctrl+V and nothing appeared, which is
          indistinguishable from the app ignoring them (#163's lesson).

          MOUNTED EMPTY on the first frame, the rule #222 set for `FindBar`'s
          count: a live region that arrives already holding its text is
          announced by almost nothing. So this element always exists and only
          its styling changes — which is also why it is `position:absolute`
          while silent, so an empty region cannot put a flex gap between the
          composer and the box. */}
      <div
        role="status"
        aria-live="polite"
        data-composer-attach-notice=""
        style={notice ? { fontSize: 10, color: 'var(--muted)' } : SILENT}
      >
        {notice ?? ''}
      </div>
    </>
  );
}
