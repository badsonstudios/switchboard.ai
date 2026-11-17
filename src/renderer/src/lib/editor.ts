// "Open folder in editor" (#1608), the window's half: what the menus, the
// card header and the palette call, and whether there is an editor to call.
//
// Main decides everything that matters (which program, which folder; see
// `main/editor/editor-launch.ts`); this keeps one answer to "is there an
// editor?" so every place that offers the action can dim it when there is not,
// rather than offering a click that does nothing.
import * as React from 'react';
import i18next from 'i18next';
import { announce } from './live-region';

export interface EditorState {
  choice: string;
  customPath?: string;
  /** known editors found on this machine */
  installed: string[];
  /** the program that would run, or null when none is set up */
  resolved: string | null;
}

type EditorBridge = {
  get(): Promise<EditorState>;
  set(pref: { choice: string; customPath?: string }): Promise<boolean>;
  openFolder(cardId: string): Promise<'opened' | 'no-editor' | 'no-folder'>;
};

function bridge(): EditorBridge | undefined {
  return (window as unknown as { switchboard?: { editor?: EditorBridge } }).switchboard?.editor;
}

let state: EditorState | null = null;
const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Ask main again (at start, and after Settings changes the choice). */
export async function refreshEditor(): Promise<void> {
  try {
    const next = await bridge()?.get();
    if (next) {
      state = next;
      emit();
    }
  } catch {
    /* fail-open: the action stays as it was */
  }
}

/** Settings: store a choice, then show what it resolves to. */
export async function chooseEditor(choice: string, customPath?: string): Promise<void> {
  try {
    await bridge()?.set({ choice, ...(customPath ? { customPath } : {}) });
  } finally {
    await refreshEditor();
  }
}

export function useEditorState(): EditorState | null {
  return React.useSyncExternalStore(
    subscribe,
    () => state,
    () => null
  );
}

/** Whether "Open folder in editor" can do anything right now. Unknown = yes:
 *  main answers for real when it is pressed. */
export function editorAvailable(): boolean {
  return state === null || state.resolved !== null;
}

/** Open a session's folder in the chosen editor; says so when it cannot. */
export function openFolderInEditor(cardId: string): void {
  const b = bridge();
  if (!b) return;
  void b
    .openFolder(cardId)
    .then((r) => {
      if (r === 'no-editor') announce(String(i18next.t('editor.noEditor')));
      else if (r === 'no-folder') announce(String(i18next.t('editor.noFolder')));
    })
    .catch(() => undefined);
}

/** Tests only. */
export function resetEditorForTests(next: EditorState | null = null): void {
  state = next;
  emit();
}
