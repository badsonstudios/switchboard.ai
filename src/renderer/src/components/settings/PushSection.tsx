// Phone push + webhook setup (P2-E14-06, §5.9 + §5.29).
//
// This was `PushSetupDialog.tsx` until #885, and that file said what would
// happen to it: "it is not a settings screen … when the settings screen lands,
// these controls move into it and this file goes away." It has. The modal
// chrome is `SettingsDialog.tsx`'s now; what is here is the control and the
// promises it makes about credentials.
//
// The one surface where a user hands the app a credential, so it is worth
// saying what it deliberately does NOT do:
//
// - **It never shows a stored credential.** There is no channel that can read
//   one back (`main/events/push-ipc.ts`), so every field is empty on open and a
//   saved slot reads "set". Changing one means pasting the new value; there is
//   nothing to edit in place. That is the cost of keeping the secret out of the
//   renderer, and it is the right one.
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  PushConfig,
  PushSecretKey,
  PushSendResult,
  PushService,
} from '../../../../shared/push';
import { SettingItem, SettingsButton, itemListStyle } from './controls';

export interface PushSectionProps {
  /** whether the settings modal is open — the section only mounts while it is */
  open: boolean;
  /**
   * null only for the frame before main answers. A bridge that CANNOT answer
   * sends `unavailablePushConfig()` instead, so "we have not asked yet" and
   * "there is nothing to ask" are different states on screen rather than the
   * same empty form.
   */
  config: PushConfig | null;
  /**
   * The last write main refused, and which field it was aimed at. The section
   * cannot read a credential back, so a refusal it did not render would leave
   * the user with an empty box and no idea whether the paste landed.
   */
  write?: { key: string; problem: string } | null;
  onSetPrefs: (patch: { push?: boolean; webhook?: boolean; service?: PushService; ntfyServer?: string }) => void;
  /** store one credential; an empty string forgets it */
  onSetSecret: (key: PushSecretKey, value: string) => void;
  onTest: (channel: 'push' | 'webhook') => Promise<PushSendResult>;
}

export function PushSection(props: PushSectionProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const container = React.useRef<HTMLDivElement | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [testing, setTesting] = React.useState<'push' | 'webhook' | null>(null);
  const [results, setResults] = React.useState<Record<string, PushSendResult>>({});

  /**
   * The prefix for every `id` in this section (#654). A HOOK, so it lives up
   * here with the others and above the `props.open` early return.
   *
   * These fields used to be `id="push-field-ntfy.topic"` and friends — LITERAL,
   * STABLE and therefore GUESSABLE, which is only a problem because this app
   * renders markdown from files and replies it did not write. `id` survives the
   * sanitizer profile (it is an ordinary member of DOMPurify's allow-list, and
   * `ALLOW_DATA_ATTR: false` does not reach it), and an `id` is a NAME the rest
   * of the document can address:
   *
   *  - `<label for="push-field-ntfy.topic">` in a reply is a SECOND label on
   *    this input — it forwards a click to it, and its words join the field's
   *    accessible name. `markdown.tsx` forbids `<label>` at the profile, which
   *    is where that half is settled, for every surface at once.
   *  - THE HALF A TAG LIST CANNOT SETTLE: content planting the SAME id EARLIER
   *    IN TREE ORDER takes this section's own label away from its own field.
   *    `<label for>` binds to the FIRST element with that id, and a
   *    `<span id="push-field-…">` is not labelable — so the association
   *    silently becomes NOTHING and the credential field loses its accessible
   *    name. Verified in Chromium 149 (`label.control` → `null`,
   *    `input.labels` → empty), not reasoned about.
   *
   * WHAT THAT SECOND BULLET IS WORTH HERE, stated rather than implied because
   * "earlier in tree order" is a real condition and not a formality: `App.tsx`
   * renders THE SETTINGS MODAL BEFORE `SessionGrid`, so feed and viewer content
   * is always LATER and never captured these ids. This is prophylaxis against a
   * reorder, not the fix for a live capture — the one live pairing in the app is
   * `UpdateDialog` ahead of `CommandPalette`, and it is `markdown.tsx` that
   * carries the full argument.
   *
   * `React.useId()` is what the rest of the renderer already uses (QuestionPanel,
   * EventsPanel, FindBar). Alone it is NOT a secret — React 19 numbers client
   * ids from a module-global counter — so what it removes is a STABLE,
   * PUBLISHED name, not the possibility of a collision; since #673 the root's
   * per-launch `identifierPrefix` closes that half too. `data-push-field` stays
   * as it is: it is the test hook, it is not an `id`, and content cannot emit a
   * `data-*` attribute at all (`ALLOW_DATA_ATTR: false`).
   */
  const fieldId = React.useId();

  React.useEffect(() => {
    if (!props.open) return;
    // A re-open starts clean: a half-typed token left in the box from last time
    // is a token on screen for no reason.
    setDrafts({});
    setResults({});
  }, [props.open]);

  /**
   * Keep focus inside the modal when a control DISABLES itself under the
   * user's cursor — Save empties its own field, Send test greys out while it
   * sends. The browser strands focus on `<body>` when that happens, and from
   * there Escape reaches nothing: the key handler is on the modal container,
   * and `<body>` is outside it. Found by the e2e, not by reading the code.
   *
   * RESCUED TO THIS SECTION rather than to the modal, which is where the
   * equivalent effect lived while this was its own dialog. It has to be: the
   * disabling is driven by state local to THIS component, so a parent effect
   * with no dependency list would not re-run at all — the parent does not
   * re-render. Focus inside the section is inside the modal, and keydown
   * bubbles, so Escape still reaches the container that handles it.
   *
   * Deliberately narrow, in THREE ways, and the second and third were bought
   * with a bug found in review:
   *
   *  - it acts only when focus is on `body` (or gone), never when it is on
   *    something real;
   *  - **never on the first commit.** `<body>` is exactly where focus IS when
   *    the modal mounts from the palette (`CommandPalette` deliberately does not
   *    restore focus — "the command decides where focus belongs") or from
   *    `Mod+,`. React flushes child effects before the parent's, so this ran
   *    BEFORE `SettingsDialog` had focused itself, won the race, and the modal
   *    opened scrolled down to the credential fields. Measured, not reasoned
   *    about: the focus events arrive `["push", "dialog"]`. The three palette
   *    aliases hid it, because their `scrollIntoView` runs afterwards and papers
   *    over it — so the two most common ways in were the two that broke;
   *  - **`preventScroll`.** `focus()` scrolls its element into view inside the
   *    nearest scroller, and the nearest scroller here is the whole modal. The
   *    rescue's job is to keep Escape working, not to move the page.
   */
  const rescued = React.useRef(false);
  React.useEffect(() => {
    if (!props.open) return;
    const first = !rescued.current;
    rescued.current = true;
    if (first) return;
    const active = document.activeElement;
    if (!active || active === document.body) container.current?.focus({ preventScroll: true });
  });

  if (!props.open) return null;

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
        htmlFor={`${fieldId}f-${key}`}
        style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', gap: 8 }}
      >
        {label}
        <span data-push-status={key} style={{ color: isSet(key) ? 'var(--text)' : 'var(--faint)' }}>
          {isSet(key) ? t('push.set') : t('push.notSet')}
        </span>
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          id={`${fieldId}f-${key}`}
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
        <SettingsButton onClick={() => save(key)} disabled={!available || !(drafts[key] ?? '').trim()}>
          {t('push.save')}
        </SettingsButton>
        {isSet(key) && (
          <SettingsButton onClick={() => props.onSetSecret(key, '')}>
            {t('push.forget')}
          </SettingsButton>
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
        <SettingsButton onClick={() => runTest(channel)} disabled={!available || testing !== null}>
          {testing === channel ? t('push.testing') : t('push.sendTest')}
        </SettingsButton>
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
      ref={container}
      data-settings-block="push"
      // Focusable for the rescue above, not as a control — see that effect.
      tabIndex={-1}
      style={{ ...itemListStyle, outline: 'none' }}
    >
      {!available && (
        <p
          data-push-field="unavailable"
          style={{ margin: 0, fontSize: 11.5, color: 'var(--status-needs-input-ink)' }}
        >
          {t('push.unavailable')}
        </p>
      )}

      {/* ── phone push ───────────────────────────────────────────────── */}
      <SettingItem item="push" label={t('push.sectionPush')} blurb={t('push.intro')}>
        <div style={{ display: 'grid', gap: 9 }}>
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
                      htmlFor={`${fieldId}f-ntfy-server`}
                      style={{ fontSize: 11.5, color: 'var(--muted)' }}
                    >
                      {t('push.ntfyServer')}
                    </label>
                    <input
                      id={`${fieldId}f-ntfy-server`}
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
        </div>
      </SettingItem>

      {/* ── webhook ──────────────────────────────────────────────────── */}
      <SettingItem item="webhook" label={t('push.sectionWebhook')}>
        <div style={{ display: 'grid', gap: 9 }}>
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
        </div>
      </SettingItem>

      <span style={{ fontSize: 11, color: 'var(--faint)' }}>{t('push.secretNote')}</span>
    </div>
  );
}
