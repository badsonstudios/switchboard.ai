// Which kept settings a resume gets (#1317) — `keptSettingsFor`, the one rule.
import { describe, expect, it } from 'vitest';
import { keptSettingsFor } from './ipc';

const kept = { conversationSettings: { conversation: 'c-1', model: 'gpt-6-luna', effort: 'low' } };

describe('keptSettingsFor (#1317)', () => {
  it('a plain resume of the same conversation gets them', () => {
    expect(keptSettingsFor(kept, 'c-1', undefined)).toEqual({ model: 'gpt-6-luna', effort: 'low' });
    expect(keptSettingsFor({ conversationSettings: { conversation: 'c-1', effort: 'high' } }, 'c-1', false)).toEqual({ effort: 'high' });
  });

  it('a fresh start, a fork, another conversation or no record get nothing', () => {
    expect(keptSettingsFor(kept, undefined, undefined)).toBeUndefined();
    expect(keptSettingsFor(kept, 'c-1', true)).toBeUndefined();
    expect(keptSettingsFor(kept, 'c-2', undefined)).toBeUndefined();
    expect(keptSettingsFor(undefined, 'c-1', undefined)).toBeUndefined();
    expect(keptSettingsFor({}, 'c-1', undefined)).toBeUndefined();
    expect(keptSettingsFor({ conversationSettings: { conversation: 'c-1' } }, 'c-1', undefined)).toBeUndefined();
  });
});
