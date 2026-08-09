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

/** Which wire a session's CLI is hosted on. */
export type TransportKind = 'pty' | 'stream';

/**
 * What a session starts on when its CARD has never chosen.
 *
 * Dan, 2026-08-09 (#381): *"all sessions default to direct mode. not
 * terminal"* — the next step of the migration DESIGN §5.2's 2026-08-02
 * amendment already committed to, where Terminal mode is removed once Direct
 * mode is tested in real use. Defaulting to Direct is how it gets tested in
 * real use.
 *
 * A card that explicitly chose keeps its choice, Terminal included: the stored
 * `transport` field wins over this (`main/sessions/ipc.ts`, `sessions:create`).
 *
 * NOT the same thing as `DEFAULT_TRANSPORT` in `main/transport/transport.ts`,
 * which is what an ADAPTER's silence means and must stay `pty`. See the comment
 * there — the two silences are different claims and collapsing them would hand
 * a terminal-only CLI a protocol it cannot speak.
 */
export const DEFAULT_SESSION_TRANSPORT: TransportKind = 'stream';
