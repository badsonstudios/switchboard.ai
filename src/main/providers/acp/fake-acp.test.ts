// The fake ACP provider under another id (#1326): the manual's AI-colours
// picture registers it as `codex` and `gemini`, and those ids are what the
// badges look the catalog's entries up by. The default fake keeps its own id.
import { describe, expect, it } from 'vitest';
import { fakeAcpAdapter, fakeAcpAdapterAs, FAKE_ACP_PROVIDER_ID } from './fake-acp';

describe('fakeAcpAdapterAs', () => {
  it('is the same fake under the id and name it is given', () => {
    const gemini = fakeAcpAdapterAs('gemini', 'Gemini CLI');
    expect(gemini.manifest).toMatchObject({ id: 'gemini', displayName: 'Gemini CLI' });
    expect(gemini.capabilities?.detect).toBeDefined();
  });

  it('leaves the ordinary fake as it was', () => {
    expect(fakeAcpAdapter.manifest).toMatchObject({ id: FAKE_ACP_PROVIDER_ID, displayName: 'Fake ACP' });
  });
});
