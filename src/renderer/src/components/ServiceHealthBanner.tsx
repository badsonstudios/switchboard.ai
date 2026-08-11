import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ServiceHealthStatus } from '../../../shared/service-health';

/**
 * "Several sessions just hit errors — this might not be you" (P2-E14-07, §5.14).
 *
 * The LOCAL half of the provider question, and the reason it is a banner rather
 * than a line in a tooltip: it appears at the exact moment the operator is
 * about to start debugging their own prompt, and its whole value is being read
 * without being looked for. It says *possible*, never *the provider is down* —
 * three sessions failing together is evidence, not a diagnosis.
 *
 * It is deliberately NOT dismissible. There is nothing to decide and nothing to
 * do: it goes away on its own the moment a session completes a turn (main's
 * corroboration tracker clears on the first clean `result`), so a dismiss
 * button would only offer to hide something that is about to leave anyway.
 *
 * The announce mechanics are `PreflightBanner`'s, and for the same two reasons
 * (#222, #314) — each covers a hole the other leaves:
 *
 * 1. **`role="status"`**, polite: this is news, not an interruption. Nothing is
 *    blocked, no answer is wanted.
 * 2. **The region exists before the words do.** App renders this
 *    unconditionally and `raised` only gates what is INSIDE it; a live region
 *    inserted already holding its text is announced by almost nothing.
 * 3. **`spoken` holds the words back one commit**, because a push can land in
 *    the same frame the shell mounts (main polls at startup and the record is
 *    already on the wire).
 *
 * The look lives in `.service-health-banner` in tokens.css, for #206's reason:
 * a fill/ink pair the drift test can read out of a stylesheet is a pair it can
 * hold to a contrast floor in every theme. Unstyled and empty it is a
 * zero-height box, so a quiet day costs no pixels.
 */
export function ServiceHealthBanner({
  status,
}: {
  status: ServiceHealthStatus | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const raised = !!status?.corroboration;
  const [spoken, setSpoken] = useState(false);
  // the commit AFTER the region exists — see point 3 above
  useEffect(() => {
    setSpoken(raised);
  }, [raised]);
  return (
    <div role="status" data-testid="service-health-banner" className={spoken ? 'service-health-banner' : undefined}>
      {spoken && status?.corroboration
        ? t('health.banner', { count: status.corroboration.sessions })
        : null}
    </div>
  );
}
