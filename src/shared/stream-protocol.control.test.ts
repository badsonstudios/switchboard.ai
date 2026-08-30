// The outbound control-request builders and readers (#721).
//
// These are the pure half of the channel: what we put on the wire, and how we
// read what comes back. Every fixture below is a REAL envelope captured from
// the CLI on PATH (2.1.245) on 2026-08-28 — see
// `docs/reference-implementations.md` §1.2.2 — rather than a shape invented to
// match the code.
import { describe, it, expect } from 'vitest';
import {
  controlRequest,
  listModelsRequest,
  mcpAuthenticateRequest,
  mcpClearAuthRequest,
  readControlResponse,
  readModels,
  setModelRequest,
} from './stream-protocol';

describe('what we send', () => {
  it('wraps a verb in the envelope the CLI expects', () => {
    expect(controlRequest('sb-1', { subtype: 'mcp_status' })).toEqual({
      type: 'control_request',
      request_id: 'sb-1',
      request: { subtype: 'mcp_status' },
    });
  });

  it('list_models carries no payload — that is the point of it', () => {
    // `initialize` returns the same array inside ~28 KB of commands, agents and
    // account data. This is the call a picker should make.
    expect(listModelsRequest('sb-2').request).toEqual({ subtype: 'list_models' });
  });

  it('set_model sends a trimmed model id', () => {
    expect(setModelRequest('sb-3', '  haiku ')?.request).toEqual({
      subtype: 'set_model',
      model: 'haiku',
    });
  });

  it('REFUSES what the CLI would accept and silently ignore', () => {
    // Measured: `{subtype:"set_model"}` with no `model` answers `success` and
    // changes nothing, so a dropped field reads as a working feature. A
    // non-string IS refused by the CLI (`set_model: model must be a string`),
    // but there is no reason to spend a round trip finding that out.
    expect(setModelRequest('sb-4', undefined)).toBeNull();
    expect(setModelRequest('sb-4', null)).toBeNull();
    expect(setModelRequest('sb-4', '')).toBeNull();
    expect(setModelRequest('sb-4', '   ')).toBeNull();
    expect(setModelRequest('sb-4', 42)).toBeNull();
    expect(setModelRequest('sb-4', { model: 'haiku' })).toBeNull();
  });

  // ── The two auth verbs (#734) ───────────────────────────────────────────────
  //
  // Named from `docs/reference-implementations.md` §1.2.2's RECORDED verb list,
  // not from a guess. The distinction matters here more than anywhere: #729's
  // probes invented subtype names (`list_agents`, `get_hooks`, `resume_session`
  // — none of which exist) while the real list had been sitting in #633's
  // comment since 2026-08-16, which is how these three verbs went unnoticed
  // through two PRs and a release.

  it.each([
    ['mcp_authenticate', mcpAuthenticateRequest],
    ['mcp_clear_auth', mcpClearAuthRequest],
  ])('%s sends a trimmed server name', (subtype, build) => {
    expect(build('sb-5', '  Slack ')?.request).toEqual({ subtype, serverName: 'Slack' });
  });

  it.each([
    ['mcp_authenticate', mcpAuthenticateRequest],
    ['mcp_clear_auth', mcpClearAuthRequest],
  ])('%s refuses a name that is not a usable string', (_subtype, build) => {
    // The CLI does refuse the missing-argument case for these two — measured,
    // `mcp_authenticate {}` answers "Server not found: undefined". That is a
    // fact about THESE verbs and not a pattern to lean on: `mcp_toggle` with no
    // `enabled` answers success and turns the server OFF. Validating before the
    // wire costs nothing and does not have to be re-derived per verb.
    expect(build('sb-6', undefined)).toBeNull();
    expect(build('sb-6', null)).toBeNull();
    expect(build('sb-6', '')).toBeNull();
    expect(build('sb-6', '   ')).toBeNull();
    expect(build('sb-6', 42)).toBeNull();
    expect(build('sb-6', { serverName: 'Slack' })).toBeNull();
  });
});

describe('what comes back', () => {
  it('reads a success off a REAL captured envelope', () => {
    expect(
      readControlResponse({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'sb-2', response: { models: [] } },
      })
    ).toEqual({ requestId: 'sb-2', ok: true, response: { models: [] }, error: '' });
  });

  it('reads a refusal, keeping the CLI’s sentence', () => {
    expect(
      readControlResponse({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'sb-4',
          error: 'Unsupported control request subtype: no_such_verb_xyz',
        },
      })
    ).toEqual({
      requestId: 'sb-4',
      ok: false,
      response: {},
      error: 'Unsupported control request subtype: no_such_verb_xyz',
    });
  });

  it('normalises a payload-free success to an empty object', () => {
    // The real `set_model` success: no `response` key at all.
    const r = readControlResponse({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'sb-3' },
    });
    expect(r).toEqual({ requestId: 'sb-3', ok: true, response: {}, error: '' });
  });

  it('does not read a TOP-LEVEL request_id — the measured trap', () => {
    // Inbound `can_use_tool` requests carry theirs at the top level; replies to
    // OUR requests do not, and carry it nested. Measured: every reply came back
    // with `topLevelRequestId=undefined`. Accepting the top-level one here
    // would make a correlator that appears to work against a hand-written
    // fixture and never matches a real CLI.
    expect(
      readControlResponse({
        type: 'control_response',
        request_id: 'sb-9',
        response: { subtype: 'success', response: {} },
      })
    ).toBeNull();
  });

  it('returns null for anything that is not a usable control response', () => {
    for (const bad of [
      null,
      undefined,
      'a string',
      42,
      {},
      { type: 'assistant' },
      { type: 'system', subtype: 'init' },
      { type: 'control_response' },
      { type: 'control_response', response: null },
      { type: 'control_response', response: 'nope' },
      { type: 'control_response', response: { subtype: 'success' } }, // no id
      { type: 'control_response', response: { subtype: 'success', request_id: '' } },
      { type: 'control_response', response: { subtype: 'success', request_id: 7 } },
    ]) {
      expect(readControlResponse(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('treats an unknown subtype as success — fail-open, not fail-invented', () => {
    const r = readControlResponse({
      type: 'control_response',
      response: { subtype: 'something_new', request_id: 'sb-5', response: { a: 1 } },
    });
    expect(r).toMatchObject({ ok: true, response: { a: 1 } });
  });
});

describe('reading the model list', () => {
  // The real payload, trimmed to the fields we model.
  const captured = {
    models: [
      {
        value: 'default',
        resolvedModel: 'claude-opus-5[1m]',
        displayName: 'Default (recommended)',
        description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
      { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
    ],
  };

  it('keeps the fields a picker needs and drops the ones nothing consumes', () => {
    const models = readModels(captured);
    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({
      value: 'default',
      resolvedModel: 'claude-opus-5[1m]',
      displayName: 'Default (recommended)',
      description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
    });
    // `supportsEffort` and friends ride along on the wire and are deliberately
    // not modelled — a type that claims them invites a half-built surface.
    expect(models[0]).not.toHaveProperty('supportsEffort');
    expect(models[2]).toEqual({
      value: 'haiku',
      resolvedModel: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku',
    });
  });

  it('drops entries with no `value`, because that is the only field we send back', () => {
    expect(
      readModels({
        models: [
          { displayName: 'no value here' },
          { value: '' },
          { value: 7 },
          null,
          'nope',
          { value: 'ok' },
        ],
      })
    ).toEqual([{ value: 'ok' }]);
  });

  it('answers an empty list rather than throwing on a shape it does not know', () => {
    expect(readModels({})).toEqual([]);
    expect(readModels({ models: null })).toEqual([]);
    expect(readModels({ models: 'nope' })).toEqual([]);
    expect(readModels({ models: {} })).toEqual([]);
  });
});
