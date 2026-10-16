// Taking the credentials out of an MCP server address before it reaches the
// screen (#632). Provider-neutral: any AI that lists remote MCP servers needs
// it, and both the Claude config reader and the `mcp_status` reader use it.
// Moved out of the config reader when that reader went behind the Claude
// provider (#1288).

/**
 * A remote endpoint with its credentials taken out.
 *
 * REMOTE MCP SERVERS ROUTINELY CARRY THE SECRET IN THE URL — `https://
 * user:token@host/mcp` and `?api_key=…` are both documented forms — so
 * `raw.url` is a secret-carrying field in exactly the way `env` and `headers`
 * are, and the first version of this file rendered it verbatim onto the screen.
 * Caught in review; the docstring on `McpServerWire` claimed no field could
 * carry a value and was wrong about two of them.
 *
 * What survives is what identifies the server — scheme, host, port, path — and
 * the NAMES of the query parameters, which is the same trade `envKeys` makes.
 * A string that will not parse as a URL is not guessed at: it is reported as
 * unparseable rather than half-redacted, because a partial redaction of an
 * unknown format is how a secret survives in the tail.
 */
export function redactUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '(unreadable address)';
  }
  u.username = '';
  u.password = '';
  for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, '…');
  return u.toString();
}
