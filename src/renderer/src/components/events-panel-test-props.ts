// Test-only: P2-E14-02's required `EventsPanel` props, inert — nothing held,
// the default view, an empty rail. For the suites that mount the panel about
// something else (notices, a11y, incidents) and must not each hand-copy six
// props that have nothing to do with what they test.
import type { EventsPanelProps } from './EventsPanel';

export const V2: Pick<
  EventsPanelProps,
  'held' | 'onDecidePermission' | 'onAllowAllSession' | 'filter' | 'onFilterChange' | 'railOrder'
> = {
  held: [],
  onDecidePermission: () => {},
  onAllowAllSession: () => {},
  filter: 'all',
  onFilterChange: () => {},
  railOrder: [],
};
