import { describe, it, expect } from 'vitest';
import { FOLD_LOOKUP_TOOLS, mcpCall, mcpServerInToolName, mcpServerLabel, webCall } from './tool-fold';
import { READ_TOOLS } from './tool-taxonomy';

describe('mcpCall (#1271)', () => {
  it('reads the server and the tool out of the name the CLI gives', () => {
    expect(mcpCall('mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' });
    expect(mcpCall('mcp__switchboard__list_sessions')).toEqual({
      server: 'switchboard',
      tool: 'list_sessions',
    });
  });

  // the owner's case: a server that came with a plugin
  it('a plugin server keeps its whole name, single underscores and all', () => {
    expect(mcpCall('mcp__plugin_atlassian_atlassian__getJiraIssue')).toEqual({
      server: 'plugin_atlassian_atlassian',
      tool: 'getJiraIssue',
    });
    expect(mcpCall('mcp__claude_ai_Claude_Docs__batch')).toEqual({
      server: 'claude_ai_Claude_Docs',
      tool: 'batch',
    });
  });

  it('cuts at the FIRST double underscore: a tool name may hold one of its own', () => {
    expect(mcpCall('mcp__srv__get__thing')).toEqual({ server: 'srv', tool: 'get__thing' });
  });

  it('is null for a name that is not whole', () => {
    for (const name of ['mcp__', 'mcp__server', 'mcp__server__', 'mcp____tool', 'mcp_server__tool']) {
      expect(mcpCall(name), name).toBeNull();
    }
  });

  it('is null for every tool that is not an MCP call', () => {
    for (const name of ['Read', 'Bash', 'WebSearch', 'Agent', 'Edit', '']) {
      expect(mcpCall(name, { server: 'x' }), name).toBeNull();
    }
  });

  it('a resource tool belongs to the server its input names', () => {
    expect(mcpCall('ReadMcpResourceTool', { server: 'notion', uri: 'x://y' })).toEqual({
      server: 'notion',
      tool: 'ReadMcpResourceTool',
    });
    expect(mcpCall('ListMcpResourcesTool', { server: 'notion' })?.server).toBe('notion');
  });

  it('...and to none when it names none: that one lists every server at once', () => {
    expect(mcpCall('ListMcpResourcesTool', {})).toBeNull();
    expect(mcpCall('ListMcpResourcesTool')).toBeNull();
    expect(mcpCall('ReadMcpResourceTool', { server: 7 })).toBeNull();
    expect(mcpCall('ReadMcpResourceTool', { server: '' })).toBeNull();
  });
});

describe('mcpServerLabel (#1271)', () => {
  it('says a plugin server the way a person would', () => {
    expect(mcpServerLabel('plugin_atlassian_atlassian')).toBe('Atlassian');
    expect(mcpServerLabel('plugin_figma_dev_mode')).toBe('Figma Dev Mode');
    expect(mcpServerLabel('plugin_my_tools_my_tools')).toBe('My Tools');
  });

  it('a claude.ai connector loses its prefix and keeps its own capitals', () => {
    expect(mcpServerLabel('claude_ai_Claude_Docs')).toBe('Claude Docs');
  });

  it('an ordinary server gets a capital and its separators become spaces', () => {
    expect(mcpServerLabel('github')).toBe('Github');
    expect(mcpServerLabel('my-server')).toBe('My Server');
    expect(mcpServerLabel('switchboard')).toBe('Switchboard');
  });

  it('a name with capitals of its own is left as its author wrote it', () => {
    expect(mcpServerLabel('DeepWiki')).toBe('DeepWiki');
    expect(mcpServerLabel('GitHub')).toBe('GitHub');
  });

  it('only a PLUGIN’s doubled name is said once', () => {
    expect(mcpServerLabel('go_go')).toBe('Go Go');
    expect(mcpServerLabel('plugin_go_go')).toBe('Go');
  });

  it('never answers with nothing', () => {
    expect(mcpServerLabel('plugin_')).toBe('plugin_');
    expect(mcpServerLabel('___')).toBe('___');
    expect(mcpServerLabel('x')).toBe('X');
  });
});

describe('webCall (#1271)', () => {
  it('a search is its query', () => {
    expect(webCall('WebSearch', { query: '  dockview skipSetActive ' })).toEqual({
      kind: 'search',
      query: 'dockview skipSetActive',
    });
  });

  it('a fetch is its SITE, not its address', () => {
    expect(webCall('WebFetch', { url: 'https://www.example.com/a/b?token=secret', prompt: 'x' })).toEqual({
      kind: 'page',
      host: 'example.com',
    });
    expect(webCall('WebFetch', { url: 'https://docs.github.com/en/rest' })).toEqual({
      kind: 'page',
      host: 'docs.github.com',
    });
  });

  it('a call with nothing usable in it is still a web call', () => {
    expect(webCall('WebSearch', {})).toEqual({ kind: 'search', query: '' });
    expect(webCall('WebFetch', { url: 'not an address' })).toEqual({ kind: 'page', host: '' });
    expect(webCall('WebFetch')).toEqual({ kind: 'page', host: '' });
  });

  it('is null for anything else', () => {
    for (const name of ['Read', 'Bash', 'mcp__web__search', 'Fetch']) expect(webCall(name, {})).toBeNull();
  });
});

describe('the lookup list is the fold’s own (#1271)', () => {
  // `READ_TOOLS` also decides what the approval gate lets through. A tool must
  // not become ungated by being folded.
  it('shares nothing with the approval gate’s read-only list', () => {
    for (const name of FOLD_LOOKUP_TOOLS) expect(READ_TOOLS).not.toContain(name);
  });
});
// Found in review: a resource tool is handed the server's CONFIGURED name
// (`plugin:atlassian:atlassian`), and every other call carries the tool-name
// spelling (`plugin_atlassian_atlassian`). The rule is the CLI's own.
describe('a resource tool and a tool call agree on which server (#1271)', () => {
  it('a plugin server’s configured name becomes the spelling its tools carry', () => {
    expect(mcpServerInToolName('plugin:atlassian:atlassian')).toBe('plugin_atlassian_atlassian');
    const read = mcpCall('ReadMcpResourceTool', { server: 'plugin:atlassian:atlassian', uri: 'x' });
    const call = mcpCall('mcp__plugin_atlassian_atlassian__getJiraIssue');
    expect(read!.server).toBe(call!.server);
  });

  it('a claude.ai connector too: runs of separators collapse, as the CLI collapses them', () => {
    expect(mcpServerInToolName('claude.ai Claude Docs')).toBe('claude_ai_Claude_Docs');
    expect(mcpCall('ListMcpResourcesTool', { server: 'claude.ai Claude Docs' })!.server).toBe(
      mcpCall('mcp__claude_ai_Claude_Docs__batch')!.server
    );
  });

  it('a name already in the tool-name spelling is left alone', () => {
    for (const name of ['github', 'my-server', 'plugin_atlassian_atlassian', 'a__b']) {
      expect(mcpServerInToolName(name)).toBe(name);
    }
  });
});
