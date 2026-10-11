// How the history window reaches a conversation's prompts (#1237).
//
// The prompts live in the conversation view: it holds the loaded blocks, it
// is what can scroll to one, and its prompt box is what "Use again" writes
// into. The history window is opened from the card's title bar, a different
// part of the tree. So the conversation view PUBLISHES a small port under its
// session id while it is mounted, and the window looks it up when it opens.
//
// A module-level map and not React context: the two are siblings several
// levels apart, and a popped-out card is a second document in the SAME
// renderer, so one map serves both windows.
//
// NO PORT IS AN ANSWER, not an error: a session whose conversation view is
// not mounted has nothing to list, and the window says so.
import type { PromptEntry } from './prompt-history';

export interface PromptPort {
  /** the user's prompts in the loaded conversation, newest first */
  prompts(): readonly PromptEntry[];
  /** the view's buffer is full: older prompts exist and are not listed */
  truncated(): boolean;
  /** scroll the conversation to this prompt; false when it is no longer loaded */
  jump(seq: number): boolean;
  /** put this text back in the prompt box, keeping what is typed there */
  recall(text: string): void;
}

const ports = new Map<string, PromptPort>();

/** Publish a session's port. Returns the function that takes it back. */
export function registerPromptPort(sessionId: string, port: PromptPort): () => void {
  ports.set(sessionId, port);
  return () => {
    // only if it is still OURS: a second view of the same session that
    // mounted after this one has replaced it, and is the live one
    if (ports.get(sessionId) === port) ports.delete(sessionId);
  };
}

export function promptPortFor(sessionId: string | undefined): PromptPort | undefined {
  return sessionId ? ports.get(sessionId) : undefined;
}
