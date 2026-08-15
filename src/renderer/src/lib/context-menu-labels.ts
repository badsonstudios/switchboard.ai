// The renderer's half of the right-click edit menus (#526).
//
// The MENU is built in the browser process — only it can offer a Cut/Copy/Paste
// that reaches the system clipboard and fires the trusted DOM events the
// composer's attachment pipeline listens for (`main/context-menu.ts` says why at
// length). But main has no i18next: `app-menu.ts` hardcodes English precisely
// because the resources live in this bundle. So the STRINGS travel the other
// way — resolved here, pushed once at boot and again on every language change.
//
// Not a React hook, and not inside a component: the menu belongs to every
// window including the popouts, which run no JS of their own, so there is no
// component whose lifetime matches it. This is a module that runs once next to
// `initI18n()`.
import type { i18n as I18nInstance } from 'i18next';
import type { ContextMenuLabels } from '../../../shared/context-menu';

/** Resolve the four strings from an i18next instance. Exported for the test. */
export function contextMenuLabels(i18n: I18nInstance): ContextMenuLabels {
  const t = (key: string): string => String(i18n.t(`contextMenu.${key}`));
  return { cut: t('cut'), copy: t('copy'), paste: t('paste'), selectAll: t('selectAll') };
}

/**
 * Publish the labels now, and again whenever the language changes.
 *
 * Fail-open on every edge (PHILOSOPHY §3): no bridge, a throwing `t`, a main
 * process that refuses the channel — main already holds English defaults, so
 * the worst case is a menu in the wrong language rather than no menu.
 *
 * @returns an unsubscribe, for tests. The app never calls it.
 */
export function publishContextMenuLabels(i18n: I18nInstance): () => void {
  const send = (): void => {
    try {
      window.switchboard?.setContextMenuLabels?.(contextMenuLabels(i18n));
    } catch {
      /* main keeps the last good set, or English */
    }
  };
  send();
  i18n.on('languageChanged', send);
  return () => i18n.off('languageChanged', send);
}
