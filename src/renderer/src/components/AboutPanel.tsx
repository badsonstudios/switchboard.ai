// About / build info (P2-E15-15). The "which build am I running?" surface: a
// hand-tester opens it from the title-bar stamp or the palette and gets the
// release version, the commit that built, the branch, whether the tree was
// dirty, and — the field that actually catches a stale `out/` — how old the
// build is.
//
// Rendering only. What the fields MEAN lives in shared/build-identity.ts
// (pure, tested, shared with main's window title) so the two can never drift.
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  BuildIdentity,
  buildAge,
  commitStamp,
  isReleaseBuild,
} from '../../../shared/build-identity';

export function AboutPanel(props: {
  open: boolean;
  onClose: () => void;
  /** package.json semver — the human-bumped release number */
  version: string;
  identity: BuildIdentity;
  platform: string;
  /**
   * Update checking (P2-E19-03). Optional so the panel still renders in a test
   * that only cares about build identity — and so a broken preload bridge
   * costs the About panel nothing, which is the fail-open rule this whole
   * feature is built on.
   */
  onCheckForUpdates?: () => void;
  autoCheck?: boolean;
  onToggleAutoCheck?: (on: boolean) => void;
  /**
   * Provider status polling (P2-E14-07, §5.14). It lives beside the update
   * toggle for one reason: those two are the only outbound network calls this
   * app makes, and a user who wants to know that — or wants them off — should
   * find both in the same place rather than one here and one nowhere.
   * Optional, like the update pair, so a broken bridge costs the panel nothing.
   */
  statusPolling?: boolean;
  onToggleStatusPolling?: (on: boolean) => void;
  /**
   * Another modal is stacked ON TOP of this one (the update dialog, which is
   * reachable from here). Two nested `aria-modal="true"` regions is a case
   * screen readers handle inconsistently, so the panel underneath stops
   * claiming to be the modal while it is not the one in front.
   */
  dialogAbove?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const dialog = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!props.open) return;
    setCopied(false); // a re-open must not still be boasting about the last copy
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

  if (!props.open) return null;

  const stamp = commitStamp(props.identity);
  const age = buildAge(props.identity.builtAt);
  const unknown = t('about.unknown');

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  // One block of plain text, because the destination is usually a bug report or
  // a chat message to whoever asked "which build?". Clipboard access can be
  // refused (it is a permission, and the popout path has bitten us before), so
  // the failure is swallowed — the same facts are on screen either way.
  //
  // Deliberately NOT translated, unlike everything rendered above it: this is a
  // diagnostic payload aimed at whoever maintains the app, and a bug report
  // that says "unbekannt" is harder to triage, not easier. §5.21 governs what
  // the USER reads.
  const copy = (): void => {
    const lines = [
      `switchboard ${props.version}`,
      `commit: ${stamp ?? 'unknown'}`,
      `branch: ${props.identity.branch ?? 'detached'}`,
      `built:  ${props.identity.builtAt ?? 'unknown'}`,
      `platform: ${props.platform}`,
    ].join('\n');
    void navigator.clipboard
      ?.writeText(lines)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  const rows: Array<{ key: string; label: string; value: string; mono?: boolean }> = [
    { key: 'version', label: t('about.version'), value: props.version },
    { key: 'commit', label: t('about.commit'), value: stamp ?? unknown, mono: true },
    { key: 'branch', label: t('about.branch'), value: props.identity.branch ?? t('about.detached'), mono: true },
    {
      key: 'builtAt',
      label: t('about.builtAt'),
      value: props.identity.builtAt
        ? new Date(props.identity.builtAt).toLocaleString()
        : unknown,
    },
    {
      key: 'age',
      label: t('about.buildAge'),
      // `ageValue.*` rather than nesting under `about.age`: i18next cannot have
      // a key that is both a string and a namespace.
      value: age ? t(`about.ageValue.${age.unit}`, { n: age.value }) : unknown,
    },
    { key: 'platform', label: t('about.platform'), value: props.platform },
  ];

  return (
    <div
      onMouseDown={close} // click-away, same as the palette
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '14vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal={props.dialogAbove ? undefined : 'true'}
        aria-label={t('about.title')}
        // tabIndex, not a preventDefault on mousedown: clicking the panel's
        // body must not strand focus on <body>, or Escape would go dead the
        // moment you clicked anything. A focusable CONTAINER catches focus for
        // its non-focusable children while leaving the text selectable — and
        // the whole point of this panel is data someone may want to select.
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // the dialog owns its keys while open — nothing underneath may fire
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        style={{
          inlineSize: 'min(460px, 92vw)',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          overflow: 'hidden',
          outline: 'none', // the container is focusable for key handling, not as a control
        }}
      >
        <div
          style={{
            padding: '11px 14px',
            borderBlockEnd: '1px solid var(--border)',
            background: 'var(--panel2)',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {t('about.title')}
        </div>
        <dl
          style={{
            margin: 0,
            padding: '12px 14px',
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            columnGap: 14,
            rowGap: 7,
            fontSize: 12.5,
          }}
        >
          {rows.map((r) => (
            <React.Fragment key={r.key}>
              <dt style={{ color: 'var(--muted)' }}>{r.label}</dt>
              <dd
                data-about-field={r.key}
                style={{
                  margin: 0,
                  fontFamily: r.mono ? 'var(--font-mono)' : 'var(--font-ui)',
                  overflowWrap: 'anywhere',
                }}
              >
                {r.value}
              </dd>
            </React.Fragment>
          ))}
        </dl>
        {/* The two states worth calling out rather than leaving the reader to
            infer from a '*' — a dirty tree means the SHA does not describe what
            was built, and a non-main branch is the whole reason this exists. */}
        {props.identity.dirty && (
          <p
            style={{
              margin: 0,
              padding: '0 14px 10px',
              fontSize: 11.5,
              // amber, borrowed from the needs-input status ink: the only
              // "heads up, but nothing is broken" hue the token set defines
              color: 'var(--status-needs-input-ink)',
            }}
          >
            {t('about.dirtyNote')}
          </p>
        )}
        {!props.identity.dirty && !isReleaseBuild(props.identity) && props.identity.branch && (
          <p style={{ margin: 0, padding: '0 14px 10px', fontSize: 11.5, color: 'var(--muted)' }}>
            {t('about.branchNote', { branch: props.identity.branch })}
          </p>
        )}
        {/* Update checking lives here because About is already the "which
            build am I on?" surface, and "is there a newer one?" is the very
            next question (P2-E19-03). The toggle sits beside the button rather
            than in a settings screen that does not exist. */}
        {props.onCheckForUpdates && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              padding: '10px 14px',
              borderBlockStart: '1px solid var(--border)',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11.5,
                color: 'var(--muted)',
                cursor: props.onToggleAutoCheck ? 'pointer' : 'default',
              }}
            >
              <input
                type="checkbox"
                data-about-field="autoCheck"
                checked={props.autoCheck !== false}
                disabled={!props.onToggleAutoCheck}
                onChange={(e) => props.onToggleAutoCheck?.(e.target.checked)}
              />
              {t('about.autoCheck')}
            </label>
            <AboutButton onClick={props.onCheckForUpdates}>{t('about.checkForUpdates')}</AboutButton>
          </div>
        )}
        {props.onToggleStatusPolling && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              borderBlockStart: '1px solid var(--border)',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11.5,
                color: 'var(--muted)',
                cursor: 'pointer',
              }}
              title={t('health.settingHint')}
            >
              <input
                type="checkbox"
                data-about-field="statusPolling"
                checked={props.statusPolling !== false}
                onChange={(e) => props.onToggleStatusPolling?.(e.target.checked)}
              />
              {t('health.setting')}
            </label>
          </div>
        )}
        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
          }}
        >
          <AboutButton onClick={copy}>{copied ? t('about.copied') : t('about.copy')}</AboutButton>
          <AboutButton onClick={close}>{t('about.close')}</AboutButton>
        </div>
      </div>
    </div>
  );
}

function AboutButton(props: {
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      style={{
        background: 'var(--chip)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-chip)',
        padding: '4px 12px',
        cursor: 'pointer',
        fontFamily: 'var(--font-ui)',
        fontSize: 11.5,
      }}
    >
      {props.children}
    </button>
  );
}
