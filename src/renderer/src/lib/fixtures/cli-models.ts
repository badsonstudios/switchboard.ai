// The CLI's real `list_models` answer, for the surfaces that render it.
//
// ALL FIVE ENTRIES, IN ORDER, AS CAPTURED against 2.1.245 — and the count is
// the point. The picker's fixture used to carry three, and dropping `opus[1m]`
// hid a live bug: `default` and `opus[1m]` SHARE a `resolvedModel`, so a per-row
// match ticked BOTH of them for anyone on the default model, which is the
// default setup. **A fixture that cannot express the collision cannot catch
// it** — so if you are here to trim this list for a test that "only needs two",
// don't.
//
// Shared rather than copied per test file (#747) for exactly that reason: there
// are now three suites over this data (`model-choices`, `ModelPickerDialog`,
// `ModelQuickMenu`), and a third hand-typed copy is a third chance to lose the
// collision quietly.
import type { CliModel } from '../../../../shared/stream-protocol';

export const CLI_MODELS: CliModel[] = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
  },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
];

/** where a model sits in {@link CLI_MODELS} — the index assertions read from */
export const modelAt = (value: string): number =>
  CLI_MODELS.findIndex((m) => m.value === value);
