// One AI's icon (E40 item 10, #1293) — the bare mark, no ring, no status.
//
// Its own file so every surface that names an AI draws it the same way: the
// session badge (`AiBadge`), the status bar's list of AIs, and the Settings →
// AIs tab (#1292).
//
// DECORATION, always (`aria-hidden`, `alt=""`): whatever this sits in says the
// AI's name in words — the badge's `aria-label`, the status bar's text.
//
// FAIL-OPEN (PHILOSOPHY §4): an AI with no icon, or an icon that does not load,
// is a neutral tile with the AI's initial. The letter is drawn by CSS from
// `data-initial` (`.ai-icon[data-initial]::before`, tokens.css) rather than as
// a text node, so a tab's or a row's `textContent` — which e2e specs read as
// the session's name — never gains a stray letter.
import React from 'react';
import type { AiLook } from '../lib/ais-store';

export function AiIcon(props: { look: AiLook; size: number }): React.JSX.Element {
  const { look, size } = props;
  // which URL failed, not a bare flag: a list that later names a NEW icon for
  // this AI gets a fresh try
  const [failed, setFailed] = React.useState<string | null>(null);
  const showImg = look.iconUrl !== undefined && failed !== look.iconUrl;
  return showImg ? (
    <img
      aria-hidden
      alt=""
      className="ai-icon"
      data-ai-icon="img"
      src={look.iconUrl}
      width={size}
      height={size}
      draggable={false}
      onError={() => setFailed(look.iconUrl ?? null)}
      style={{ inlineSize: size, blockSize: size, flexShrink: 0, display: 'block', objectFit: 'contain' }}
    />
  ) : (
    <span
      aria-hidden
      className="ai-icon"
      data-ai-icon="initial"
      data-initial={look.initial}
      style={{
        inlineSize: size,
        blockSize: size,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 3,
        background: 'var(--chip)',
        color: 'var(--text)',
        fontFamily: 'var(--font-ui)',
        fontWeight: 700,
        fontSize: Math.max(7, Math.round(size * 0.7)),
        lineHeight: 1,
      }}
    />
  );
}
