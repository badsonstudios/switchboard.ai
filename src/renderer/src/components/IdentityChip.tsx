// Identity chip (P1-E3-03, §5.11): the ONE way a session's identity renders —
// used verbatim in the rail rows and the card tab header so seven sessions
// read identically everywhere. Accent survives theme switches by design.
import React from 'react';

export function IdentityChip(props: {
  title: string;
  accent?: string;
  badge?: string;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minInlineSize: 0 }}>
      <span
        aria-hidden
        style={{
          inlineSize: 8,
          blockSize: 8,
          borderRadius: '50%',
          background: props.accent ?? 'var(--faint)',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: props.compact ? 11 : 12,
          fontWeight: 600,
          color: 'var(--text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {props.title}
      </span>
      {props.badge && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--muted)',
            background: 'var(--chip)',
            borderRadius: 4,
            paddingInline: 4,
            paddingBlock: 1,
            flexShrink: 0,
          }}
        >
          {props.badge}
        </span>
      )}
    </span>
  );
}
