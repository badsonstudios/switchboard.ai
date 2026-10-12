// The pictures that arrived inside a conversation (#1240), held in main.
//
// A tool can answer with a picture (a `Read` of a `.png`, a screenshot from an
// MCP tool) and a prompt can carry one. Both arrive as base64 inside the
// message, and until this the Feed flattened a tool result to its text and
// counted a prompt's pictures, so neither was ever seen.
//
// THE BYTES NEVER CROSS TO THE PAGE AS DATA. The content policy refuses `data:`
// and `blob:` on purpose, and a Feed block that carried a megabyte of base64
// would be cloned over IPC on every re-emit. So a block carries a HANDLE, this
// store keeps what the handle names, and the page's `<img>` asks main for it
// through the picture scheme (`fs/doc-image.ts`, the `feed` host).
//
// A HANDLE NAMES ONE PICTURE FOR EVER. It is minted at random when the message
// is read and is never reused, so the worst a stale `<img>` can be answered
// with is nothing: the same picture or a placeholder, never a different one.
//
// IN MEMORY, UNDER A BUDGET, NEWEST KEPT. This store writes nothing to disk
// (the one copy that is ever written is the one a user opens at full size:
// `picture-serve.ts`). A long session's old screenshots leave when newer ones
// need the room, and their thumbnails become the placeholder. The CLI's
// transcript still holds every one; this is a view of the conversation, not
// an archive of it.
import { randomUUID } from 'crypto';
import type { PictureData } from './picture-data';

/** A kept picture: its media type and its base64 text. */
export interface KeptPicture {
  type: string;
  data: string;
}

/** The most base64 text the store holds at once, across every session. */
export const FEED_PICTURE_BUDGET = 64 * 1024 * 1024;

interface Held extends KeptPicture {
  owner: object;
}

export class FeedPictureStore {
  /** insertion order is age: the first key is the oldest picture held */
  private readonly held = new Map<string, Held>();
  private chars = 0;

  constructor(
    private readonly budget = FEED_PICTURE_BUDGET,
    private readonly mint: () => string = randomUUID
  ) {}

  /**
   * Keep these pictures for `owner` and answer one handle each, in order.
   *
   * EVERY picture gets a handle, kept or not. The handle of one that could not
   * be kept simply names nothing, which the page shows as the placeholder: a
   * message with three pictures has three thumbnails, whatever became of them.
   */
  keep(owner: object, pictures: readonly PictureData[]): string[] {
    const ids: string[] = [];
    for (const p of pictures) {
      const id = this.mint();
      ids.push(id);
      if (p.data === undefined || p.data.length > this.budget) continue;
      this.held.set(id, { owner, type: p.type, data: p.data });
      this.chars += p.data.length;
    }
    // the oldest leave first; the ones just added are the newest by definition
    for (const [id, h] of this.held) {
      if (this.chars <= this.budget) break;
      this.held.delete(id);
      this.chars -= h.data.length;
    }
    return ids;
  }

  /** The picture this handle names, or undefined: never minted, or gone. */
  get(id: string): KeptPicture | undefined {
    const h = this.held.get(id);
    return h ? { type: h.type, data: h.data } : undefined;
  }

  /** Forget these handles: the blocks that carried them are gone. */
  drop(ids: readonly string[]): void {
    for (const id of ids) {
      const h = this.held.get(id);
      if (!h) continue;
      this.held.delete(id);
      this.chars -= h.data.length;
    }
  }

  /** Forget everything kept for `owner`: its conversation was reset or closed. */
  dropOwner(owner: object): void {
    for (const [id, h] of this.held) {
      if (h.owner !== owner) continue;
      this.held.delete(id);
      this.chars -= h.data.length;
    }
  }

  /** how many pictures are held, and how much text: for tests and the log */
  get size(): number {
    return this.held.size;
  }
  get heldChars(): number {
    return this.chars;
  }
}

/** The app's one store. Every Feed buffer keeps into it unless told otherwise. */
export const feedPictures = new FeedPictureStore();
