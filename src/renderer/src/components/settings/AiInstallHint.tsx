// How to install one AI (E40 item 09, #1292): the maker's command in a box
// with Copy, or a button to the maker's page. Shared by the AIs tab and the
// Add-an-AI list, so the two can never say different things. It SHOWS how;
// nothing here installs anything (host, don't reimplement).
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { InstallHint } from '../../../../shared/ais';

/** The small button the AI rows use. */
export const smallButton: React.CSSProperties = {
  background: 'var(--chip)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-chip)',
  padding: '2px 8px',
  cursor: 'pointer',
  fontFamily: 'var(--font-ui)',
  fontSize: 11,
};

/** A link out to an AI maker's install page: the house `openExternal`, never a raw anchor. */
export function openInstallPage(url: string): void {
  const files = (globalThis as { switchboard?: { files?: { openExternal?: (u: string) => Promise<boolean> } } })
    .switchboard?.files;
  void files?.openExternal?.(url)?.catch(() => undefined);
}

/**
 * How to install one AI: a command to copy, or the maker's page. Shared by the
 * tab and the Add-an-AI list, so the two can never say different things.
 */
export function InstallHintView(props: { hint: InstallHint; name: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  // "Copied" goes back to "Copy" after a moment, so a second copy can be seen to happen
  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (props.hint.kind === 'link') {
    const url = props.hint.url;
    return (
      <span data-ai-install="link" style={{ display: 'inline-flex' }}>
        <button
          type="button"
          aria-label={t('ais.howToInstallLabel', { name: props.name })}
          title={url}
          onClick={() => openInstallPage(url)}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'var(--link)',
            textDecoration: 'underline',
            cursor: 'pointer',
            fontFamily: 'var(--font-ui)',
            fontSize: 11.5,
          }}
        >
          {t('ais.howToInstall')}
        </button>
      </span>
    );
  }
  const command = props.hint.command;
  return (
    <span data-ai-install="command" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <code
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          padding: '2px 6px',
          borderRadius: 4,
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          userSelect: 'text',
        }}
      >
        {command}
      </code>
      <button
        type="button"
        aria-label={t('ais.copyLabel', { name: props.name })}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        style={smallButton}
      >
        {copied ? t('ais.copied') : t('ais.copy')}
      </button>
    </span>
  );
}
