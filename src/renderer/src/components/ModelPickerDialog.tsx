// The model picker (#721, #633, §5.17).
//
// WHAT IT ANSWERS: "which model is this session running, and what else could it
// run?" Before #721 there was no way to ask — `/model` opens an interactive
// picker in the CLI's TUI, and a Direct session has no terminal for it to
// appear in, so typing it was a dead end that ate the command.
//
// It is not a reimplementation of that picker. The list comes from the CLI's
// own `list_models`, the change goes out as the CLI's own `set_model`, and a
// refusal is shown in the CLI's own words. P7 as amended (PHILOSOPHY §6): a GUI
// surface that drives the real mechanism is legitimate; faking one is not.
//
// The dialog shape — scrim, click-away, focus capture and restore, Escape — is
// `McpManagerDialog`'s, which is `QuietHoursDialog`'s, which is
// `AboutPanel`'s. Two modals that behave differently is a bug report waiting to
// happen.
//
// ── THE ONE THING THAT MAKES THIS HARDER THAN IT LOOKS ───────────────────────
//
// **NOTHING THE CLI RETURNS SAYS WHICH MODEL IS CURRENT.** Measured against
// 2.1.245 (`docs/reference-implementations.md` §1.2.2, finding 3): `list_models`
// marks none of its five entries, and `initialize`'s response has no
// current-model field either. The running model appears in exactly one place —
// `system:init.model` — and that arrives **once per TURN**.
//
// So on a session that has run no turn, which is precisely the fresh card
// someone opens this on first, the current model is GENUINELY UNKNOWN. This
// pane says so. It does not tick `default`, because `default` would be a
// fabrication: the user may well be on something else from their settings, and
// the one fact this surface exists to report is the one it would be inventing.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { answered } from '../../../shared/ipc/refusal';
import { readModels, type CliModel } from '../../../shared/stream-protocol';
import type { ControlVerdict } from '../../../shared/control';

export interface ModelPickerDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * The LIVE session this acts on — not the focused card.
   *
   * `/model` is typed in a specific composer, and with popouts and split grids
   * that composer is not reliably the one the app considers focused. The
   * command carries its own id for that reason.
   */
  liveId: string | null;
  /** the session's name, for the subtitle — the id is not what the user calls it */
  sessionTitle?: string;
}

/**
 * The verdict's failure, in words a person can act on.
 *
 * `refused` passes the CLI's OWN SENTENCE through untouched — it is written for
 * a human ("Model \"x\" is not a recognized model id. Run /model to see
 * available models."), and ours would be a guess at what it meant. Same call
 * `mcp/cli.ts` made, for the same reason.
 *
 * Exported and pure so the mapping is unit-tested rather than asserted through
 * a rendered tree.
 */
export function failureText(v: Extract<ControlVerdict, { ok: false }>, t: (k: string) => string): string {
  if (v.reason === 'refused' && v.message) return v.message;
  if (v.reason === 'not-stream') return t('model.notStream');
  if (v.reason === 'session-gone') return t('model.sessionGone');
  if (v.reason === 'timed-out') return t('model.timedOut');
  return t('model.failed');
}

/** What a row says under the name. Never empty — the id is the honest fallback. */
export function rowSubtitle(m: CliModel): string {
  return m.description ?? m.resolvedModel ?? m.value;
}

/**
 * WHICH ONE ROW is the session running — an index, or `-1`.
 *
 * MATCHED ON TWO FIELDS, because the two sides speak different dialects:
 * `system:init.model` reports a RESOLVED id (`claude-haiku-4-5-20251001`) while
 * the list's `value` is the alias you set (`haiku`). Matching only `value`
 * would leave a session with nothing ticked the moment the CLI resolved an
 * alias — which is always.
 *
 * ⚠️ AN INDEX RATHER THAN A PER-ROW PREDICATE, AND THAT IS NOT STYLE. **Two
 * rows in the real payload share a `resolvedModel`**: `default` and `opus[1m]`
 * both resolve to `claude-opus-5[1m]` (captured, 2.1.245). A per-row test
 * therefore ticked BOTH of them for anyone on the default model — which is the
 * default setup — and put two `aria-checked` radios in one radiogroup, which is
 * invalid as well as wrong. Resolving once, here, is what makes "the current
 * one" singular.
 *
 * EXACT `value` WINS over a resolved match, so a session that was switched to
 * `opus[1m]` ticks `opus[1m]` rather than the `default` row that happens to
 * resolve the same way. Only when nothing matches by alias do we fall back to
 * the first resolved match — which is `default`, the right answer for a session
 * that never chose.
 *
 * `null` current means "not known yet" and must tick NOTHING. See the header.
 */
export function currentIndex(models: readonly CliModel[], current: string | null): number {
  if (!current) return -1;
  const exact = models.findIndex((m) => m.value === current);
  if (exact >= 0) return exact;
  return models.findIndex((m) => m.resolvedModel === current);
}

export function ModelPickerDialog(props: ModelPickerDialogProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const [models, setModels] = React.useState<CliModel[] | null>(null);
  const [current, setCurrent] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<{ bad: boolean; text: string } | null>(null);
  /**
   * The row you have CLICKED, which is not the model the session is running
   * (#746).
   *
   * Clicking used to apply immediately and the only way out was the ✕, so the
   * dialog had no way to express "I picked this" separately from "this is what
   * it is", and no way to change your mind. Staging the click gives both: OK
   * commits, and Cancel/Escape/click-away discard — which makes reverting free,
   * because nothing was ever sent.
   *
   * `null` means "you have not chosen anything this sitting", NOT "default".
   */
  const [staged, setStaged] = React.useState<string | null>(null);
  /** where focus goes on close — `/model` means focus was in the COMPOSER a
   *  second ago, so dropping the user on `<body>` costs them a mouse trip */
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  /**
   * Which sitting we are in. A `set_model` can outlive the dialog — the channel
   * allows ten seconds and this is closable throughout — so without it a slow
   * answer paints "Now using Haiku" over a session the user has since left.
   * `McpManagerDialog` documents the same trap; it was reproduced there.
   */
  const epoch = React.useRef(0);
  /**
   * A `set_model` is on the wire RIGHT NOW — across sittings.
   *
   * Separate from `busy`, which is what the rows read to disable themselves and
   * is reset with every sitting. See `choose` for the sequence that gets past
   * `busy` alone.
   */
  const inFlight = React.useRef(false);
  /**
   * `inFlight`, mirrored into state so the BUTTON can see it.
   *
   * A ref is invisible to render, so OK could look enabled while `apply`'s
   * `inFlight.current` guard silently ate every click — the exact sequence the
   * guard exists for (press OK, Escape before it lands, reopen) produced a
   * live-looking button that did nothing. The ref stays the authority; this is
   * only how the disabled state learns about it.
   */
  const [held, setHeld] = React.useState(false);

  const { open, liveId } = props;

  // ONE EFFECT FOR THE WHOLE SITTING, and that is not tidiness — it is a bug
  // fix. The transient reset used to live in its own effect on the same deps,
  // declared after this one, so it bumped `epoch` immediately AFTER this one
  // claimed a number: every load then failed its own `epoch.current !== mine`
  // guard and the list never rendered. Effects on identical deps that both
  // touch a sequence counter have to be one effect.
  React.useEffect(() => {
    // Bumped FIRST and unconditionally, including on close: anything still in
    // flight belongs to the sitting that just ended.
    const mine = ++epoch.current;
    setNotice(null);
    setBusy(null);
    // A sitting that ends discards its selection — that IS the Cancel/Escape/
    // click-away behaviour, and it costs nothing to undo precisely because
    // nothing was put on the wire.
    setStaged(null);
    // Re-seeded from the REF rather than cleared: a request from the previous
    // sitting can still be outstanding, and this sitting's OK must stay dead
    // until it lands. Clearing it here is what would make the button lie.
    setHeld(inFlight.current);
    if (!open || !liveId) return;
    setLoading(true);
    setModels(null);
    setCurrent(null);
    // TWO CALLS, DELIBERATELY UNSEQUENCED. The list is a round trip to the CLI
    // (measured at 0-2ms, but it is still a round trip); the current model is a
    // local map lookup in main. Neither needs the other, and awaiting them in
    // series would make the pane wait on the slower for no reason.
    void window.switchboard.sessions.listModels(liveId).then((raw) => {
      // `answered` launders a capability REFUSAL into undefined. It cannot
      // happen for this first-party renderer (see `shared/ipc/refusal.ts`), and
      // the shape would collide silently if it did: a refusal's `.ok` is
      // `undefined`, i.e. falsy, so an unlaundered read fails closed into
      // `reason: undefined` rather than loudly.
      const v = answered(raw);
      // ONE GUARD, not two. A `live` flag alongside this was strictly
      // redundant — it could only ever be false once a later run had already
      // bumped `epoch` — and two guards for one fact is where the third call
      // site copies the wrong one.
      if (epoch.current !== mine) return;
      setLoading(false);
      // A REFUSAL LEAVES THE LIST NULL, not empty. "The CLI would not tell us"
      // and "the CLI has no models" are different facts and the pane draws them
      // differently — an empty list with no explanation reads as a broken app.
      if (!v) return setNotice({ bad: true, text: t('model.failed') });
      if (!v.ok) return setNotice({ bad: true, text: failureText(v, t) });
      setModels(readModels(v.response));
    });
    void window.switchboard.sessions.currentModel(liveId).then((raw) => {
      if (epoch.current !== mine) return;
      const m = answered(raw);
      setCurrent(typeof m === 'string' ? m : null);
    });
    // NO `t` IN THE DEPS, deliberately. This effect owns the SITTING counter,
    // and its deps must be exactly "which sitting is this". `t`'s identity
    // changes when the language does (react-i18next re-emits on
    // `languageChanged`), and a re-run mid-switch would bump `epoch`, re-enable
    // every row and silently discard the verdict for a `set_model` the CLI had
    // already applied — the model changes and the UI says nothing happened.
    // The notice strings close over `t` inside their callbacks, which is where
    // they are actually needed.
  }, [open, liveId]);

  React.useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null; // before we take it
    dialog.current?.focus();
  }, [open]);

  if (!open) return null;

  const close = (): void => {
    props.onClose();
    // …on the NEXT frame: this element still holds focus until React has
    // committed the unmount. The same shape the other overlays use.
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  /** Clicking a row SELECTS it. Nothing goes to the CLI until OK (#746). */
  const choose = (m: CliModel): void => {
    if (busy) return;
    setNotice(null);
    setStaged(m.value);
  };

  /**
   * OK — the only thing in this dialog that puts a `set_model` on the wire.
   *
   * TWO GUARDS, and the second is not belt-and-braces. `busy` is UI state and
   * the sitting effect clears it, so this sequence gets past it: press OK,
   * press Escape before it lands, reopen. The reopen is a new sitting, `busy`
   * is null, the button is live again — and pressing it now puts a SECOND
   * `set_model` on the wire while the first is still outstanding. The CLI
   * applies both and the last to land wins, which is not necessarily the one
   * chosen last. `inFlight` is a ref, so it survives the sitting the way the
   * request itself does.
   *
   * Staging narrows the window (one button instead of five rows) but does not
   * close it, which is why this guard survived the redesign rather than being
   * simplified away with `busy`.
   */
  const apply = (): void => {
    const m = (models ?? []).find((x) => x.value === staged);
    if (!liveId || !m || busy || inFlight.current) return;
    const mine = epoch.current;
    inFlight.current = true;
    setHeld(true);
    setBusy(m.value);
    setNotice(null);
    const release = (): void => {
      inFlight.current = false; // released even for a sitting that has moved on
      setHeld(false);
    };
    void window.switchboard.sessions
      .setModel(liveId, m.value)
      .then((raw) => {
        release();
        if (epoch.current !== mine) return; // a different sitting owns the screen now
        const v = answered(raw);
        setBusy(null);
        // A REFUSAL KEEPS THE DIALOG OPEN, carrying the CLI's own sentence. The
        // session is untouched and the staged row stays selected, so the
        // obvious next actions — try again, pick something else, Cancel — are
        // all still in front of the user rather than behind a reopen.
        if (!v) return setNotice({ bad: true, text: t('model.failed') });
        if (!v.ok) return setNotice({ bad: true, text: failureText(v, t) });
        // Success closes. The "Now using X" notice is gone with it — under
        // commit semantics the close IS the confirmation, and a notice nobody
        // stays to read is not one. What confirms it afterwards is the session
        // footer, which now moves on this same success (#746 part 1).
        setCurrent(m.value);
        close();
      })
      .catch(() => {
        // A REJECTED invoke, not a refusal verdict — the channel itself failed.
        // Without this the ref stays latched and every later OK is swallowed in
        // silence, for the life of the window: this component never unmounts
        // (it renders `null` when shut), so the ref outlives every sitting.
        release();
        if (epoch.current !== mine) return;
        setBusy(null);
        setNotice({ bad: true, text: t('model.failed') });
      });
  };

  const label = (m: CliModel): string => m.displayName ?? m.value;
  /** the ONE row the session is RUNNING, resolved once — see `currentIndex` */
  const ticked = currentIndex(models ?? [], current);
  /**
   * The row the radiogroup shows as chosen: your selection if you have made
   * one this sitting, otherwise what the session is running.
   *
   * Resolved through `currentIndex` for the staged case too, so the alias/
   * resolved matching and the shared-`resolvedModel` trap it documents apply
   * identically — a staged `default` must not also light up `opus[1m]`.
   */
  const selected = staged !== null ? currentIndex(models ?? [], staged) : ticked;
  /** a selection that would actually change something — what OK is for */
  const dirty = staged !== null && selected >= 0 && selected !== ticked;
  /** the running model's name, for the sentence that says the tick is a plan */
  const runningLabel = models && ticked >= 0 ? label(models[ticked]) : null;
  /**
   * The session named a model that is not in the list.
   *
   * A THIRD STATE, distinct from "not known yet". Reachable: a `settings.json`
   * pinning a specific dated id, or an older conversation resumed whose init
   * reports something this CLI no longer offers. Without it the pane renders
   * exactly like the fresh-card case MINUS the sentence that makes that case
   * honest — five rows, no tick, no explanation, which is the "looks broken"
   * state this whole design exists to avoid.
   */
  const currentUnlisted = current !== null && ticked < 0;

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
        aria-label={t('model.title')}
        data-testid="model-picker"
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
          inlineSize: 'min(560px, 94vw)',
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
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, minInlineSize: 0 }}>
            {t('model.title')}
            {props.sessionTitle && (
              <span style={{ fontWeight: 400, color: 'var(--muted)', marginInlineStart: 6 }}>
                {t('model.forSession', { title: props.sessionTitle })}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={close}
            aria-label={t('model.close')}
            title={t('model.close')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: 4,
            }}
          >
            {t('model.closeIcon')}
          </button>
        </div>

        {!liveId ? (
          <p style={{ margin: 0, padding: 14, fontSize: 11.5, color: 'var(--muted)' }}>
            {t('model.noSession')}
          </p>
        ) : loading ? (
          <p style={{ margin: 0, padding: 14, fontSize: 11.5, color: 'var(--muted)' }}>
            {t('model.loading')}
          </p>
        ) : models && models.length > 0 ? (
          <div role="radiogroup" aria-label={t('model.title')}>
            {models.map((m, i) => {
              // `on` is what the radiogroup SHOWS as chosen — your selection.
              // `data-current` stays the model the session is actually RUNNING,
              // because those are now two different facts and a surface that
              // conflated them is the bug this item is fixing.
              const on = i === selected;
              return (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-model={m.value}
                  data-selected={on ? 'yes' : undefined}
                  data-current={i === ticked ? 'yes' : undefined}
                  disabled={busy !== null}
                  onClick={() => choose(m)}
                  style={{
                    display: 'flex',
                    inlineSize: '100%',
                    alignItems: 'baseline',
                    gap: 10,
                    textAlign: 'start',
                    padding: '10px 14px',
                    background: on ? 'var(--panel2)' : 'transparent',
                    border: 'none',
                    borderBlockEnd: '1px solid var(--border)',
                    color: 'var(--text)',
                    cursor: busy ? 'default' : 'pointer',
                    font: 'inherit',
                  }}
                >
                  {/* The tick is a real character rather than a colour, so the
                      current row is legible without colour vision and in a
                      screenshot. `aria-checked` carries it for a reader.

                      ORDINARY INK, not an accent — the house rule the drift
                      test enforces is that an accent is a FIELD (a dot, a
                      stripe, a badge background) and words on one take the
                      neutral ink. The row already carries its state in a
                      `--panel2` fill and a heavier weight; the glyph does not
                      need a colour too. Caught by `tokens.drift.test.ts`. */}
                  <span aria-hidden style={{ inlineSize: 14, color: 'var(--text)' }}>
                    {on ? t('model.currentMark') : ''}
                  </span>
                  <span style={{ flex: 1, minInlineSize: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: on ? 600 : 500 }}>{label(m)}</span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 11,
                        color: 'var(--muted)',
                        marginBlockStart: 2,
                      }}
                    >
                      {rowSubtitle(m)}
                    </span>
                  </span>
                  {/* WHAT THE SESSION IS ACTUALLY RUNNING, said out loud once
                      the two can differ (#746). Staging moved the ✓, the fill
                      and `aria-checked` onto the row you CLICKED — correct,
                      because a radio expresses selection — but that left the
                      running model with no representation at all, visual or
                      assistive: while running Sonnet and staging Haiku, Sonnet
                      was indistinguishable from a model you had never used. */}
                  {i === ticked && !on && (
                    <span data-model-running style={{ fontSize: 10.5, color: 'var(--faint)' }}>
                      {t('model.runningNow')}
                    </span>
                  )}
                  {busy === m.value && (
                    <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {t('model.switching')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <p style={{ margin: 0, padding: 14, fontSize: 11.5, color: 'var(--muted)' }}>
            {models ? t('model.empty') : t('model.unavailable')}
          </p>
        )}

        {/* NOT KNOWN YET is said out loud, and only when there is a list to
            qualify. The CLI genuinely does not report a current model until the
            session has run a turn, and a picker with nothing ticked and no
            explanation looks broken rather than honest. */}
        {liveId && !loading && models && models.length > 0 && ticked < 0 && (
          <div
            data-model-unknown
            data-model-unlisted={currentUnlisted ? 'yes' : undefined}
            style={{
              padding: '10px 14px',
              borderBlockStart: '1px solid var(--border)',
              fontSize: 10.5,
              color: 'var(--faint)',
            }}
          >
            {currentUnlisted
              ? t('model.unlistedCurrent', { name: current })
              : t('model.unknownCurrent')}
          </div>
        )}

        {notice && (
          <div
            data-model-notice
            role="status"
            style={{
              padding: '8px 14px',
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              borderBlockStart: '1px solid var(--border)',
              color: notice.bad ? 'var(--status-crashed-ink)' : 'var(--muted)',
            }}
          >
            {notice.text}
          </div>
        )}

        <div
          style={{
            padding: '10px 14px',
            borderBlockStart: '1px solid var(--border)',
            fontSize: 10.5,
            color: 'var(--faint)',
          }}
        >
          {t('model.cliNote')}
        </div>

        {/* Commit semantics (#746). Clicking a row above chose something;
            nothing has been sent yet, and this row is where that becomes true
            or gets thrown away. Cancel is the same action as Escape and
            click-away, deliberately — three doors, one behaviour. */}
        {liveId && models && models.length > 0 && (
          <div
            style={{
              padding: '10px 14px',
              borderBlockStart: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {/* `role="status"` so this reaches a screen reader at all: a user
                arrowing the radiogroup never lands on a bare span, and this
                sentence is the only thing that says the tick is a PLAN rather
                than a fact. It names the running model for the same reason. */}
            <span
              data-model-staged={dirty ? 'yes' : undefined}
              role="status"
              style={{
                flex: 1,
                minInlineSize: 0,
                fontSize: 10.5,
                color: 'var(--faint)',
              }}
            >
              {!dirty
                ? ''
                : runningLabel
                  ? t('model.stagedFrom', { name: runningLabel })
                  : t('model.staged')}
            </span>
            <button
              type="button"
              data-model-cancel
              onClick={close}
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
              {t('model.cancel')}
            </button>
            <button
              type="button"
              data-model-ok
              // Nothing staged, or staged what it already runs, means OK has
              // nothing to do — and a button that sends a no-op `set_model`
              // would make "I pressed OK and nothing happened" ambiguous.
              disabled={!dirty || busy !== null || held}
              onClick={apply}
              style={{
                // The house BUTTON shape (`QuietHoursDialog`'s Close, which is
                // the nearest thing to a precedent — no dialog here has had a
                // confirm before): a chip fill and ordinary ink, with weight
                // rather than colour carrying the emphasis. NOT
                // `--accent`, which is a per-SESSION identity token — borrowing
                // it for a generic OK would make one dialog's button change
                // colour depending on which card opened it.
                background: 'var(--chip)',
                color: !dirty || busy !== null || held ? 'var(--muted)' : 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-chip)',
                padding: '4px 14px',
                cursor: !dirty || busy !== null || held ? 'default' : 'pointer',
                fontFamily: 'var(--font-ui)',
                fontSize: 11.5,
                fontWeight: 600,
              }}
            >
              {t('model.ok')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
