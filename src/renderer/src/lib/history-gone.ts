// A history pick whose folder is GONE (#1643): the question the picker asks
// instead of opening a card in a folder that cannot start one.
//
// The conversation is still on disk, and the CLI resumes it by id from any
// folder (`spike/findings/1638-transcripts-after-removal.md`), so the only
// thing to decide is WHERE. Main suggests the main folder of the project the
// gone folder belonged to (`reopenIn`); the user can always pick another.
import type { TFunction } from 'i18next';
import type { HistoryConfirm, HistoryPick } from '../components/SessionHistoryDialog';
import { baseName } from './document-kind';

export interface GoneFolderActions {
  /** reopen the conversation in this folder */
  reopen: (target: string) => void;
  /** ask the user for a folder, then reopen it there */
  choose: () => void;
  /** not now: back to the list */
  cancel: () => void;
}

export function goneFolderQuestion(pick: HistoryPick, t: TFunction, act: GoneFolderActions): HistoryConfirm {
  const name = pick.description?.trim() || t('sessionHistory.stopUnnamed');
  const base = {
    title: t('sessionHistory.gone.title'),
    message: t('sessionHistory.gone.message', { name, folder: pick.folder }),
    cancelLabel: t('sessionHistory.gone.cancel'),
    onCancel: act.cancel,
    // nothing is thrown away by either answer, so neither waits to be read
    immediate: true,
  };
  const target = pick.reopenIn;
  if (target) {
    return {
      ...base,
      confirmLabel: t('sessionHistory.gone.reopenIn', { name: baseName(target) }),
      onConfirm: () => act.reopen(target),
      alternateLabel: t('sessionHistory.gone.choose'),
      onAlternate: act.choose,
    };
  }
  return { ...base, confirmLabel: t('sessionHistory.gone.choose'), onConfirm: act.choose };
}
