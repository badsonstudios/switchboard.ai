// The two settings that are about ONE session, on that session's own card
// (#1168): what happens to it when you submit, and what happens when it needs
// you.
//
// They were on the session's right-click menu in the left list, and nowhere on
// the strip across the top — so the same right-click gave two different menus
// depending on where the list was. The owner picked one short menu for both
// places and these moved here: they are settings about one session, and the
// card IS that session.
//
// TWO ROWS, EACH A NATIVE <select>, and not the two ticked lists the old menu
// had. Nine more buttons would have made the card's menu about twice as tall,
// and that menu already clips on a tight split (#695); a select costs one row
// and its list is drawn by the platform, outside whatever is clipping the menu.
// It also brings its own keyboard (arrows, typeahead, Escape), which matters
// here because this menu is a plain box of buttons with no arrow walk of its
// own — see the note on `aria-pressed` in SessionGrid's menu.
//
// Reads and writes the STORE, like everything else on the card: a card is a
// dockview panel and cannot be handed props by App.
import React from 'react';
import { useTranslation } from 'react-i18next';
import { sessionStore } from '../store/session-store';
import {
  cardOverride,
  POLICY_ORDER,
  PresentationPolicy,
  resolvePolicy,
  withCard,
} from '../lib/presentation-policy';
import {
  FOCUS_POLICY_ORDER,
  FocusPolicy,
  focusOverride,
  resolveFocusPolicy,
  withFocusCard,
} from '../lib/focus-policy';

const subscribeStore = (cb: () => void): (() => void) => sessionStore.subscribe(cb);

/** "Follow the default" is `undefined` in the book, never the value the default
 *  happens to hold today — otherwise leaving an override would silently pin the
 *  session to whatever the default said at that moment. This is its <option>. */
const DEFAULT = 'default';

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '3px 8px',
};

const nameStyle: React.CSSProperties = {
  flex: 'none',
  color: 'var(--muted)',
  whiteSpace: 'nowrap',
};

const selectStyle: React.CSSProperties = {
  flex: 1,
  minInlineSize: 0,
  background: 'var(--panel2)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 5,
  padding: '2px 4px',
  fontFamily: 'var(--font-ui)',
  fontSize: 11,
};

export function CardPolicyRows(props: { cardId: string }): React.JSX.Element {
  const { t } = useTranslation();
  const { cardId } = props;
  const policies = React.useSyncExternalStore(subscribeStore, () => sessionStore.getPolicies());
  const focusPolicies = React.useSyncExternalStore(subscribeStore, () =>
    sessionStore.getFocusPolicies()
  );
  // the presentation default has a group level in between, so what "the
  // default" means for this session depends on the group it is in
  const groupId = React.useSyncExternalStore(
    subscribeStore,
    () => sessionStore.getState().sessions.find((s) => s.id === cardId)?.groupId
  );
  const submitId = React.useId();
  const needsId = React.useId();

  return (
    <div data-testid="card-policy-rows">
      <div style={rowStyle}>
        <label htmlFor={submitId} style={nameStyle}>
          {t('ladder.policyMenu')}
        </label>
        <select
          id={submitId}
          data-testid="card-policy"
          value={cardOverride(policies, cardId) ?? DEFAULT}
          onChange={(e) => {
            const v = e.target.value;
            // read-then-write on the store's own book, not the rendered one: a
            // handler acts on what is true now
            sessionStore.setPolicies(
              withCard(
                sessionStore.getPolicies(),
                cardId,
                v === DEFAULT ? undefined : (v as PresentationPolicy)
              ),
              'card menu'
            );
          }}
          style={selectStyle}
        >
          <option value={DEFAULT}>
            {t('ladder.policyDefault', {
              policy: t(`policy.${resolvePolicy({ ...policies, cards: {} }, cardId, groupId)}`),
            })}
          </option>
          {POLICY_ORDER.map((p) => (
            <option key={p} value={p}>
              {t(`policy.${p}`)}
            </option>
          ))}
        </select>
      </div>
      <div style={rowStyle}>
        <label htmlFor={needsId} style={nameStyle}>
          {t('ladder.focusMenu')}
        </label>
        <select
          id={needsId}
          data-testid="card-focus-policy"
          value={focusOverride(focusPolicies, cardId) ?? DEFAULT}
          onChange={(e) => {
            const v = e.target.value;
            sessionStore.setFocusPolicies(
              withFocusCard(
                sessionStore.getFocusPolicies(),
                cardId,
                v === DEFAULT ? undefined : (v as FocusPolicy)
              )
            );
          }}
          style={selectStyle}
        >
          <option value={DEFAULT}>
            {t('ladder.focusDefault', {
              policy: t(
                `focusPolicy.${resolveFocusPolicy({ ...focusPolicies, cards: {} }, cardId)}`
              ),
            })}
          </option>
          {FOCUS_POLICY_ORDER.map((p) => (
            <option key={p} value={p}>
              {t(`focusPolicy.${p}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
