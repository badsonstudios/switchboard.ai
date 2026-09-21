// The settings modal's shared furniture (#885).
//
// Three dialogs were folded into one screen, and each brought its own copy of
// the same button and the same row. One copy here, so a change to the house
// shape cannot land on two sections out of three — which is exactly how the
// three dialogs drifted apart in the first place.
import React from 'react';

/**
 * The house dialog button — `PushSetupDialog`'s `DialogButton`, moved rather
 * than re-typed. `QuietHoursDialog`'s Close and `AboutPanel`'s buttons were
 * already the same nine declarations; this is the one they were all copies of.
 */
export function SettingsButton(props: {
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

/**
 * One setting, or one cluster of them: a name, an optional sentence saying what
 * it does, and the control.
 *
 * The blurb is not decoration. Every one of these controls used to open its own
 * dialog with a paragraph of intro at the top, and folding them into a list
 * would have thrown that away — a settings screen of fifteen bare labels is the
 * thing §5.32 calls a control you have to try in order to understand.
 */
export function SettingItem(props: {
  /**
   * The `data-settings-item` hook — the stable handle for tests.
   *
   * NOT called `id`, which is what it wants to be called. `markdown.test.tsx`
   * scans the renderer for a literal `id="…"` in JSX (#654) and cannot tell a
   * React prop from a DOM attribute — nor should it have to, since the whole
   * point of that rule is that a published id is a name rendered content can
   * address. One word avoids nine exemptions in a guard that is only worth
   * having while it has none.
   */
  item: string;
  label: string;
  blurb?: string;
  /** `true` when the control IS the label (a checkbox with its own text) */
  unlabelled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div data-settings-item={props.item} style={{ display: 'grid', gap: 6 }}>
      {!props.unlabelled && (
        <span style={{ fontSize: 12, fontWeight: 600 }}>{props.label}</span>
      )}
      {props.blurb && (
        <span style={{ fontSize: 11, color: 'var(--faint)', maxInlineSize: '46em' }}>
          {props.blurb}
        </span>
      )}
      {props.children}
    </div>
  );
}

/** The gap between the items inside one section. */
export const itemListStyle: React.CSSProperties = {
  display: 'grid',
  gap: 16,
  padding: '14px 16px',
};

/** A checkbox plus its words, the shape every absorbed dialog already used. */
export function SettingCheckbox(props: {
  /** the `data-settings-field` hook */
  field: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  title?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label
      title={props.title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11.5,
        cursor: props.disabled ? 'default' : 'pointer',
      }}
    >
      <input
        type="checkbox"
        data-settings-field={props.field}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.children}
    </label>
  );
}
