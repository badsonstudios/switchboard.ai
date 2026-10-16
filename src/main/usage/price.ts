// Asking a provider what its tokens cost (#1288). The one place the host does,
// so the fail-open rule cannot drift between the call sites: a provider with no
// price list, a model it does not know, a capability that throws and an answer
// that is not a sane number all come out as `undefined` — "no price" — and
// never as zero or as somebody else's rate.
import { errorText } from '../../shared/error-text';
import type { UsageTokens } from '../../shared/usage-report';
import type { ProviderCapabilities } from '../extensibility/contributions';

export function priceUsage(
  caps: ProviderCapabilities | undefined,
  usage: UsageTokens,
  model: string | undefined,
  warn?: (msg: string, meta?: Record<string, unknown>) => void
): number | undefined {
  const usageCap = caps?.usage;
  if (!usageCap) return undefined;
  let usd: unknown;
  try {
    usd = usageCap.estimateCostUsd(usage, model);
  } catch (err) {
    warn?.('usage: the provider could not price these tokens; showing no price', {
      error: errorText(err),
    });
    return undefined;
  }
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : undefined;
}
