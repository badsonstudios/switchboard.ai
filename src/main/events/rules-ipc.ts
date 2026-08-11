// Notification-rule IPC (P2-E14-03, §5.9).
//
// Three channels, and deliberately only three. v1 ships ONE rule the user can
// write — the per-session "notify when done" checkbox — so the write surface
// is that checkbox and nothing else: no arbitrary rule from the renderer, no
// action type it can name. When a rules EDITOR arrives it adds `rules:upsert`
// with validation here, and `rules:list` is already the read half.
//
// Refusals follow the house shape (`workspace/group-ipc.ts`): a VALUE back to
// the caller plus one line in the log, never a throw.
import { IpcBroker } from '../ipc/broker';
import { LogFields, Logger } from '../log/logger';
import { WorkspaceStore } from '../workspace/store';
import { Rule, notifyWhenDoneFor, notifyWhenDoneRule } from './rules';

export interface RulesIpcDeps {
  broker: IpcBroker;
  log: Logger;
  store: WorkspaceStore;
  /** does this card exist? An unknown card gets no rule — a rule scoped to a
   *  card that is not in the workspace can never fire and never be found. */
  knownCard: (cardId: string) => boolean;
}

export function registerRulesIpc(deps: RulesIpcDeps): void {
  const { broker, log, store } = deps;

  const refuse = (channel: string, reason: string, fields: LogFields = {}): false => {
    log.warn(`${channel} refused: ${reason}`, fields);
    return false;
  };

  broker.handle('rules:list', (): Rule[] => store.listRules());

  broker.handle('rules:notifyWhenDone', (_e, cardId: string): boolean => {
    if (typeof cardId !== 'string') return refuse('rules:notifyWhenDone', 'cardId must be a string');
    return notifyWhenDoneFor(store.listRules(), cardId);
  });

  /**
   * Tick / untick the box. Answers the state the store now holds — so a
   * refused write reverts the checkbox to the truth rather than leaving the UI
   * asserting something the store never agreed to.
   */
  broker.handle('rules:setNotifyWhenDone', (_e, cardId: string, on: unknown): boolean => {
    if (typeof cardId !== 'string')
      return refuse('rules:setNotifyWhenDone', 'cardId must be a string');
    if (typeof on !== 'boolean')
      return refuse('rules:setNotifyWhenDone', 'the value must be true or false', { cardId });
    if (!deps.knownCard(cardId))
      return refuse('rules:setNotifyWhenDone', 'unknown card', { cardId });
    const rule = notifyWhenDoneRule(cardId);
    if (on) store.upsertRule(rule);
    else store.removeRule(rule.id);
    log.info('notify-when-done changed', { cardId, on });
    return notifyWhenDoneFor(store.listRules(), cardId);
  });
}
