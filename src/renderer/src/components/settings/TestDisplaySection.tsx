// Settings → Advanced → Testing (#1331): which screen this project's OWN
// automated tests open their windows on.
//
// WHY A USER-FACING APP HAS IT (PHILOSOPHY §4). switchboard is dogfooded by the
// people who build it, and its end-to-end suite opens ~160 real windows a run.
// Without this they land on the screen you are working on. The setting is for
// those developers and says so in one sentence under the control; it sits at
// the very bottom of Settings, on the last tab, so nobody else trips over it.
//
// WHAT IT TOUCHES. One line of `~/.switchboard-e2e.env`, the per-machine file the
// e2e fixture reads. Main owns the file (`main/test-display.ts`); this screen
// names a SCREEN and main decides what the line says — a direction word when
// that is unambiguous, else the display's id — so a different monitor
// detaching cannot quietly re-point it.
//
// Self-contained, like the AIs tab: it talks to `switchboard.testDisplay`
// itself, and with no bridge it is not drawn at all.
//
// HONEST ABOUT A SCREEN THAT IS GONE. A saved choice nothing attached answers
// to is shown as its own row — ticked, because it IS what the file says — with
// the words "not attached — tests run on the primary until it is back". It is
// never silently shown as "Primary", which would be a lie about the file.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../../shared/ipc/refusal';
import { errorText } from '../../../../shared/error-text';
import {
  E2E_MONITOR_ENV,
  type TestDisplaySetResult,
  type TestDisplayState,
  type TestScreen,
} from '../../../../shared/test-display';
import { SettingItem } from './controls';

interface TestDisplayBridge {
  get: () => Promise<TestDisplayState>;
  set: (screenId: number | null) => Promise<TestDisplaySetResult>;
  onChanged: (cb: (state: TestDisplayState) => void) => () => void;
}

function testDisplayBridge(): TestDisplayBridge | undefined {
  try {
    const b = (globalThis as { switchboard?: { testDisplay?: TestDisplayBridge } }).switchboard
      ?.testDisplay;
    return b && typeof b.get === 'function' && typeof b.set === 'function' ? b : undefined;
  } catch {
    return undefined;
  }
}

/** Which radio is ticked: the primary, a screen's id, or the saved-but-unusable row. */
type Choice = 'primary' | number | 'saved';

function choiceOf(state: TestDisplayState): Choice | null {
  // a file that could not be read says nothing about what is saved: tick none
  if (state.readProblem) return null;
  const s = state.saved;
  if (s.kind === 'none') return 'primary';
  if (s.kind === 'attached') return s.screenId ?? 'primary';
  return 'saved';
}

export function TestDisplaySection(): React.JSX.Element | null {
  const { t } = useTranslation();
  const fieldId = React.useId();
  const bridge = React.useMemo(testDisplayBridge, []);
  const [state, setState] = React.useState<TestDisplayState | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Read when the section mounts — which is every time Settings opens, since
  // the dialog renders nothing while shut — and again on every hotplug.
  React.useEffect(() => {
    if (!bridge) return;
    let live = true;
    bridge
      .get()
      .then((s) => {
        if (!live) return;
        const got = answered(s);
        if (got) setState(got);
        else setProblem(t('testDisplay.refused'));
      })
      .catch((err: unknown) => {
        // fail-open: no list, and the words say why rather than "looking…" for ever
        if (live) setProblem(errorText(err));
      });
    let off: (() => void) | undefined;
    try {
      off = bridge.onChanged((s) => {
        if (live) setState(s);
      });
    } catch {
      // no push: the list is still right as of opening
    }
    return () => {
      live = false;
      off?.();
    };
  }, [bridge, t]);

  if (!bridge) return null;

  const choose = async (screenId: number | null): Promise<void> => {
    setBusy(true);
    try {
      const r = answered(await bridge.set(screenId));
      if (!r) {
        setProblem(t('testDisplay.refused'));
      } else {
        setState(r.state);
        setProblem(r.ok ? null : r.code ? t(`testDisplay.code.${r.code}`) : r.problem);
      }
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const describe = (s: TestScreen): string => {
    const parts = [
      s.name,
      t('testDisplay.size', { width: s.width, height: s.height }),
      t(`testDisplay.position.${s.position}`),
    ].filter(Boolean);
    return t('testDisplay.row', { number: s.number, details: parts.join(', ') });
  };

  const choice = state ? choiceOf(state) : null;
  const disabled = busy || !state || Boolean(state.readProblem);
  const primary = state?.screens.find((s) => s.primary);
  const others = state?.screens.filter((s) => !s.primary) ?? [];

  const option = (
    key: string,
    checked: boolean,
    label: string,
    onPick: (() => void) | null,
    note?: string
  ): React.JSX.Element => (
    <label
      key={key}
      htmlFor={`${fieldId}r-${key}`}
      data-test-display-option={key}
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: '2px 8px',
        alignItems: 'start',
        cursor: disabled || !onPick ? 'default' : 'pointer',
      }}
    >
      <input
        id={`${fieldId}r-${key}`}
        type="radio"
        name={`${fieldId}screen`}
        checked={checked}
        disabled={disabled || (!onPick && !checked)}
        onChange={() => onPick?.()}
        style={{ marginBlockStart: 2 }}
      />
      <span style={{ fontSize: 11.5 }}>{label}</span>
      {note ? (
        <>
          <span />
          <span data-test-display-note style={{ fontSize: 11, color: 'var(--muted)' }}>
            {note}
          </span>
        </>
      ) : null}
    </label>
  );

  return (
    <SettingItem item="test-display" label={t('testDisplay.title')} blurb={t('testDisplay.blurb')}>
      <div
        data-settings-block="test-display"
        role="radiogroup"
        aria-label={t('testDisplay.title')}
        aria-busy={busy || !state}
        style={{ display: 'grid', gap: 8 }}
      >
        {!state ? (
          problem ? null : (
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('testDisplay.loading')}</span>
          )
        ) : (
          <>
            {option(
              'primary',
              choice === 'primary',
              primary
                ? t('testDisplay.primaryDefaultIs', { screen: describe(primary) })
                : t('testDisplay.primaryDefault'),
              () => void choose(null)
            )}
            {others.map((s) => option(String(s.id), choice === s.id, describe(s), () => void choose(s.id)))}
            {state.saved.kind === 'missing' || state.saved.kind === 'invalid'
              ? option(
                  'saved',
                  choice === 'saved',
                  t('testDisplay.savedValue', { value: state.saved.value }),
                  null,
                  t(state.saved.kind === 'missing' ? 'testDisplay.missing' : 'testDisplay.invalid')
                )
              : null}
          </>
        )}
      </div>
      {state?.readProblem ? (
        <span role="alert" data-test-display-problem style={{ fontSize: 11, color: 'var(--status-crashed-ink)' }}>
          {t('testDisplay.readFailed', { file: state.file, problem: state.readProblem })}
        </span>
      ) : null}
      {problem ? (
        <span role="alert" data-test-display-problem style={{ fontSize: 11, color: 'var(--status-crashed-ink)' }}>
          {state ? t('testDisplay.writeFailed', { problem }) : t('testDisplay.getFailed', { problem })}
        </span>
      ) : null}
      {state ? (
        <span data-test-display-file style={{ fontSize: 11, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
          {t('testDisplay.savedIn', { file: state.file, env: E2E_MONITOR_ENV })}
        </span>
      ) : null}
    </SettingItem>
  );
}
