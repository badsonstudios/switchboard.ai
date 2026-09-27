// The transport vocabulary both processes need (#381).
//
// `main/transport/transport.ts` owns the transport SEAM — the interfaces a
// hosted process is spawned and killed through, which are main's business and
// nobody else's. What lives here is the small part the renderer also has to
// know: what the kinds are called, and which one a session starts on when
// nothing has chosen. The renderer needs the second one because the ⋯ menu
// names the current mode before the session record has arrived, and a second
// hand-written `'stream'` there is a copy that would silently stop matching the
// day the default moves again.

/**
 * Which wire a session's CLI is hosted on.
 *
 * ONE VALUE SINCE #952, and the type survives deliberately. E18 deleted the PTY
 * implementation, not §5.3's adapter contract: an adapter still declares the
 * transport its CLI speaks, and the day a second provider needs a different one
 * this is the union it widens. A union of one is honest about that; replacing it
 * with a bare string would lose the guarantee, and deleting it would mean
 * threading the concept back through ~40 call sites to get it again.
 */
export type TransportKind = 'stream';

/**
 * What a session starts on.
 *
 * Dan, 2026-08-09 (#381): *"all sessions default to direct mode. not
 * terminal"* — the next step of the migration DESIGN §5.2's 2026-08-02
 * amendment already committed to, where Terminal mode is removed once Direct
 * mode is tested in real use. Defaulting to Direct is how it got tested in real
 * use, and on 2026-09-25 the owner reported the result: *"I've been using direct
 * mode all along. I'm not missing the terminal at all."* #952 removed the other
 * option.
 *
 * So this is no longer a *default* in the sense of "what silence means" — there
 * is nothing else to choose. It is kept because ~40 call sites name the concept,
 * and because a second provider adapter reintroduces the question rather than
 * answering it.
 */
export const DEFAULT_SESSION_TRANSPORT: TransportKind = 'stream';
