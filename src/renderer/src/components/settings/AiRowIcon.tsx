// An AI's mark on the AIs tab and in the Add-an-AI list (E40 item 09, #1292).
//
// A tile with the SHARED `AiIcon` inside it (#1323's follow-up, folded into
// #1326): the mark is drawn in the AI's own colour, exactly as on its tab, rail
// card and header, and an AI with no mark (a "Something else" entry, a test
// fake) or one whose file does not load gets its initial instead, so every row
// keeps the same shape. The SVGs ship in the renderer's own `public/ai-icons/`
// (#1291), so the URL is our own origin: the CSP allows no `data:` or remote
// image.
//
// DECORATIVE: the name is always written beside it, so the tile is
// `aria-hidden`.
import React from 'react';
import { AiIcon } from '../AiIcon';

export function AiRowIcon(props: { src?: string; name: string; ink?: string; size?: number }): React.JSX.Element {
  const size = props.size ?? 24;
  return (
    <span
      aria-hidden="true"
      data-ai-row-icon
      style={{
        inlineSize: size,
        blockSize: size,
        flex: 'none',
        borderRadius: 6,
        background: 'var(--chip)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AiIcon
        look={{
          name: props.name,
          ...(props.src ? { iconUrl: props.src } : {}),
          ...(props.ink ? { ink: props.ink } : {}),
          initial: (props.name.trim()[0] ?? '?').toUpperCase(),
        }}
        size={size - 6}
      />
    </span>
  );
}
