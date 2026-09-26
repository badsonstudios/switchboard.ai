// The dispatch dialog (P2-E13-03, §5.15 Trigger 1).
//
// ── WHY THERE IS A DIALOG AT ALL ────────────────────────────────────────────
//
// The issue asked for `Dispatch → <template>` from the ⋯ menu and the palette,
// which reads like it wants no dialog: pick the role, go. Two measurements say
// otherwise, and one of them is #947's, filed on this issue for this decision.
//
// 1. **THE TASK STATEMENT IS OFTEN USELESS, AND WORST IN OUR OWN CASE.** Run
//    against this repo's real 7.7 MB transcript, `SessionQueries.taskStatement`
//    answers `"do it."` — honestly, because that is the first prose the user
//    typed; what precedes it is a slash command (skipped as plumbing, #846) and
//    an `isMeta` line carrying the skill body. A clean-room bundle is DEFINED by
//    withholding everything else, so that one field has to carry the job, and it
//    is the field most likely to be empty. Dispatching with no chance to fix it
//    would hand a reviewer a review of nothing — and #950's round-trip is built
//    on top of whatever this produces.
// 2. **A REFUSAL HAS TO BE READABLE BEFORE A TURN IS SPENT.** A `full` template
//    is refused when the fork flag is off, when the target is a different
//    provider, and when the author session has not had a turn (#947). Some of
//    those cannot be known until `dispatch:prepare` runs. A menu row can grey
//    itself out for the first; only a dialog can show the other two without
//    having already started a session.
//
// So: one dialog, reached from both entry points, with the template preselected
// when the palette named one. `acceptanceCriteria` was already a caller-supplied
// field on #947's request; the task line is the field this dialog is the caller
// for.
//
// ── WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────────────
//
// A template EDITOR. #946 ships the built-ins as code and user templates as rows
// in `workspace.json`, and nothing in this item's done-when needs a way to author
// one. Adding a half-editor here would put the same fields in two places before
// anybody had decided where they belong.
//
// The dialog SHAPE — scrim, click-away, Escape, focus capture and restore, a
// radiogroup, Cancel/commit semantics — is `ContextDropDialog`'s, which is
// `ModelPickerDialog`'s, which is `SettingsDialog`'s. Two modals that behave
// differently is a bug report waiting to happen.
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DispatchOptions, DispatchPrepared } from '../../../shared/dispatch-wire';

export interface DispatchDialogProps {
  /** the AUTHOR session's name, for the header */
  fromName: string;
  options: DispatchOptions;
  /** preselect this template — the palette entry that opened the dialog */
  initialTemplateId?: string;
  onCancel: () => void;
  /**
   * Build the briefing. Resolves the refusal rather than throwing, so the dialog
   * can show it in place instead of closing over an error nobody sees.
   */
  onPrepare: (req: {
    templateId: string;
    /**
     * ABSENT when the chosen policy does not read it, EMPTY when the user cleared
     * it, and the difference is load-bearing (`dispatch-context.ts`): absent means
     * "read the transcript", empty means "the user says it is not known". Only
     * `clean-room` is offered the field at all, so only `clean-room` ever sends it.
     */
    taskStatement?: string;
    acceptanceCriteria?: string;
  }) => Promise<DispatchPrepared>;
  /**
   * It worked — spawn the card. The dialog is closed by the caller.
   *
   * The prepared answer carries everything the spawn needs (the handle, the
   * folder, the role's name for the title), so the chosen template is
   * deliberately NOT passed alongside it: two descriptions of one dispatch is two
   * things that can disagree about which role was picked.
   */
  onDispatch: (prepared: DispatchPrepared & { ok: true }) => void;
}

const fieldStyle: React.CSSProperties = {
  inlineSize: '100%',
  boxSizing: 'border-box',
  background: 'var(--bg)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '5px 8px',
  fontFamily: 'var(--font-ui)',
  fontSize: 12,
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11.5,
  fontWeight: 600,
  marginBlockEnd: 4,
};

const hintStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 10.5,
  color: 'var(--faint)',
  marginBlockStart: 4,
};

export function DispatchDialog(props: DispatchDialogProps): React.JSX.Element {
  const { t } = useTranslation();
  const dialog = React.useRef<HTMLDivElement | null>(null);
  const { templates } = props.options;
  /**
   * ⚠️ `useId`, NEVER A LITERAL — #654's rule, and `markdown.test.tsx` enforces it
   * across the whole renderer.
   *
   * A stable string typed in place can be NAMED by content: a feed block rendering
   * `<label for="dispatch-task">` would attach a label of the model's choosing to
   * this dialog's own input. Every `htmlFor` in this app derives from `useId` for
   * that reason.
   */
  const taskId = React.useId();
  const criteriaId = React.useId();

  /**
   * FIRST DISPATCHABLE, not simply first.
   *
   * `allTemplates` puts the built-ins first and Code Reviewer is first among them
   * — the order #946 chose deliberately, and the right default. But a row can be
   * refused (a `full` template with the fork flag off), and opening on a refused
   * row would mean a dialog whose Dispatch button is dead before the user has
   * touched anything. The named template from the palette still wins, refused or
   * not: the user said which one, and seeing WHY it cannot run is the answer.
   */
  const [chosenId, setChosenId] = React.useState<string>(
    () =>
      props.initialTemplateId ??
      templates.find((x) => x.refusalKey === undefined)?.id ??
      templates[0]?.id ??
      ''
  );
  const [task, setTask] = React.useState(props.options.taskStatement ?? '');
  const [criteria, setCriteria] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  /** a refusal from `prepare`, shown in place. The dialog stays open. */
  const [failed, setFailed] = React.useState<DispatchPrepared & { ok: false } | null>(null);
  const returnFocusTo = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    returnFocusTo.current = document.activeElement as HTMLElement | null; // before we take it
    dialog.current?.focus();
  }, []);

  const close = (): void => {
    props.onCancel();
    // …on the NEXT frame: this element still holds focus until React has
    // committed the unmount. The same shape the other overlays use.
    const el = returnFocusTo.current;
    requestAnimationFrame(() => el?.focus?.());
  };

  const chosen = templates.find((x) => x.id === chosenId);
  // THE ROW'S OWN REASON, not a general "cannot dispatch": each refusal key names
  // a different fix, which is the whole reason #946 returns keys rather than a
  // boolean.
  const blockedKey = chosen?.refusalKey;
  const canGo = !!chosen && blockedKey === undefined && !busy;

  const go = (): void => {
    if (!chosen || !canGo) return;
    setBusy(true);
    setFailed(null);
    // SENT ONLY FOR THE POLICY THAT READS THEM — the same rule that decides
    // whether the fields are on screen, applied to what leaves. Sending a value
    // the other policies ignore would put a stale task from a previously selected
    // clean-room template on the wire, and would make `dispatch-context.ts`'s
    // "absent means read the transcript" a branch no UI could ever reach.
    const artifact = chosen.contextPolicy === 'clean-room';
    void props
      .onPrepare({
        templateId: chosen.id,
        ...(artifact ? { taskStatement: task, acceptanceCriteria: criteria } : {}),
      })
      .then((answer) => {
        if (!answer.ok) {
          setBusy(false);
          setFailed(answer);
          return;
        }
        // The caller closes the dialog and spawns the card. `busy` is left ON so
        // a double-press between this line and the unmount cannot prepare twice
        // — a second prepare would be a second briefing held in main, and a
        // second card.
        props.onDispatch(answer);
      })
      .catch((err: unknown) => {
        // The bridge rejected — a broker capability refusal, or the window going
        // away mid-call. Shown rather than swallowed: a Dispatch button that does
        // nothing at all is the one outcome with no explanation in it.
        setBusy(false);
        setFailed({ ok: false, reason: String(err) });
      });
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
        paddingBlockStart: '8vh',
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t('dispatch.title')}
        data-testid="dispatch-dialog"
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
          inlineSize: 'min(600px, 94vw)',
          maxBlockSize: '84vh',
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
            {t('dispatch.title')}
            <span style={{ fontWeight: 400, color: 'var(--muted)', marginInlineStart: 6 }}>
              {t('dispatch.from', { from: props.fromName })}
            </span>
          </span>
          <button
            type="button"
            onClick={close}
            aria-label={t('dispatch.close')}
            title={t('dispatch.close')}
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
            {t('dispatch.closeIcon')}
          </button>
        </div>

        {/* §5.15's own distinction, said where the decision is made: a dispatched
            session is a full PEER, not a subagent. Someone who thinks this is a
            helper thread will not understand why it asks its own questions or why
            it does not know what they just said. */}
        <div
          style={{
            padding: '9px 14px',
            borderBlockEnd: '1px solid var(--border)',
            fontSize: 11,
            color: 'var(--muted)',
          }}
        >
          {t('dispatch.intro')}
        </div>

        {templates.length === 0 ? (
          <div style={{ padding: '14px', fontSize: 11.5, color: 'var(--status-crashed-ink)' }}>
            {t('dispatch.noTemplates')}
          </div>
        ) : (
          <div role="radiogroup" aria-label={t('dispatch.role')}>
            {templates.map((x) => {
              const on = x.id === chosenId;
              return (
                <button
                  // THE ID IS SAFE AS A KEY because main deduped the list —
                  // `dispatch-ipc.ts`'s `offered`, and #946's review is the reason
                  // it had to: `keepSane` does not dedupe by id, so a hand-edited
                  // `workspace.json` could otherwise render two rows with one key
                  // here. Fixed at the source rather than papered over with an
                  // index, so every future surface inherits it.
                  key={x.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-dispatch-template={x.id}
                  data-selected={on ? 'yes' : undefined}
                  data-dispatch-refused={x.refusalKey ? 'yes' : undefined}
                  // NOT `disabled`, and this is the one place this dialog differs
                  // from a plain picker on purpose. A disabled row cannot be
                  // focused, so a keyboard user could never reach the row that
                  // explains itself — and the explanation is the whole value of
                  // showing a refused template instead of hiding it. The row
                  // selects; the Dispatch button is what refuses.
                  onClick={() => setChosenId(x.id)}
                  style={{
                    display: 'flex',
                    inlineSize: '100%',
                    alignItems: 'baseline',
                    gap: 10,
                    textAlign: 'start',
                    padding: '9px 14px',
                    background: on ? 'var(--panel2)' : 'transparent',
                    border: 'none',
                    borderBlockEnd: '1px solid var(--border)',
                    color: x.refusalKey ? 'var(--muted)' : 'var(--text)',
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                >
                  {/* A real character rather than a colour, so the chosen row is
                      legible without colour vision and in a screenshot;
                      `aria-checked` carries it for a reader (§5.32). */}
                  <span aria-hidden style={{ inlineSize: 14, color: 'var(--text)' }}>
                    {on ? t('dispatch.currentMark') : ''}
                  </span>
                  <span style={{ flex: 1, minInlineSize: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: on ? 600 : 500 }}>
                      {/* A TEMPLATE NAME IS DATA, NOT A CATALOGUE KEY. #946 says
                          so out loud: the built-ins' names are "DATA that happens
                          to be words, an identity a user can replace by copying".
                          So it is rendered, not translated — and a user template
                          named in Japanese shows up in Japanese. */}
                      {x.name}
                      {x.builtIn && (
                        <span
                          style={{
                            fontWeight: 400,
                            color: 'var(--faint)',
                            fontSize: 10.5,
                            marginInlineStart: 6,
                          }}
                        >
                          {t('dispatch.builtInMark')}
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 11,
                        color: 'var(--muted)',
                        marginBlockStart: 2,
                      }}
                    >
                      {/* WHAT IT IS HANDED, THEN WHERE IT RUNS — §5.15's two
                          per-template policies, and until #949 the row named
                          only the first. That made "declared and refused" half
                          true in both directions: a `fresh-worktree` row showed
                          a red sentence refusing a worktree it had never said
                          it wanted, and `same-folder` — the one that ships, and
                          the one with the consequence worth knowing — was
                          invisible. Three words, because the refusal underneath
                          is already the paragraph. */}
                      {t(`dispatch.policy.${x.contextPolicy}`)}
                      <span style={{ color: 'var(--faint)', marginInlineStart: 5 }}>
                        {/* THE DOT IS A SEPARATE, `aria-hidden` SPAN, and both
                            halves of that matter. A bare `{' · '}` is a JSX
                            string literal, which §5.21's lint rule refuses; a
                            dot folded into the phrase's own catalogue value is
                            punctuation a screen reader reads out mid-sentence,
                            which is what `currentMark` above is aria-hidden to
                            avoid. Every space here is CSS, so no catalogue value
                            carries whitespace nobody can see in review. */}
                        <span aria-hidden style={{ marginInlineEnd: 4 }}>
                          {t('dispatch.policySeparator')}
                        </span>
                        {t(`dispatch.workspace.${x.workspacePolicy}`)}
                      </span>
                    </span>
                    {/* THE REFUSAL IS ON THE ROW, not only on the button. Which
                        row cannot run, and why, are one fact. */}
                    {x.refusalKey && (
                      <span
                        style={{
                          display: 'block',
                          fontSize: 10.5,
                          color: 'var(--status-crashed-ink)',
                          marginBlockStart: 3,
                        }}
                      >
                        {t(x.refusalKey)}
                      </span>
                    )}
                  </span>
                  {/* WHAT IT WILL RUN AT, in the app's own autonomy vocabulary —
                      #946's point that a template's autonomy IS `AutonomyMode`
                      and not a second spelling of it. It is here because nobody
                      watching would otherwise learn that a reviewer runs under
                      Claude's own write block. */}
                  <span
                    style={{
                      fontSize: 10.5,
                      color: 'var(--faint)',
                      flexShrink: 0,
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {t('dispatch.autonomyMark', { autonomy: t(`autonomy.${x.autonomy}`) })}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* ── WHERE IT WILL RUN (#949) ──────────────────────────────────────
            Dispatch v1 ships one workspace policy and this is it said out
            loud, with the actual path, before a turn is spent. It matters more
            than it looks: a reviewer in the author's own folder runs its tests
            against the tree the author is editing, which is precisely the
            surprise §5.7's isolation caveat is about — and the reason
            `fresh-worktree` is refused rather than silently downgraded.

            ⚠️ SHOWN ONLY WHEN THE ROLE WILL ACTUALLY RUN, and the predicate is
            the whole refusal rather than the workspace half of it. Review
            caught the narrower version: the `full`-with-the-fork-flag-off row
            has a perfectly good `same-folder` policy, so a workspace-only check
            printed "Runs in C:/…" directly beneath a red sentence saying it
            could not be dispatched at all. A statement about where something
            runs is only true of something that runs.

            BELOW THE LIST, NOT ABOVE IT. Also review: above the radiogroup it
            appeared and disappeared as the selection changed, which yanked
            every role row up and down under the pointer — a second click after
            selecting a refused role landed on a different row. The folder
            itself is MAIN's answer (`DispatchOptions.folder`), not this
            component's idea of the card. */}
        {props.options.folder !== undefined &&
          chosen?.refusalKey === undefined &&
          chosen?.workspacePolicy === 'same-folder' && (
            <div
              data-testid="dispatch-runs-in"
              style={{
                padding: '9px 14px',
                borderBlockEnd: '1px solid var(--border)',
                fontSize: 10.5,
                color: 'var(--faint)',
                // A path has no spaces to break at, and this dialog caps at
                // 600px — the same reason `FeedView` breaks the paths it renders.
                overflowWrap: 'anywhere',
              }}
            >
              {t('dispatch.runsIn', { folder: props.options.folder })}
            </div>
          )}

        {/* ── THE TASK AND THE CRITERIA, which are why this dialog exists ───

            ⚠️ SHOWN ONLY FOR THE POLICY THAT READS THEM, which is `clean-room`.
            Found in review, and it was a false promise rather than a cosmetic
            slip: `dispatch-context.ts`'s `context-package` branch reads neither
            field — #766's package derives its own Goal, and a second source for
            the same fact is precisely the drift #947 refused to introduce — so
            with these boxes always on screen, someone carefully writing a task
            for a PR Author got a PR authored from a package that never saw it.
            The copy asserted the effect too ("this is the only way the dispatched
            session learns them").

            Hiding them is the better half of the fix rather than threading them
            into the other two policies: it keeps ONE answer per fact, and it
            teaches something true — clean-room is the policy that needs you to
            state the task, because it has nothing else to go on. */}
        {chosen?.contextPolicy === 'clean-room' && (
          <>
            <div style={{ padding: '12px 14px', borderBlockEnd: '1px solid var(--border)' }}>
              <label style={labelStyle} htmlFor={taskId}>
                {t('dispatch.taskLabel')}
              </label>
              {/* ⚠️ A TEXTAREA, NOT AN `<input type="text">`. Also review: an
                  opening prompt is routinely MULTI-LINE, and HTML's value
                  sanitisation strips CR/LF from a text input — so a prefilled
                  "Do X.\nAlso Y." silently became "Do X.Also Y." and, because the
                  field is always sent, main never saw the original. */}
              <textarea
                id={taskId}
                data-testid="dispatch-task"
                rows={2}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder={t('dispatch.taskPlaceholder')}
                style={{ ...fieldStyle, resize: 'vertical' }}
              />
              <span style={hintStyle}>{t('dispatch.taskHint')}</span>
              {/* A BLANK LINE IS A CHOICE AND IS HONOURED AS ONE (see
                  `dispatch-context.ts`): main does not silently put the
                  transcript's answer back. So say what blank will produce, rather
                  than letting someone clear the box and expect the default. */}
              {task.trim() === '' && <span style={hintStyle}>{t('dispatch.taskEmpty')}</span>}
            </div>

            <div style={{ padding: '12px 14px', borderBlockEnd: '1px solid var(--border)' }}>
              <label style={labelStyle} htmlFor={criteriaId}>
                {t('dispatch.criteriaLabel')}
              </label>
              <textarea
                id={criteriaId}
                data-testid="dispatch-criteria"
                rows={2}
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                placeholder={t('dispatch.criteriaPlaceholder')}
                style={{ ...fieldStyle, resize: 'vertical' }}
              />
              <span style={hintStyle}>{t('dispatch.criteriaHint')}</span>
            </div>
          </>
        )}
        {/* …and say WHY they are absent for the other two, rather than letting the
            box look shorter for no reason. A briefed role is handed the goal and
            the decisions the conversation actually recorded; there is nothing for
            the user to state. */}
        {chosen !== undefined && chosen.contextPolicy !== 'clean-room' && (
          <div
            data-testid="dispatch-no-fields"
            style={{
              padding: '12px 14px',
              borderBlockEnd: '1px solid var(--border)',
              fontSize: 10.5,
              color: 'var(--faint)',
            }}
          >
            {t('dispatch.noTaskFields')}
          </div>
        )}

        {failed && (
          <div
            data-testid="dispatch-failed"
            style={{
              padding: '10px 14px',
              borderBlockEnd: '1px solid var(--border)',
              fontSize: 11,
              color: 'var(--status-crashed-ink)',
            }}
          >
            {/* THE KEY WHEN THERE IS ONE, the developer's sentence when there is
                not. `DispatchContextResult` draws that line deliberately: a
                `reasonKey` is present exactly when there is something the user can
                act on, and an unresolvable session from a gesture that started on
                a real card is a bug, not a state. Showing the raw reason for those
                beats showing nothing. */}
            {failed.reasonKey ? t(failed.reasonKey) : t('dispatch.failed', { reason: failed.reason })}
          </div>
        )}

        <div
          style={{
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, minInlineSize: 0, fontSize: 10.5, color: 'var(--faint)' }}>
            {chosen?.contextPolicy === 'full' ? t('dispatch.handsOverFork') : null}
          </span>
          <button
            type="button"
            data-testid="dispatch-cancel"
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
            {t('dispatch.cancel')}
          </button>
          <button
            type="button"
            data-testid="dispatch-go"
            disabled={!canGo}
            title={blockedKey ? t(blockedKey) : undefined}
            onClick={go}
            style={{
              background: 'var(--chip)',
              color: canGo ? 'var(--text)' : 'var(--muted)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-chip)',
              padding: '4px 14px',
              cursor: canGo ? 'pointer' : 'default',
              fontFamily: 'var(--font-ui)',
              fontSize: 11.5,
              fontWeight: 600,
            }}
          >
            {busy ? t('dispatch.working') : t('dispatch.go')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What a dispatched card is called — the role, then whose work it is.
 *
 * Built through `t` rather than concatenated, and built in the RENDERER rather
 * than in main, for §5.21's reason: the connecting word is user-visible chrome and
 * belongs in the catalogue, while the template's name is data. Main has no `t`.
 *
 * ⚠️ NOT §5.15's "↳ Review of X", which is the RAIL's lineage nesting and is #951.
 * This is only the card's own title, and it is deliberately the simpler thing: a
 * title that tried to be the nesting would have to be unpicked when the real
 * nesting arrives.
 */
export function dispatchedTitle(
  t: (key: string, params?: Record<string, unknown>) => string,
  templateName: string,
  fromName: string
): string {
  return t('dispatch.sessionTitle', { role: templateName, session: fromName });
}
