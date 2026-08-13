// Phone push + webhook setup (P2-E14-06, §5.9 + §5.29).
//
// The one surface where a user hands the app a credential, so it is worth
// saying what it deliberately does NOT do:
//
// - **It never shows a stored credential.** There is no channel that can read
//   one back (`main/events/push-ipc.ts`), so every field is empty on open and a
//   saved slot reads "set". Changing one means pasting the new value; there is
//   nothing to edit in place. That is the cost of keeping the secret out of the
//   renderer, and it is the right one.
// - **It is not a settings screen.** E14 has no settings story yet, and this
//   item is not the place to invent one — this is a modal reached from the
//   command palette and from the About panel (which already collects the app's
//   outbound-network switches). When the settings screen lands, these controls
//   move into it and this file goes away.
//
// The dialog shape — scrim, click-away, focus capture, Escape, `dialogAbove` —
// is `AboutPanel.tsx`'s, on purpose: two modals that behave differently is a
// bug report waiting to happen.
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  PushConfig,
  PushSecretKey,
  PushSendResult,
  PushService,
} from '../../../shared/push';

export interface PushSetupDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * null only for the frame before main answers. A bridge that CANNOT answer
   * sends `unavailablePushConfig()` instead, so "we have not asked yet" and
   * "there is nothing to ask" are different states on screen rather than the
   * same empty form.
   */
  config: PushConfig | null;
  /**
   * The last write main refused, and which field it was aimed at. The dialog
   * cannot read a credential back, so a refusal it did not render would leave
   * the user with an empty box and no idea whether the paste landed.
   */
  write?: { key: string; problem: string } | null;
  onSetPrefs: (patch: { push?: boolean; webhook?: boolean; service?: PushService; ntfyServer?: string }) => void;
  /** store one credential; an empty string forgets it */
  onSetSecret: (key: PushSecretKey, value: string) => void;
  onTest: (channel: 'push' | 'webhook') => Promise<PushSendResult>;
}

export function PushSetupDialog(props: PushSetupDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [testing, setTesting] = React.useState<'push' | 'webhook' | null>(null);
  const [results, setResults] = React.useState<Record<string, PushSendResult>>({});

  React.useEffect(() => {
    if (!props.open) return;
    // A re-open starts clean: a half-typed token left in the box from last time
    // is a token on screen for no reason.
    setDrafts({});
    setResults({});
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
  }, [props.open]);

  /**
   * Keep focus inside the dialog when a control DISABLES itself under the
   * user's cursor — Save empties its own field, Send test greys out while it
   * sends. The browser strands focus on `<body>` when that happens, and from
   * there Escape reaches nothing: the key handler is on the container, and
   * `<body>` is outside it. Found by the e2e, not by reading the code.
   *
   * Deliberately narrow — it acts only when focus is on `body` (or gone), never
   * when it is on something real.
   */
  React.useEffect(() => {
    if (!props.open) return;
    const active = document.activeElement;
    if (!active || active === document.body) dialog.current?.focus();
  });

  if (!props.open) return null;

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const cfg = props.config;
  const prefs = cfg?.prefs;
  const available = cfg?.storeAvailable !== false;
  const isSet = (key: PushSecretKey): boolean => cfg?.secrets?.[key] === true;

  const save = (key: PushSecretKey): void => {
    const value = drafts[key] ?? '';
    if (!value.trim()) return;
    props.onSetSecret(key, value);
    // Cleared the instant it is handed over: the value is now main's, and the
    // renderer holding a second copy in component state is exactly the thing
    // this design is avoiding.
    setDrafts((d) => ({ ...d, [key]: '' }));
  };

  const runTest = (channel: 'push' | 'webhook'): void => {
    setTesting(channel);
    void props
      .onTest(channel)
      .then((r) => setResults((s) => ({ ...s, [channel]: r })))
      .catch(() => setResults((s) => ({ ...s, [channel]: { ok: false, reason: 'network' } })))
      .finally(() => setTesting(null));
  };

  const service: PushService = prefs?.service ?? 'ntfy';

  const secretRow = (key: PushSecretKey, label: string, hint?: string): React.JSX.Element => (
    <div style={{ display: 'grid', gap: 4 }}>
      <label
        htmlFor={`push-field-${key}`}
        style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', gap: 8 }}
      >
        {label}
        <span data-push-status={key} style={{ color: isSet(key) ? 'var(--text)' : 'var(--faint)' }}>
          {isSet(key) ? t('push.set') : t('push.notSet')}
        </span>
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          id={`push-field-${key}`}
          data-push-field={key}
          // A password field: this is a credential, and the person setting it up
          // may well be sharing their screen while they do it.
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={!available}
          value={drafts[key] ?? ''}
          onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save(key);
            }
          }}
          style={{
            flex: 1,
            background: 'var(--panel2)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 8px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
          }}
        />
        <DialogButton onClick={() => save(key)} disabled={!available || !(drafts[key] ?? '').trim()}>
          {t('push.save')}
        </DialogButton>
        {isSet(key) && (
          <DialogButton onClick={() => props.onSetSecret(key, '')}>{t('push.forget')}</DialogButton>
        )}
      </div>
      {props.write?.key === key && (
        <span
          data-push-problem={key}
          style={{ fontSize: 11, color: 'var(--status-needs-input-ink)' }}
        >
          {t(`push.problem.${props.write.problem}`)}
        </span>
      )}
      {hint && <span style={{ fontSize: 11, color: 'var(--faint)' }}>{hint}</span>}
    </div>
  );

  const testRow = (channel: 'push' | 'webhook'): React.JSX.Element => {
    const r = results[channel];
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <DialogButton onClick={() => runTest(channel)} disabled={!available || testing !== null}>
          {testing === channel ? t('push.testing') : t('push.sendTest')}
        </DialogButton>
        {r && (
          <span
            data-push-result={channel}
            style={{
              fontSize: 11.5,
              color: r.ok ? 'var(--text)' : 'var(--status-needs-input-ink)',
            }}
          >
            {r.ok
              ? t('push.testOk')
              : t('push.testFailed', { reason: t(`push.reason.${r.reason ?? 'network'}`) })}
            {/* The service's own complaint — "application token is invalid"
                beats "the service turned it down" when you are trying to get
                set up. Scrubbed of every stored credential in main before it
                is allowed this far (`push.ts`), which is what makes showing it
                safe on a screen someone may be sharing. */}
            {!r.ok && r.detail ? ` ${t('push.detail', { detail: r.detail })}` : ''}
          </span>
        )}
      </div>
    );
  };

  return (
    <div
      onMouseDown={close}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '10vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('push.title')}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
        style={{
          inlineSize: 'min(520px, 94vw)',
          maxBlockSize: '80vh',
          overflowY: 'auto',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
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
          {t('push.title')}
        </div>
        <p style={{ margin: 0, padding: '10px 14px 0', fontSize: 11.5, color: 'var(--muted)' }}>
          {t('push.intro')}
        </p>
        {!available && (
          <p
            data-push-field="unavailable"
            style={{
              margin: 0,
              padding: '8px 14px 0',
              fontSize: 11.5,
              color: 'var(--status-needs-input-ink)',
            }}
          >
            {t('push.unavailable')}
          </p>
        )}

        {/* ── phone push ───────────────────────────────────────────────── */}
        <section style={{ display: 'grid', gap: 9, padding: '12px 14px' }}>
          <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>{t('push.sectionPush')}</h2>
          <div role="radiogroup" aria-label={t('push.service')} style={{ display: 'flex', gap: 12 }}>
            {(['ntfy', 'pushover'] as const).map((s) => (
              <label
                key={s}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5 }}
              >
                <input
                  type="radio"
                  name="push-service"
                  data-push-field={`service.${s}`}
                  checked={service === s}
                  disabled={!available}
                  onChange={() => props.onSetPrefs({ service: s })}
                />
                {t(`push.service_${s}`)}
              </label>
            ))}
          </div>
          {service === 'ntfy'
            ? (
                <>
                  {secretRow('ntfy.topic', t('push.ntfyTopic'), t('push.ntfyTopicHint'))}
                  {/* Not a secret and not stored like one: a server address is
                      the one field here that belongs in the workspace file. */}
                  <div style={{ display: 'grid', gap: 4 }}>
                    <label
                      htmlFor="push-field-ntfy-server"
                      style={{ fontSize: 11.5, color: 'var(--muted)' }}
                    >
                      {t('push.ntfyServer')}
                    </label>
                    <input
                      id="push-field-ntfy-server"
                      data-push-field="ntfy-server"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={!available}
                      placeholder="https://ntfy.sh"
                      value={drafts['ntfyServer'] ?? prefs?.ntfyServer ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, ntfyServer: e.target.value }))}
                      onBlur={(e) => props.onSetPrefs({ ntfyServer: e.target.value.trim() })}
                      style={{
                        background: 'var(--panel2)',
                        color: 'var(--text)',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: '4px 8px',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11.5,
                      }}
                    />
                    {props.write?.key === 'ntfyServer' && (
                      <span
                        data-push-problem="ntfyServer"
                        style={{ fontSize: 11, color: 'var(--status-needs-input-ink)' }}
                      >
                        {t(`push.problem.${props.write.problem}`)}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                      {t('push.ntfyServerHint')}
                    </span>
                  </div>
                </>
              )
            : (
                <>
                  {secretRow('pushover.token', t('push.pushoverToken'))}
                  {secretRow('pushover.user', t('push.pushoverUser'))}
                </>
              )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
            <input
              type="checkbox"
              data-push-field="enable-push"
              checked={prefs?.push === true}
              disabled={!available}
              onChange={(e) => props.onSetPrefs({ push: e.target.checked })}
            />
            {t('push.enablePush')}
          </label>
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t('push.enablePushHint')}</span>
          {testRow('push')}
        </section>

        {/* ── webhook ──────────────────────────────────────────────────── */}
        <section
          style={{
            display: 'grid',
            gap: 9,
            padding: '12px 14px',
            borderBlockStart: '1px solid var(--border)',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600 }}>{t('push.sectionWebhook')}</h2>
          {secretRow('webhook.url', t('push.webhookUrl'), t('push.webhookUrlHint'))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
            <input
              type="checkbox"
              data-push-field="enable-webhook"
              checked={prefs?.webhook === true}
              disabled={!available}
              onChange={(e) => props.onSetPrefs({ webhook: e.target.checked })}
            />
            {t('push.enableWebhook')}
          </label>
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t('push.enableWebhookHint')}</span>
          {testRow('webhook')}
        </section>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t('push.secretNote')}</span>
          <DialogButton onClick={close}>{t('push.close')}</DialogButton>
        </div>
      </div>
    </div>
  );
}

function DialogButton(props: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        background: 'var(--chip)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-chip)',
        padding: '4px 12px',
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.55 : 1,
        fontFamily: 'var(--font-ui)',
        fontSize: 11.5,
      }}
    >
      {props.children}
    </button>
  );
}
