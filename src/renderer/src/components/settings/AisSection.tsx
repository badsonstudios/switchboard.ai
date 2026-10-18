// Settings → AIs (E40 item 09, #1292; `mockups/multi-ai.html` screen 4).
//
// WHAT IT SHOWS: which AI new sessions start on, every AI found on this
// computer with its own login state and version, the known ones that are not
// here with how to install them, "Look again", and "+ Add an AI…".
//
// THE RULES IT KEEPS (design record §6, PHILOSOPHY §4):
// - **Host, don't reimplement.** Install = show the maker's command or page;
//   nothing here installs anything. Log in = the AI's OWN sign-in, run by main
//   (`ais:login`); there is no credential field anywhere on this screen, and
//   for an AI whose sign-in belongs in a terminal (Claude) the button says so
//   in that AI's words.
// - **Honest about what is not known.** Detection runs after first paint, so a
//   row with no answer yet says "checking…", never "not found"; an AI that did
//   not answer in time says it could not tell, with the reason; a version or a
//   login state it did not report says "unknown". Every state is written in
//   words, so none is colour only.
// - **Fail-open.** A call that fails keeps the last snapshot on screen with a
//   notice (`lib/ais-store.ts`); the tab is never blank because of an IPC
//   failure.
//
// It talks ONLY to `switchboard.ais` (and `files.openExternal` for an install
// page). Nothing here imports from `providers/`.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../../shared/ipc/refusal';
import { errorText } from '../../../../shared/error-text';
import type { AiLoginResult, AisSnapshot } from '../../../../shared/ais';
import {
  acceptAisDefault,
  acceptAisSnapshot,
  aisBridge,
  getAisView,
  noteAisFailure,
  startAis,
  subscribeAis,
} from '../../lib/ais-store';
import { aiName, presenceOf, splitAis, type AiRowView } from '../../lib/ais-view';
import { SettingItem, SettingsButton } from './controls';
import { AiRowIcon } from './AiRowIcon';
import { AddAiDialog } from './AddAiDialog';
import { InstallHintView, smallButton } from './AiInstallHint';

/** The muted, wrapping line under a row's name. */
const detailStyle: React.CSSProperties = { fontSize: 11, color: 'var(--muted)', overflowWrap: 'anywhere' };

function Tag(props: { children: React.ReactNode; strong?: boolean }): React.JSX.Element {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 400,
        border: `1px solid ${props.strong ? 'var(--link)' : 'var(--border)'}`,
        color: props.strong ? 'var(--link)' : 'var(--muted)',
        borderRadius: 10,
        padding: '0 7px',
      }}
    >
      {props.children}
    </span>
  );
}

interface LoginState {
  busy: boolean;
  message?: string;
  methods?: string[];
}

/** One login answer, as the words under the row. */
function loginMessage(r: AiLoginResult, t: (k: string, o?: Record<string, unknown>) => string): LoginState {
  if (!r.supported) return { busy: false, message: r.reason || t('ais.loginFailedNoReason') };
  if (r.ok === true) return { busy: false, message: t('ais.loginDone') };
  if (r.methods && r.methods.length > 0) return { busy: false, methods: r.methods };
  return { busy: false, message: r.reason ? t('ais.loginFailed', { reason: r.reason }) : t('ais.loginFailedNoReason') };
}

/** The status words for one row: presence, login, version. */
function statusParts(row: AiRowView, t: (k: string, o?: Record<string, unknown>) => string): React.ReactNode[] {
  const d = row.detection;
  const presence = presenceOf(d);
  if (presence === 'checking') return [<span key="p">{t('ais.checking')}</span>];
  if (presence === 'missing') return [<span key="p">{t('ais.missing')}</span>];
  if (presence === 'unknown') {
    return [<span key="p">{d?.detail ? t('ais.unknownWhy', { detail: d.detail }) : t('ais.unknown')}</span>];
  }
  const parts: React.ReactNode[] = [];
  if (d?.login === 'logged-in') {
    parts.push(
      <span key="l" data-ai-login="logged-in" style={{ color: 'var(--status-done-ink)' }}>
        {d.account ? t('ais.loggedInAs', { account: d.account }) : t('ais.loggedIn')}
      </span>
    );
    if (d.plan) parts.push(<span key="plan">{d.plan}</span>);
  } else if (d?.login === 'logged-out') {
    parts.push(
      <span key="l" data-ai-login="logged-out" style={{ color: 'var(--text)' }}>
        {t('ais.notLoggedIn')}
      </span>
    );
  } else {
    parts.push(
      <span key="l" data-ai-login="unknown">
        {t('ais.loginUnknown')}
      </span>
    );
  }
  parts.push(
    <span key="v" data-ai-version style={d?.version ? { fontFamily: 'var(--font-mono)' } : undefined}>
      {d?.version ? t('ais.version', { version: d.version }) : t('ais.versionUnknown')}
    </span>
  );
  return parts;
}

/** between the parts of a status line; hidden from a screen reader, which pauses on the spans */
const SEP = ' · ';

function joined(parts: React.ReactNode[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(<span key={`s${i}`} aria-hidden="true">{SEP}</span>);
    out.push(p);
  });
  return out;
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--panel2)',
};

function AiRow(props: {
  row: AiRowView;
  found: boolean;
  login: LoginState | undefined;
  onMakeDefault: (id: string) => void;
  onLogin: (row: AiRowView, method?: string) => void;
  onRemove: (row: AiRowView) => Promise<boolean>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { row } = props;
  const [confirming, setConfirming] = React.useState(false);
  const [removeFailed, setRemoveFailed] = React.useState(false);
  const removing = React.useRef(false);
  const presence = presenceOf(row.detection);
  // Make default REMOVES the button that was pressed (the default has none), so
  // focus is put on the row instead of falling to <body>: out of the dialog,
  // where Escape no longer reaches it.
  const self = React.useRef<HTMLDivElement | null>(null);
  const canLogIn = !!row.providerId && row.detection?.login === 'logged-out';
  // The inline Remove confirm takes the keyboard to its safe answer, and Keep
  // gives it back to Remove: each press hides the button that had it.
  const keepButton = React.useRef<HTMLButtonElement | null>(null);
  const removeButton = React.useRef<HTMLButtonElement | null>(null);
  const asked = React.useRef(false);
  React.useEffect(() => {
    if (confirming) {
      asked.current = true;
      keepButton.current?.focus();
    } else if (asked.current) {
      removeButton.current?.focus();
    }
  }, [confirming]);
  return (
    <div
      ref={self}
      tabIndex={-1}
      role="group"
      aria-label={row.name}
      data-ai-row={row.key}
      data-ai-presence={presence}
      data-ai-probed={row.detection?.probedAt}
      style={rowStyle}
    >
      <AiRowIcon {...(row.iconSrc ? { src: row.iconSrc } : {})} {...(row.ink ? { ink: row.ink } : {})} name={row.name} />
      <div style={{ flex: '1 1 auto', minInlineSize: 0, display: 'grid', gap: 3 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{row.name}</span>
          {row.maker && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{row.maker}</span>}
          {row.isDefault && <Tag strong>{t('ais.tagDefault')}</Tag>}
          {row.kind === 'custom' && <Tag>{t('ais.tagCustom')}</Tag>}
          {row.runsLocalModels && <Tag>{t('ais.tagLocal')}</Tag>}
        </div>
        <div data-ai-status style={detailStyle}>
          {joined(statusParts(row, t))}
        </div>
        {props.found && !row.providerId && <div style={detailStyle}>{t('ais.cannotRun')}</div>}
        {presence !== 'installed' && row.install && (
          <div>
            <InstallHintView hint={row.install} name={row.name} />
          </div>
        )}
        {props.login?.busy && (
          <div role="status" style={detailStyle}>
            {t('ais.loggingIn')}
          </div>
        )}
        {props.login?.message && (
          <div role="status" data-ai-login-message style={{ ...detailStyle, color: 'var(--text)' }}>
            {props.login.message}
          </div>
        )}
        {props.login?.methods && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={detailStyle}>{t('ais.loginPickMethod')}</span>
            {props.login.methods.map((m) => (
              <button
                key={m}
                type="button"
                style={smallButton}
                onClick={() => {
                  self.current?.focus();
                  props.onLogin(row, m);
                }}
              >
                {m}
              </button>
            ))}
          </div>
        )}
        {confirming && (
          <div data-ai-remove-confirm style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <span style={{ ...detailStyle, color: 'var(--text)' }}>{t('ais.removeConfirm', { name: row.name })}</span>
            <button
              type="button"
              style={smallButton}
              onClick={() => {
                // on success this row goes away; the section takes the keyboard
                if (removing.current) return;
                removing.current = true;
                void props.onRemove(row).then((ok) => {
                  removing.current = false;
                  setRemoveFailed(!ok);
                });
              }}
            >
              {t('ais.removeYes')}
            </button>
            <button ref={keepButton} type="button" style={smallButton} onClick={() => setConfirming(false)}>
              {t('ais.removeNo')}
            </button>
          </div>
        )}
        {removeFailed && (
          <div role="status" style={detailStyle}>
            {t('ais.removeFailed')}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flex: 'none', alignItems: 'center' }}>
        {row.providerId && !row.isDefault && (
          <button
            type="button"
            style={smallButton}
            onClick={() => {
              self.current?.focus();
              props.onMakeDefault(row.providerId!);
            }}
          >
            {t('ais.makeDefault')}
          </button>
        )}
        {canLogIn && (
          <button
            type="button"
            style={{ ...smallButton, borderColor: 'var(--link)', color: 'var(--link)' }}
            // not disabled while busy (it would drop the focus); a second press is a no-op,
            // and the row takes the keyboard because a finished sign-in removes the button
            onClick={() => {
              self.current?.focus();
              props.onLogin(row);
            }}
          >
            {t('ais.logIn')}
          </button>
        )}
        {row.kind === 'custom' && !confirming && (
          <button ref={removeButton} type="button" style={smallButton} onClick={() => setConfirming(true)}>
            {t('ais.remove')}
          </button>
        )}
      </div>
    </div>
  );
}

function RowList(props: { title: string; blurb?: string; list: string; children: React.ReactNode }): React.JSX.Element {
  const id = React.useId();
  return (
    <div role="group" aria-labelledby={id} data-ai-list={props.list} style={{ display: 'grid', gap: 6 }}>
      <span id={id} style={{ fontSize: 12, fontWeight: 600 }}>
        {props.title}
      </span>
      {props.blurb && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{props.blurb}</span>}
      {props.children}
    </div>
  );
}

export function AisSection(props: { open: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const view = React.useSyncExternalStore(subscribeAis, getAisView, getAisView);
  const [looking, setLooking] = React.useState(false);
  const [defaultError, setDefaultError] = React.useState<string | null>(null);
  const [logins, setLogins] = React.useState<Record<string, LoginState>>({});
  const [adding, setAdding] = React.useState(false);

  React.useEffect(() => {
    if (props.open) startAis();
  }, [props.open]);

  const s: AisSnapshot | null = view.snapshot;
  const split = s ? splitAis(s) : null;
  const bridge = aisBridge();

  const setDefault = (id: string): void => {
    if (!bridge) return;
    setDefaultError(null);
    void bridge
      .setDefault(id)
      .then((raw) => {
        const r = answered(raw);
        if (r?.ok) acceptAisDefault(r.default);
        else setDefaultError(r && !r.ok && r.error ? t('ais.defaultFailed', { error: r.error }) : t('ais.defaultFailedNoReason'));
      })
      .catch((err: unknown) => setDefaultError(t('ais.defaultFailed', { error: errorText(err) })));
  };

  const logIn = (row: AiRowView, method?: string): void => {
    if (!bridge || !row.providerId) return;
    const key = row.key;
    if (logins[key]?.busy) return;
    setLogins((m) => ({ ...m, [key]: { busy: true } }));
    void bridge
      .login(row.providerId, method)
      .then((raw) => {
        const r = answered(raw);
        setLogins((m) => ({
          ...m,
          [key]: r ? loginMessage(r, t) : { busy: false, message: t('ais.loginFailedNoReason') },
        }));
      })
      .catch((err: unknown) =>
        setLogins((m) => ({ ...m, [key]: { busy: false, message: t('ais.loginFailed', { reason: errorText(err) }) } }))
      );
  };

  const root = React.useRef<HTMLDivElement | null>(null);
  const remove = async (row: AiRowView): Promise<boolean> => {
    if (!bridge) return false;
    try {
      const ok = answered(await bridge.custom.remove(row.key)) === true;
      // the row (and the button pressed) is about to go: keep the keyboard in the tab
      if (ok) root.current?.focus();
      return ok;
    } catch {
      return false;
    }
  };

  const lookAgain = (): void => {
    // a run in flight is shared in main anyway; a second press while it runs is a no-op
    if (!bridge || looking || s?.detecting) return;
    setLooking(true);
    void bridge
      .lookAgain()
      .then((raw) => acceptAisSnapshot(raw))
      .catch(() => noteAisFailure())
      .finally(() => setLooking(false));
  };

  const busyLooking = looking || !!s?.detecting;
  const rowOf = (row: AiRowView, found: boolean): React.JSX.Element => (
    <AiRow
      key={row.key}
      row={row}
      found={found}
      login={logins[row.key]}
      onMakeDefault={setDefault}
      onLogin={logIn}
      onRemove={remove}
    />
  );

  return (
    <div ref={root} tabIndex={-1} data-settings-item="ais" style={{ display: 'grid', gap: 16, padding: '14px 16px', outline: 'none' }}>
      <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>{t('ais.intro')}</p>
      {(view.failed || !bridge) && (
        <p role="status" data-ais-notice style={{ margin: 0, fontSize: 11.5 }}>
          {bridge ? t('ais.failed') : t('ais.unavailable')}
        </p>
      )}
      {s && split && (
        <>
          <SettingItem item="ais-default" label={t('ais.defaultTitle')} blurb={t('ais.defaultBlurb')}>
            <select
              aria-label={t('ais.defaultTitle')}
              data-ais-default
              value={s.default.id}
              onChange={(e) => setDefault(e.target.value)}
              style={{
                justifySelf: 'start',
                fontFamily: 'var(--font-ui)',
                fontSize: 12,
                padding: '3px 8px',
                background: 'var(--panel2)',
                color: 'var(--text)',
                border: '1px solid var(--control-edge)',
                borderRadius: 4,
              }}
            >
              {split.choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {s.default.fellBack && (
              <span data-ais-fell-back style={{ fontSize: 11, color: 'var(--muted)' }}>
                {t('ais.defaultFellBack', {
                  chosen: aiName(s, s.default.chosen),
                  fallback: aiName(s, s.default.id),
                })}
              </span>
            )}
            {defaultError && (
              <span role="status" style={{ fontSize: 11 }}>
                {defaultError}
              </span>
            )}
          </SettingItem>

          <RowList title={t('ais.foundTitle')} list="found">
            {split.found.length === 0 ? (
              <span style={detailStyle}>{t('ais.noneFound')}</span>
            ) : (
              split.found.map((r) => rowOf(r, true))
            )}
          </RowList>

          {split.notFound.length > 0 && (
            <RowList title={t('ais.notFoundTitle')} blurb={t('ais.notFoundBlurb')} list="not-found">
              {split.notFound.map((r) => rowOf(r, false))}
            </RowList>
          )}
        </>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <SettingsButton onClick={() => setAdding(true)} disabled={!s}>
          {t('ais.addAi')}
        </SettingsButton>
        {/* NOT disabled while looking: a disabled button drops the keyboard
            focus to <body>, out of the dialog, where Escape no longer closes it.
            The label says it is busy, and a press then does nothing. */}
        <SettingsButton onClick={lookAgain} disabled={!bridge}>
          {busyLooking ? t('ais.looking') : t('ais.lookAgain')}
        </SettingsButton>
      </div>
      <AddAiDialog
        open={adding}
        snapshot={s}
        onClose={() => setAdding(false)}
      />
    </div>
  );
}
