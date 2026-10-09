// The context meter's form (#715): three choices, and a stored value that is
// not one of them falls back to the default instead of drawing nothing.
import { describe, it, expect } from 'vitest';
import {
  CONTEXT_METER_FORMS,
  DEFAULT_CONTEXT_METER_FORM,
  contextMeterFormOf,
} from './context-meter';

describe('contextMeterFormOf', () => {
  it('keeps each of the three forms', () => {
    for (const form of CONTEXT_METER_FORMS) expect(contextMeterFormOf(form)).toBe(form);
  });

  it('anything else is the default: the number alone', () => {
    expect(DEFAULT_CONTEXT_METER_FORM).toBe('percent');
    for (const raw of [undefined, null, '', 'ring', 3, {}]) {
      expect(contextMeterFormOf(raw)).toBe(DEFAULT_CONTEXT_METER_FORM);
    }
  });
});
