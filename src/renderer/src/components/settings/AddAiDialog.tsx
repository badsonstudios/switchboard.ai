// "Add an AI" (E40 item 09, #1292; `mockups/multi-ai.html` screen 5).
//
// TWO WAYS IN, one tab each:
// - **From the list**: the AIs the app ships knowledge of, with a search, a
//   "Runs local models" filter and each one's install instructions. ADDING
//   FROM THE LIST INSTALLS NOTHING, and the screen says so: it shows the
//   maker's command or page (host, don't reimplement), and the AI appears on
//   the AIs tab once it is installed and "Look again" has found it.
//   "Check for new AIs" is the ONLY network call on either screen, and only a
//   press makes it (design record §6, local-first).
// - **Something else**: any program that speaks the Agent Client Protocol, by
//   name, command and arguments. "Test" starts it once and asks `initialize`;
//   "Add" is enabled only once Test has passed for exactly the program in the
//   boxes. Test does NOT open a session, so it cannot report models: the
//   mockup's "3 models found" is not something this can know, and the result
//   says what it does know (the agent's name, version and protocol).
//
// THE DIALOG SHAPE is the house one (`SettingsDialog`, `DispatchDialog`):
// scrim, click-away, Escape, focus taken on open and given back on close, a
// place in the modal stack (`lib/modal-layer`). Two things are its own:
// - it is PORTALLED to `<body>`. It opens from inside Settings, and Settings
//   goes `inert` while it is not the top modal; a dialog in Settings' DOM
//   would go inert with it.
// - Tab WRAPS inside it, so the keyboard cannot walk out into the inert
//   Settings window behind.
import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useModalLayer } from '../../lib/modal-layer';
import { answered } from '../../../../shared/ipc/refusal';
import { errorText } from '../../../../shared/error-text';
import type { AisSnapshot, CustomAiDraft, CustomAiTestResult, RegistryCheckResult } from '../../../../shared/ais';
import { aisBridge } from '../../lib/ais-store';
import { catalogRows, draftOf, presenceOf, sameProgram } from '../../lib/ais-view';
import { SettingsButton } from './controls';
import { AiRowIcon } from './AiRowIcon';
import { InstallHintView } from './AiInstallHint';

type AddTab = 'list' | 'custom';
const TABS: readonly AddTab[] = ['list', 'custom'];

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside `root`: from the last stop to the first, and back. */
export function wrapTab(root: HTMLElement, e: React.KeyboardEvent): void {
  if (e.key !== 'Tab') return;
  const stops = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && !el.closest('[hidden]') && !el.closest('[inert]')
  );
  if (stops.length === 0) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const at = root.ownerDocument.activeElement;
  if (e.shiftKey && (at === first || at === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && at === last) {
    e.preventDefault();
    first.focus();
  }
}

const muted: React.CSSProperties = { fontSize: 11, color: 'var(--muted)' };

const inputStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  padding: '5px 8px',
  background: 'var(--bg)',
  color: 'var(--text)',
  border: '1px solid var(--control-edge)',
  borderRadius: 4,
  inlineSize: '100%',
  boxSizing: 'border-box',
};

function registryLines(r: RegistryCheckResult, t: (k: string, o?: Record<string, unknown>) => string): string[] {
  if (!r.ok) return [t('ais.add.registryFailed', { error: r.error })];
  const lines = [
    t('ais.add.registryResult', {
      total: r.total,
      added: r.diff.added.length,
      changed: r.diff.changed.length,
      removed: r.diff.removed.length,
    }),
  ];
  if (r.diff.added.length > 0) {
    lines.push(t('ais.add.registryAdded', { names: r.diff.added.map((a) => a.name).join(', ') }));
  }
  lines.push(t('ais.add.registryLast', { when: new Date(r.fetchedAt).toLocaleString() }));
  return lines;
}

function FromTheList(props: { snapshot: AisSnapshot | null; open: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState('');
  const [localOnly, setLocalOnly] = React.useState(false);
  const [registry, setRegistry] = React.useState<RegistryCheckResult | null>(null);
  const [checking, setChecking] = React.useState(false);
  const ids = React.useId();

  // The last check's answer, from main's cache. No network: only the button fetches.
  React.useEffect(() => {
    if (!props.open) return;
    const bridge = aisBridge();
    if (!bridge) return;
    let live = true;
    void bridge
      .lastRegistryCheck()
      .then((raw) => {
        const r = answered(raw);
        if (live && r) setRegistry(r);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [props.open]);

  const check = (): void => {
    const bridge = aisBridge();
    if (!bridge || checking) return;
    setChecking(true);
    void bridge
      .checkRegistry()
      .then((raw) => {
        const r = answered(raw);
        setRegistry(r ?? { ok: false, error: t('ais.unavailable') });
      })
      .catch((err: unknown) => setRegistry({ ok: false, error: errorText(err) }))
      .finally(() => setChecking(false));
  };

  const rows = props.snapshot ? catalogRows(props.snapshot, { query, localOnly }) : [];
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>{t('ais.add.listIntro')}</p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="search"
          aria-label={t('ais.add.search')}
          placeholder={t('ais.add.searchPlaceholder')}
          data-ai-add-search
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ ...inputStyle, fontFamily: 'var(--font-ui)', flex: '1 1 200px', inlineSize: 'auto' }}
        />
        <label htmlFor={`${ids}local`} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, cursor: 'pointer' }}>
          <input
            id={`${ids}local`}
            type="checkbox"
            data-ai-add-local
            checked={localOnly}
            onChange={(e) => setLocalOnly(e.target.checked)}
          />
          {t('ais.add.localOnly')}
        </label>
      </div>
      <div data-ai-add-list style={{ display: 'grid', gap: 6 }}>
        {rows.length === 0 && <span style={muted}>{t('ais.add.noMatch')}</span>}
        {rows.map((r) => {
          const presence = presenceOf(r.detection);
          return (
            <div
              key={r.key}
              role="group"
              aria-label={r.name}
              data-ai-add-row={r.key}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                padding: '8px 10px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'var(--panel2)',
              }}
            >
              <AiRowIcon {...(r.iconSrc ? { src: r.iconSrc } : {})} {...(r.ink ? { ink: r.ink } : {})} name={r.name} />
              <div style={{ flex: '1 1 auto', minInlineSize: 0, display: 'grid', gap: 3 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600 }}>{r.name}</span>
                  {r.maker && <span style={muted}>{r.maker}</span>}
                  {r.runsLocalModels && (
                    <span style={{ ...muted, border: '1px solid var(--border)', borderRadius: 10, padding: '0 7px' }}>
                      {t('ais.tagLocal')}
                    </span>
                  )}
                </div>
                {r.description && <span style={muted}>{r.description}</span>}
              </div>
              <div style={{ flex: 'none', maxInlineSize: '45%' }}>
                {presence === 'installed' ? (
                  <span data-ai-add-installed style={{ fontSize: 11.5, color: 'var(--status-done-ink)' }}>
                    {t('ais.add.installedMark')}
                  </span>
                ) : presence === 'checking' ? (
                  <span style={muted}>{t('ais.checking')}</span>
                ) : (
                  r.install && <InstallHintView hint={r.install} name={r.name} />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={muted}>{t('ais.add.registryNote')}</span>
        <div>
          <SettingsButton onClick={check} disabled={!aisBridge()}>
            {checking ? t('ais.add.checkingRegistry') : t('ais.add.checkRegistry')}
          </SettingsButton>
        </div>
        <div role="status" data-ai-registry-result style={{ display: 'grid', gap: 2 }}>
          {registry ? (
            registryLines(registry, t).map((line) => (
              <span key={line} style={{ fontSize: 11 }}>
                {line}
              </span>
            ))
          ) : (
            <span style={muted}>{t('ais.add.registryNever')}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function testLine(r: CustomAiTestResult, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (!r.ok) return r.error ? t('ais.add.testFailed', { error: r.error }) : t('ais.add.testFailedNoReason');
  const agent = [r.agentName, r.agentVersion].filter(Boolean).join(' ') || t('ais.add.anAgent');
  return r.protocolVersion !== undefined
    ? t('ais.add.testOk', { agent, protocol: r.protocolVersion })
    : t('ais.add.testOkNoProtocol', { agent });
}

function SomethingElse(props: { onAdded: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const ids = React.useId();
  const [form, setForm] = React.useState({ name: '', command: '', args: '' });
  const [tested, setTested] = React.useState<{ draft: CustomAiDraft; result: CustomAiTestResult } | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);

  const draft = draftOf(form);
  // only a result for the program now in the boxes counts, or is shown
  const current = tested && sameProgram(tested.draft, draft) ? tested.result : null;
  // NOT off while a press is in flight: a button disabled under the keyboard
  // drops focus to <body>, out of this dialog, where Escape and the Tab wrap no
  // longer reach. The busy label says it is working; a second press is a no-op.
  const canAdd = !!current?.ok && draft.name !== '';

  const field = (key: 'name' | 'command' | 'args', label: string, placeholder: string, hint?: string): React.JSX.Element => (
    <div style={{ display: 'grid', gap: 4 }}>
      <label htmlFor={`${ids}${key}`} style={{ fontSize: 12, fontWeight: 600 }}>
        {label}
      </label>
      <input
        id={`${ids}${key}`}
        data-ai-custom-field={key}
        value={form[key]}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-describedby={key === 'name' ? undefined : `${ids}result${hint ? ` ${ids}${key}hint` : ''}`}
        aria-invalid={key !== 'name' && current && !current.ok ? 'true' : undefined}
        onChange={(e) => {
          const v = e.target.value;
          setForm((f) => ({ ...f, [key]: v }));
          setAddError(null);
        }}
        style={key === 'name' ? { ...inputStyle, fontFamily: 'var(--font-ui)' } : inputStyle}
      />
      {hint && (
        <span id={`${ids}${key}hint`} style={muted}>
          {hint}
        </span>
      )}
    </div>
  );

  const test = (): void => {
    const bridge = aisBridge();
    if (!bridge || testing) return;
    const d = draftOf(form);
    setTesting(true);
    setAddError(null);
    void bridge.custom
      .test(d)
      .then((raw) => {
        const r = answered(raw);
        setTested({ draft: d, result: r ?? { ok: false, error: t('ais.unavailable'), ms: 0 } });
      })
      .catch((err: unknown) => setTested({ draft: d, result: { ok: false, error: errorText(err), ms: 0 } }))
      .finally(() => setTesting(false));
  };

  const add = (): void => {
    const bridge = aisBridge();
    if (!bridge || !canAdd || adding) return;
    setAdding(true);
    void bridge.custom
      .add(draft)
      .then((raw) => {
        const r = answered(raw);
        if (r?.ok) {
          props.onAdded();
          return;
        }
        setAddError(r && !r.ok ? r.error : t('ais.unavailable'));
      })
      .catch((err: unknown) => setAddError(errorText(err)))
      .finally(() => setAdding(false));
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>{t('ais.add.customIntro')}</p>
      {field('name', t('ais.add.name'), t('ais.add.namePlaceholder'))}
      {field('command', t('ais.add.command'), t('ais.add.commandPlaceholder'))}
      {field('args', t('ais.add.args'), t('ais.add.argsPlaceholder'), t('ais.add.argsHint'))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
        <SettingsButton onClick={test} disabled={draft.command === '' || !aisBridge()}>
          {testing ? t('ais.add.testing') : t('ais.add.test')}
        </SettingsButton>
        <SettingsButton onClick={add} disabled={!canAdd}>
          {adding ? t('ais.add.adding') : t('ais.add.addButton')}
        </SettingsButton>
      </div>
      <div id={`${ids}result`} role="status" data-ai-custom-result={current ? (current.ok ? 'ok' : 'failed') : 'none'} style={{ display: 'grid', gap: 4 }}>
        {current && (
          <span style={{ fontSize: 11.5, color: current.ok ? 'var(--status-done-ink)' : 'var(--status-crashed-ink)' }}>
            {testLine(current, t)}
          </span>
        )}
        {addError && <span style={{ fontSize: 11.5, color: 'var(--status-crashed-ink)' }}>{t('ais.add.addFailed', { error: addError })}</span>}
        {!current?.ok && <span style={muted}>{t('ais.add.addNeedsTest')}</span>}
        <span style={muted}>{t('ais.add.testNote')}</span>
      </div>
    </div>
  );
}

export function AddAiDialog(props: {
  open: boolean;
  snapshot: AisSnapshot | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { top, lift } = useModalLayer(props.open);
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const tabRefs = React.useRef<Partial<Record<AddTab, HTMLButtonElement | null>>>({});
  const ids = React.useId();
  const [tab, setTab] = React.useState<AddTab>('list');

  // A LAYOUT effect, for SettingsDialog's reason (#1171): the dialog has the
  // keyboard in the commit that shows it.
  React.useLayoutEffect(() => {
    if (!props.open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    setTab('list');
    dialog.current?.focus();
  }, [props.open]);

  if (!props.open) return null;

  const close = (): void => {
    props.onClose();
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const panel = (id: AddTab, children: React.ReactNode): React.JSX.Element => (
    <section
      role="tabpanel"
      id={`${ids}-panel-${id}`}
      aria-labelledby={`${ids}-tab-${id}`}
      data-ai-add-panel={id}
      hidden={tab !== id}
    >
      {children}
    </section>
  );

  return createPortal(
    <div
      onMouseDown={(e) => {
        e.stopPropagation();
        close();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 51 + lift,
        background: 'var(--scrim)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingBlockStart: '6vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal={top ? 'true' : undefined}
        inert={!top}
        aria-label={t('ais.add.title')}
        data-ai-add-dialog
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // ⚠️ ALWAYS stopped: this dialog is a React child of Settings (through
          // the portal), and Settings closes itself on an Escape that reaches it.
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
            return;
          }
          if (dialog.current) wrapTab(dialog.current, e);
        }}
        style={{
          inlineSize: 'min(640px, 94vw)',
          blockSize: 'min(620px, 86vh)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          boxShadow: 'var(--tab-lift)',
          fontFamily: 'var(--font-ui)',
          color: 'var(--text)',
          outline: 'none',
        }}
      >
        <div style={{ flexShrink: 0, borderBlockEnd: '1px solid var(--border)', background: 'var(--panel2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px 6px', fontSize: 13, fontWeight: 600 }}>
            <span style={{ flex: 1 }}>{t('ais.add.title')}</span>
            <button
              type="button"
              onClick={close}
              aria-label={t('ais.add.close')}
              title={t('ais.add.close')}
              style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 4 }}
            >
              {t('ais.add.closeIcon')}
            </button>
          </div>
          <div role="tablist" aria-label={t('ais.add.tabsLabel')} style={{ display: 'flex', gap: 2, paddingInline: 10 }}>
            {TABS.map((id) => {
              const on = tab === id;
              return (
                <button
                  key={id}
                  ref={(el) => {
                    tabRefs.current[id] = el;
                  }}
                  type="button"
                  role="tab"
                  id={`${ids}-tab-${id}`}
                  aria-selected={on}
                  aria-controls={`${ids}-panel-${id}`}
                  data-ai-add-tab={id}
                  tabIndex={on ? 0 : -1}
                  className="settings-tab"
                  onClick={() => setTab(id)}
                  onKeyDown={(e) => {
                    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
                    e.preventDefault();
                    const i = TABS.indexOf(id);
                    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
                    const step = e.key === 'Home' ? -i : e.key === 'End' ? TABS.length - 1 - i : (e.key === 'ArrowRight') !== rtl ? 1 : -1;
                    const next = TABS[(i + step + TABS.length) % TABS.length];
                    setTab(next);
                    tabRefs.current[next]?.focus();
                  }}
                >
                  {id === 'list' ? t('ais.add.tabList') : t('ais.add.tabCustom')}
                </button>
              );
            })}
          </div>
        </div>
        <div style={{ flex: '1 1 auto', minBlockSize: 0, overflowY: 'auto', padding: '12px 16px' }}>
          {panel('list', <FromTheList snapshot={props.snapshot} open={props.open} />)}
          {panel('custom', <SomethingElse onAdded={close} />)}
        </div>
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'flex-end',
            padding: '10px 16px',
            borderBlockStart: '1px solid var(--border)',
          }}
        >
          <SettingsButton onClick={close}>{t('ais.add.done')}</SettingsButton>
        </div>
      </div>
    </div>,
    document.body
  );
}
