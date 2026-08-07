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
import type { UpdateInstallStatus, UpdateStatus } from '../../../shared/update';
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

/**
 * Which "that didn't install" sentence to show (E19-04).
 *
 * Same register as the check failures above and for the same reason: nothing
 * here has cost the user anything. The one that is genuinely different is
 * `checksum` — it is the only case where something went wrong rather than
 * merely not working, and the message says so plainly without alarming anyone,
 * because the outcome (deleted, never run) is the SAFE one.
 */
function installFailureKey(reason: UpdateInstallStatus['reason']): string {
  switch (reason) {
    case 'checksum':
      return 'update.failedChecksum';
    case 'no-asset':
      return 'update.failedNoAsset';
    // Its own sentence, and the reason #315 exists: this box can outlive the
    // release it is describing, and saying "no installer we can verify" about a
    // release that is simply GONE is an accurate outcome with the wrong cause
    // attached — it sends the user to a page that may not be there either.
    case 'no-offer':
      return 'update.failedNoOffer';
    case 'unsupported':
      return 'update.failedUnsupported';
    case 'no-token':
      return 'update.failedNoToken';
    case 'auth':
      return 'update.failedAuth';
    case 'disk':
      return 'update.failedDisk';
    case 'launch':
      return 'update.failedLaunch';
    default:
      return 'update.failedNetwork';
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
  /**
   * Take the offer. With a verifiable installer on the release this downloads
   * and installs; without one it opens the release page (E19-04). The DIALOG
   * does not know which — App decides, because main is the side that knows
   * whether the release has an asset it will run.
   */
  onUpdate: () => void;
  /** open a URL in the browser: the fallback button, and links in the notes */
  onOpenUrl: (url: string) => void;
  /** not this run — nothing persisted */
  onIgnore: (version: string) => void;
  /** not this version, ever — persisted in the workspace */
  onSkip: (version: string) => void;
  /** how far the download/verify/install has got, when one is happening (E19-04) */
  install?: UpdateInstallStatus | null;
  onCancelInstall?: () => void;
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

  const install = props.install ?? null;
  // The three phases that OWN the dialog: while any of them is true the offer
  // is no longer a question, so the three buttons are gone and Escape does not
  // close (see the handler below) — dismissing a window mid-download would
  // leave a 120 MB transfer running with nothing on screen to stop it.
  const busy =
    install?.phase === 'downloading' ||
    install?.phase === 'verifying' ||
    install?.phase === 'launching';
  const failed = install?.phase === 'failed';

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const title = failed
    ? t('update.installFailedTitle')
    : available
      ? t('update.availableTitle', { version })
      : result.state === 'up-to-date'
        ? t('update.upToDateTitle')
        : t('update.unavailableTitle');

  return (
    <div
      onMouseDown={busy ? undefined : close} // click-away, same as About and the palette
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
        // The install's own state, so the e2e suite can wait on a PHASE rather
        // than on a sentence (E19-04). Absent when nothing is installing.
        data-update-phase={install?.phase}
        data-update-reason={install?.reason}
        // focusable CONTAINER, for the reason AboutPanel documents: clicking
        // the body must not strand focus on <body> and kill Escape, and the
        // release notes are text someone may want to select.
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation(); // the dialog owns its keys while open
          if (e.key === 'Escape') {
            e.preventDefault();
            // Not while a download is running: the only way out of that is
            // Cancel, which actually stops it. Escape here would hide the
            // transfer rather than end it.
            if (!busy) close();
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

        {busy ? (
          <InstallProgress status={install as UpdateInstallStatus} />
        ) : failed ? (
          <p
            data-update-field="message"
            style={{ margin: 0, padding: '14px', fontSize: 12.5, color: 'var(--muted)' }}
          >
            {t(installFailureKey(install?.reason))}
          </p>
        ) : available ? (
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
              onClick={interceptLink(props.onOpenUrl)}
              onAuxClick={interceptLink(props.onOpenUrl)}
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
          {busy ? (
            // ONE button while a transfer is running, and it is the one that
            // stops it. `launching` has nothing left to cancel — the installer
            // is already the OS's problem — so the row is simply empty there.
            install?.phase === 'launching' ? null : (
              <UpdateButton onClick={() => props.onCancelInstall?.()}>
                {t('update.cancel')}
              </UpdateButton>
            )
          ) : failed ? (
            <>
              {/* THE FALLBACK. Whatever went wrong — a checksum that did not
                  match most of all — the user is one click from the same
                  release page E19-03 sent them to, which is where they were
                  before one-click updates existed. */}
              {result.url && (
                <UpdateButton
                  primary
                  onClick={() => {
                    props.onOpenUrl(result.url as string);
                    close();
                  }}
                >
                  {t('update.openReleasePage')}
                </UpdateButton>
              )}
              <UpdateButton onClick={close}>{t('update.close')}</UpdateButton>
            </>
          ) : available ? (
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
              {/* Does NOT close: with an installer to fetch, this dialog
                  becomes the progress bar. App keeps it open until the install
                  reaches a terminal phase, and the browser fallback closes it
                  itself (there is nothing left to watch). */}
              <UpdateButton primary onClick={() => props.onUpdate()}>
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

/**
 * The download's own face (E19-04).
 *
 * A real `<progress>`, not a div with a width: it is announced as a progress
 * bar, it carries its own value, and it degrades to indeterminate by simply
 * having no `value` — which is exactly the case when the feed did not send a
 * Content-Length. Reproducing any of that by hand would be worse in every
 * theme and every screen reader.
 *
 * `aria-live="polite"` on the LABEL rather than the bar: a percentage read out
 * on every tick is unusable, but the three phase changes (downloading →
 * checking → installing) are the whole story and are worth hearing.
 */
function InstallProgress(props: { status: UpdateInstallStatus }): React.JSX.Element {
  const { t } = useTranslation();
  const { phase, received, total, version } = props.status;
  const determinate = phase === 'downloading' && total > 0;
  const percent = determinate ? Math.min(100, Math.round((received / total) * 100)) : 0;
  const label =
    phase === 'verifying'
      ? t('update.verifying')
      : phase === 'launching'
        ? t('update.launching')
        : determinate
          ? t('update.downloadingPercent', { version, percent })
          : t('update.downloading', { version });

  return (
    <div style={{ padding: '14px' }}>
      <p
        data-update-field="progress"
        aria-live="polite"
        style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text)' }}
      >
        {label}
      </p>
      {phase !== 'launching' && (
        <progress
          data-update-field="bar"
          // Undefined, not 0: an omitted `value` is what makes it
          // indeterminate, and 0 would render a permanently empty bar during
          // the verify pass.
          value={determinate ? percent : undefined}
          max={100}
          aria-label={label}
          style={{ inlineSize: '100%', blockSize: 6 }}
        />
      )}
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
