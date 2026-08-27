// The MCP Manager's add form (§5.17, #714).
//
// WHAT IT IS FOR: `claude mcp add` takes six things and spells them in ways you
// have to look up — `-s` before the name, `-t` before that, `-e KEY=value`
// repeated, `-H "Name: value"` repeated, and a `--` whose absence makes the most
// common install form in the ecosystem (`npx -y some-server`) fail with an
// error about OUR flags. This collects the six things and lets
// `shared/mcp-args.ts` do the spelling.
//
// ── THE REASON THIS FORM IS WHERE THE SECRET PROBLEM GETS SOLVED ─────────────
//
// #632 shipped with a stated limit: `args` is not redacted, because
// `npx some-server --api-key sk-live-…` is a documented install form and
// guessing which of an arbitrary program's flags are secrets is wrong in both
// directions — it hides a `--port` and misses a `--pat`. The manual said "keep
// keys in environment variables instead", which was true and useless, because
// switchboard had nowhere to type one.
//
// It does now. The fix is not detection, it is GIVING THE KEY A HOME: a
// dedicated Environment variables field whose values go renderer → main → the
// CLI's config and never come back (`McpServerWire` has `envKeys` and no field
// that can hold a value), plus the sentence saying so at the moment the user is
// deciding where to put it. A value typed here can never appear in this pane;
// a value typed into Arguments always will. That is a choice the user can now
// actually make.
//
// The values are `type="password"` for the reason `PushSetupDialog` gives: the
// person setting a credential up is often sharing their screen while they do it.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { validateAdd } from '../../../shared/mcp-args';
import type { McpAddRequest, McpFieldError, McpKeyValue, McpScope } from '../../../shared/mcp';

export interface McpAddFormProps {
  /** Submits, and answers a message to show — or null when it worked and the
   *  form should close. The parent owns the IPC call and the re-list. */
  onSubmit: (request: McpAddRequest) => Promise<string | null>;
  onCancel: () => void;
  busy: boolean;
}

type Transport = McpAddRequest['transport'];

const SCOPES: readonly McpScope[] = ['local', 'project', 'user'];
const TRANSPORTS: readonly Transport[] = ['stdio', 'http', 'sse'];

const field: React.CSSProperties = {
  background: 'var(--panel2)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '4px 8px',
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  inlineSize: '100%',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = { fontSize: 11, color: 'var(--muted)' };

/**
 * ONE ARGUMENT PER LINE, and the alternative was worse.
 *
 * The obvious design is a single "Arguments" box split on spaces, which is
 * wrong the first time someone needs `--dir "C:\Program Files\x"`. The other
 * obvious design is to parse quotes — which is writing a shell parser, in the
 * one part of the app whose entire premise is that we do NOT hand things to a
 * shell. A newline cannot appear inside an argument (`validateAdd` refuses
 * control characters outright), so splitting on it is unambiguous by
 * construction rather than by convention.
 *
 * Blank lines are dropped: they are what a trailing newline in a textarea looks
 * like, and an empty argv element is almost never meant.
 *
 * Each line is TRIMMED, which is a deliberate trade rather than an oversight:
 * an argument with meaningful leading or trailing whitespace cannot be
 * expressed here. The launcher carries `' lead'` and `'trail '` byte-exact, so
 * this is a limit of the form and not of the transport — and a textarea where
 * an invisible stray space changes what runs is a worse problem than the one it
 * would solve. `claude mcp add` is still there for the rare case.
 */
export function parseArgLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function McpAddForm(props: McpAddFormProps): React.JSX.Element {
  const { t } = useTranslation();
  const [name, setName] = React.useState('');
  const [scope, setScope] = React.useState<McpScope>('local');
  const [transport, setTransport] = React.useState<Transport>('stdio');
  const [target, setTarget] = React.useState('');
  const [argsText, setArgsText] = React.useState('');
  const [pairs, setPairs] = React.useState<McpKeyValue[]>([]);
  /** what came back from main — the CLI's own words, or a refusal */
  const [problem, setProblem] = React.useState<string | null>(null);
  /** shown only AFTER a submit attempt, so the form does not scold you for a
   *  name you have not finished typing */
  const [touched, setTouched] = React.useState(false);
  const firstField = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    firstField.current?.focus();
  }, []);

  const remote = transport !== 'stdio';
  // A ROW WITH NEITHER A NAME NOR A VALUE IS AN EMPTY ROW the user added and
  // did not fill in — dropped, silently, correctly.
  //
  // A row with a VALUE and no name is different, and dropping it silently is
  // the one thing this form must not do: it means a credential the user typed
  // went nowhere, and they will find out when the server does not authenticate.
  // It is kept in the request so `validateAdd` refuses it and says which row.
  const used = pairs.filter((p) => p.key !== '' || p.value !== '');
  const request: McpAddRequest = {
    name: name.trim(),
    scope,
    transport,
    target: target.trim(),
    // The pairs are ONE piece of state for two fields, because a server is
    // either stdio or remote and never both — keeping two lists would let a
    // user fill in headers, switch to stdio, and ship env vars they never typed.
    ...(remote ? { headers: used } : { args: parseArgLines(argsText), env: used }),
  };
  const error: McpFieldError | null = validateAdd(request);

  const submit = async (): Promise<void> => {
    setTouched(true);
    setProblem(null);
    // The SAME function main runs (`shared/mcp-args.ts`) — so the form can
    // never accept something main will refuse, which would read on screen as a
    // button that does nothing.
    if (error) return;
    setProblem(await props.onSubmit(request));
  };

  const errorFor = (f: McpFieldError['field']): string | null =>
    touched && error?.field === f
      ? t(`mcp.form.error.${error.code}`, { at: error.at ?? '' })
      : null;

  const problemLine = (f: McpFieldError['field']): React.JSX.Element | null => {
    const msg = errorFor(f);
    return msg ? (
      <div data-mcp-form-error={f} style={{ fontSize: 10.5, color: 'var(--status-crashed-ink)' }}>
        {msg}
      </div>
    ) : null;
  };

  const row = (label: string, control: React.ReactNode, f?: McpFieldError['field']) => (
    <label style={{ display: 'grid', gap: 3 }}>
      <span style={labelStyle}>{label}</span>
      {control}
      {f ? problemLine(f) : null}
    </label>
  );

  return (
    <form
      data-testid="mcp-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      style={{
        display: 'grid',
        gap: 9,
        padding: '12px 14px',
        borderBlockStart: '1px solid var(--border)',
        background: 'var(--panel2)',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600 }}>{t('mcp.form.title')}</div>

      {row(
        t('mcp.form.name'),
        <input
          ref={firstField}
          data-mcp-field="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('mcp.form.namePlaceholder')}
          style={field}
        />,
        'name'
      )}

      <div style={{ display: 'flex', gap: 9 }}>
        <div style={{ flex: 1 }}>
          {row(
            t('mcp.form.scope'),
            <select
              data-mcp-field="scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as McpScope)}
              style={field}
            >
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {t(`mcp.scope.${s}`)}
                </option>
              ))}
            </select>
          )}
        </div>
        <div style={{ flex: 1 }}>
          {row(
            t('mcp.form.transport'),
            <select
              data-mcp-field="transport"
              value={transport}
              onChange={(e) => {
                setTransport(e.target.value as Transport);
                // switching between a child process and an endpoint changes
                // what the pairs MEAN, so they do not carry over
                setPairs([]);
              }}
              style={field}
            >
              {TRANSPORTS.map((tr) => (
                <option key={tr} value={tr}>
                  {t(`mcp.form.kinds.${tr}`)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {row(
        remote ? t('mcp.form.url') : t('mcp.form.command'),
        <input
          data-mcp-field="target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder={remote ? t('mcp.form.urlPlaceholder') : t('mcp.form.commandPlaceholder')}
          style={field}
        />,
        'target'
      )}

      {!remote && (
        <>
          {row(
            t('mcp.form.args'),
            <textarea
              data-mcp-field="args"
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              spellCheck={false}
              rows={3}
              placeholder={t('mcp.form.argsPlaceholder')}
              style={{ ...field, fontFamily: 'var(--font-mono)', resize: 'vertical' }}
            />,
            'args'
          )}
          {/* THE SENTENCE THAT MAKES `args` TRACTABLE. Said here, where the
              decision is being made, rather than in the manual afterwards. */}
          <div style={{ fontSize: 10.5, color: 'var(--faint)', marginBlockStart: -4 }}>
            {t('mcp.form.argsSecretNote')}
          </div>
        </>
      )}

      <PairEditor
        label={remote ? t('mcp.form.headers') : t('mcp.form.env')}
        keyPlaceholder={remote ? t('mcp.form.headerNamePlaceholder') : t('mcp.form.envNamePlaceholder')}
        addLabel={remote ? t('mcp.form.addHeader') : t('mcp.form.addEnv')}
        pairs={pairs}
        onChange={setPairs}
      />
      {problemLine(remote ? 'headers' : 'env')}

      {/* The CLI's own refusal — "MCP server sentry already exists in
          .mcp.json" names the exact file and is a better sentence than
          anything we would write. */}
      {problem && (
        <div
          data-mcp-form-problem
          role="alert"
          style={{ fontSize: 11, color: 'var(--status-crashed-ink)', whiteSpace: 'pre-wrap' }}
        >
          {problem}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Btn onClick={props.onCancel} type="button">
          {t('mcp.form.cancel')}
        </Btn>
        <Btn type="submit" disabled={props.busy}>
          {props.busy ? t('mcp.form.adding') : t('mcp.form.add')}
        </Btn>
      </div>
    </form>
  );
}

/**
 * The repeated `KEY=value` / `Name: value` editor.
 *
 * One component for both because the two differ only in their labels and in
 * which validator runs over them — and the thing that matters about both, that
 * the VALUE is a password field and never comes back over the wire, is
 * identical.
 */
function PairEditor(props: {
  label: string;
  keyPlaceholder: string;
  addLabel: string;
  pairs: readonly McpKeyValue[];
  onChange: (next: McpKeyValue[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const set = (i: number, patch: Partial<McpKeyValue>): void =>
    props.onChange(props.pairs.map((p, n) => (n === i ? { ...p, ...patch } : p)));

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <span style={labelStyle}>{props.label}</span>
      {props.pairs.map((p, i) => (
        // INDEX AS KEY, and here it is the correct choice rather than the lazy
        // one: these rows have no identity of their own until the user types a
        // name, two blank rows are genuinely indistinguishable, and keying on
        // the name would remount the input on every keystroke and lose focus.
        <div key={i} style={{ display: 'flex', gap: 5 }}>
          <input
            data-mcp-pair-key={i}
            value={p.key}
            onChange={(e) => set(i, { key: e.target.value })}
            placeholder={props.keyPlaceholder}
            spellCheck={false}
            autoComplete="off"
            style={{ ...field, flex: 1 }}
          />
          <input
            data-mcp-pair-value={i}
            value={p.value}
            onChange={(e) => set(i, { value: e.target.value })}
            // a credential, typed by someone who may be sharing their screen
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('mcp.form.valuePlaceholder')}
            style={{ ...field, flex: 1 }}
          />
          <Btn
            type="button"
            onClick={() => props.onChange(props.pairs.filter((_, n) => n !== i))}
            title={t('mcp.form.removePair')}
          >
            {t('mcp.closeIcon')}
          </Btn>
        </div>
      ))}
      <div>
        <Btn type="button" onClick={() => props.onChange([...props.pairs, { key: '', value: '' }])}>
          {props.addLabel}
        </Btn>
      </div>
    </div>
  );
}

/** The dialog button shape `PushSetupDialog` established. Duplicated rather
 *  than extracted: pulling it into a shared component touches five overlays
 *  and is a change of its own, not a side effect of this one. */
function Btn(props: {
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
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
        whiteSpace: 'nowrap',
      }}
    >
      {props.children}
    </button>
  );
}

export { Btn as McpDialogButton };
