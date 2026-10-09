// How the context meter under the prompt box is drawn (#715).
//
// The owner asked for a choice of form: the plain percentage, a bar, or both.
// It is one preference for the whole app, kept in the ui blob, and applied the
// way the working look is (#718): App writes it to the document as
// `data-context-meter`, and the stylesheet shows the parts that form has. The
// meter itself always renders both parts, so no prop is threaded down to every
// composer for a preference that changes once.
export const CONTEXT_METER_FORMS = ['percent', 'bar', 'both'] as const;

export type ContextMeterForm = (typeof CONTEXT_METER_FORMS)[number];

/** the number alone: the narrowest, on a row that is already full */
export const DEFAULT_CONTEXT_METER_FORM: ContextMeterForm = 'percent';

/** the ui-blob key */
export const CONTEXT_METER_KEY = 'contextMeter';

/** A stored value, or the default for anything that is not one of the three. */
export function contextMeterFormOf(raw: unknown): ContextMeterForm {
  return CONTEXT_METER_FORMS.includes(raw as ContextMeterForm)
    ? (raw as ContextMeterForm)
    : DEFAULT_CONTEXT_METER_FORM;
}
