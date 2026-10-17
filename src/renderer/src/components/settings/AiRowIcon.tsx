// An AI's mark on the AIs tab and in the Add-an-AI list (E40 item 09, #1292).
//
// The SVGs ship in the renderer's own `public/ai-icons/` (#1291), so this is a
// plain `<img>` from our own origin: the CSP allows no `data:` or remote image.
// An AI with no mark (a "Something else" entry, a test fake) gets its initial
// on a tile instead, so every row keeps the same shape.
//
// DECORATIVE: the name is always written beside it, so the image is `alt=""`
// and the tile `aria-hidden`.
import React from 'react';

export function AiRowIcon(props: { src?: string; name: string; size?: number }): React.JSX.Element {
  const size = props.size ?? 24;
  const [broken, setBroken] = React.useState(false);
  const tile: React.CSSProperties = {
    inlineSize: size,
    blockSize: size,
    flex: 'none',
    borderRadius: 6,
    background: 'var(--chip)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
  if (props.src && !broken) {
    return (
      <span style={tile} aria-hidden="true">
        <img
          src={props.src}
          alt=""
          width={size - 6}
          height={size - 6}
          onError={() => setBroken(true)}
          style={{ display: 'block' }}
        />
      </span>
    );
  }
  const initial = props.name.trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      data-ai-icon-fallback
      style={{ ...tile, fontSize: Math.round(size * 0.5), fontWeight: 700, color: 'var(--muted)' }}
    >
      {initial}
    </span>
  );
}
