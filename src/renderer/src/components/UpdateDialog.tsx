// The "there's a new release" dialog (P2-E19-03, plan §E19).
//
// Modelled on AboutPanel, deliberately and down to the details: role=dialog,
// Escape and click-away, focus returned where it came from, and it joins App's
// `modalOpenRef` latch so nothing underneath it hears a keystroke. Two modal
// shells that behave differently is how a user learns not to trust either.
//
// It has THREE faces, because a manual check has to say something whatever the
// answer was:
//   • available   — version, notes, and Update / Ignore / Skip this version
//   • up to date  — one line, and a Close button
//   • couldn't    — the gentle non-error. NOT an error dialog: a failed update
//                   check has cost the user nothing, and dressing it up as a
//                   failure is how a fail-open feature starts feeling broken.
//
// Only a manual check ever opens the last two. Automatic checks are silent
// unless there is genuinely something to offer (the item's done-when).
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { UpdateStatus } from '../../../shared/update';
import { Markdown } from '../lib/markdown';

/**
 * Which "couldn't check" sentence to show.
 *
 * The checker goes to real trouble to tell a missing credential apart from an
 * unreachable host (§E19 decision 5 is the whole reason the endpoint is what it
 * is), and dropping that distinction here would waste it at the one place a
 * human ever looks. On a private repo, "no credentials" is the LIKELY case on
 * any machine but the maintainer's, and "try again later" is wrong advice for
 * it.
 *
 * Every variant stays in the same gentle register: nothing here is the user's
 * fault, and nothing here is broken.
 */
function unavailableKey(reason: UpdateStatus['result']['reason']): string {
  switch (reason) {
    case 'no-token':
      return 'update.unavailableNoToken';
    case 'auth':
      return 'update.unavailableAuth';
    case 'rate-limit':
      return 'update.unavailableRateLimit';
    default:
      return 'update.unavailableBody';
  }
}

/** Swallow a click on an anchor inside the notes and hand its href to main. */
function interceptLink(open: (url: string) => void) {
  return (e: React.MouseEvent): void => {
    const href = (e.target as HTMLElement | null)?.closest?.('a')?.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    open(href);
  };
}

export function UpdateDialog(props: {
  open: boolean;
  status: UpdateStatus | null;
  onClose: () => void;
  /** open the release page in the browser (E19-04 replaces this with a download) */
  onUpdate: (url: string) => void;
  /** not this run — nothing persisted */
  onIgnore: (version: string) => void;
  /** not this version, ever — persisted in the workspace */
  onSkip: (version: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const dialog = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!props.open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

  if (!props.open || !props.status) return null;

  const { result } = props.status;
  const version = result.latestVersion ?? '';
  const available = result.state === 'available' && !!version;

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const title = available
    ? t('update.availableTitle', { version })
    : result.state === 'up-to-date'
      ? t('update.upToDateTitle')
      : t('update.unavailableTitle');

  return (
    <div
      onMouseDown={close} // click-away, same as About and the palette
      style={{
        position: 'fixed',
        inset: 0,
        // above About: the manual check is reachable FROM the About panel, and
        // the answer must land in front of the panel that asked for it
        zIndex: 60,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '12vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-update-state={result.state}
        // focusable CONTAINER, for the reason AboutPanel documents: clicking
        // the body must not strand focus on <body> and kill Escape, and the
        // release notes are text someone may want to select.
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation(); // the dialog owns its keys while open
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        style={{
          inlineSize: 'min(560px, 92vw)',
          maxBlockSize: '76vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          overflow: 'hidden',
          outline: 'none',
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
          {title}
        </div>

        {available ? (
          <>
            <p
              data-update-field="from"
              style={{ margin: 0, padding: '10px 14px 0', fontSize: 12, color: 'var(--muted)' }}
            >
              {t('update.runningVersion', { version: result.currentVersion })}
            </p>
            <div
              // The notes are the payload: they scroll, the dialog does not.
              style={{ padding: '8px 14px 12px', overflowY: 'auto', minBlockSize: 0, flex: 1 }}
              // A link in a release body must not NAVIGATE this window — that
              // would replace the whole app with a web page. Intercepted here
              // and handed to main, which refuses anything that is not an https
              // GitHub URL.
              //
              // `onAuxClick` as well as `onClick`: Chromium dispatches
              // `auxclick`, not `click`, for the middle button, so a
              // middle-click would otherwise miss this handler entirely and
              // fall through to main's much broader any-http(s) window-open
              // rule.
              onClick={interceptLink(props.onUpdate)}
              onAuxClick={interceptLink(props.onUpdate)}
            >
              {result.notes ? (
                <Markdown text={result.notes} />
              ) : (
                <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
                  {t('update.noNotes')}
                </p>
              )}
            </div>
          </>
        ) : (
          <p
            data-update-field="message"
            style={{ margin: 0, padding: '14px', fontSize: 12.5, color: 'var(--muted)' }}
          >
            {result.state === 'up-to-date'
              ? t('update.upToDateBody', { version: result.currentVersion })
              : t(unavailableKey(result.reason))}
          </p>
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
          {available ? (
            <>
              <UpdateButton
                onClick={() => {
                  props.onSkip(version);
                  close();
                }}
              >
                {t('update.skip')}
              </UpdateButton>
              <UpdateButton
                onClick={() => {
                  props.onIgnore(version);
                  close();
                }}
              >
                {t('update.ignore')}
              </UpdateButton>
              <UpdateButton
                primary
                onClick={() => {
                  if (result.url) props.onUpdate(result.url);
                  close();
                }}
              >
                {t('update.update')}
              </UpdateButton>
            </>
          ) : (
            <UpdateButton onClick={close}>{t('update.close')}</UpdateButton>
          )}
        </div>
      </div>
    </div>
  );
}

function UpdateButton(props: {
  onClick: () => void;
  primary?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      style={{
        background: props.primary ? 'var(--btn-primary-bg)' : 'var(--chip)',
        color: props.primary ? 'var(--btn-primary-text)' : 'var(--text)',
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
