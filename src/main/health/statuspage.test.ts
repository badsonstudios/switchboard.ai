// P2-E14-07: the probe reads a real Statuspage answer, and every way it can go
// wrong ends on "unknown" rather than on an exception.
//
// The FIXTURES below are the live page's actual bytes, captured once by hand
// while building this (2026-08-11) and never fetched again: no test in this
// repo may reach the network, and the point of writing them down is that the
// shape under test is the shape the page really serves.
import { describe, it, expect, vi } from 'vitest';
import {
  mapIndicator,
  parseMaxAgeMs,
  probeStatuspage,
  readIncidents,
  STATUSPAGE_BASE,
} from './statuspage';

/** verbatim from https://status.anthropic.com/api/v2/status.json (2026-08-11) */
const LIVE_STATUS = {
  page: {
    id: 'tymt9n04zgry',
    name: 'Claude',
    url: 'https://status.claude.com',
    time_zone: 'Etc/UTC',
    updated_at: '2026-08-11T21:55:39.647Z',
  },
  status: { indicator: 'none', description: 'All Systems Operational' },
};

/** verbatim from /api/v2/incidents/unresolved.json on the same quiet day */
const LIVE_UNRESOLVED = { page: LIVE_STATUS.page, incidents: [] };

/** the same envelope with an incident in it — the shape Statuspage documents */
const INCIDENT = {
  id: 'abc123',
  name: 'Elevated errors on the Claude API',
  status: 'investigating',
  impact: 'major',
  shortlink: 'https://stspg.io/abc123',
  created_at: '2026-08-11T20:00:00.000Z',
  updated_at: '2026-08-11T20:30:00.000Z',
};

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

/** answers the two v2 paths; anything else is a test bug, loudly */
function feed(status: unknown, incidents: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/api/v2/status.json')) return jsonResponse(status, headers);
    if (url.endsWith('/api/v2/incidents/unresolved.json')) return jsonResponse(incidents);
    throw new Error(`unexpected URL: ${url}`);
  }) as unknown as typeof fetch;
}

describe('indicator mapping', () => {
  it.each([
    ['none', 'operational'],
    ['minor', 'degraded'],
    ['maintenance', 'degraded'],
    ['major', 'outage'],
    ['critical', 'outage'],
  ])('%s reads as %s', (indicator, state) => {
    expect(mapIndicator(indicator)).toBe(state);
  });

  it('an indicator nobody has seen is unknown, never operational', () => {
    // the failure mode this exists to prevent: a schema change painting the dot
    // green because the switch fell through to its first case
    expect(mapIndicator('brand-new-word')).toBe('unknown');
    expect(mapIndicator(undefined)).toBe('unknown');
    expect(mapIndicator(null)).toBe('unknown');
  });
});

describe('cache-control', () => {
  it('reads max-age out of the live header', () => {
    // exactly what the page served on 2026-08-11
    expect(parseMaxAgeMs('max-age=10, public, s-maxage=10, stale-while-revalidate=20')).toBe(10_000);
  });

  it('is undefined when there is nothing to read', () => {
    expect(parseMaxAgeMs(null)).toBeUndefined();
    expect(parseMaxAgeMs('no-cache')).toBeUndefined();
    expect(parseMaxAgeMs('max-age=nonsense')).toBeUndefined();
  });

  it('does not confuse s-maxage for max-age', () => {
    expect(parseMaxAgeMs('public, s-maxage=600')).toBeUndefined();
  });
});

describe('reading incidents', () => {
  it('keeps the fields a tooltip and a notice need', () => {
    const [i] = readIncidents({ incidents: [INCIDENT] });
    expect(i).toEqual({
      id: 'abc123',
      name: 'Elevated errors on the Claude API',
      status: 'investigating',
      impact: 'major',
      url: 'https://stspg.io/abc123',
      startedAt: '2026-08-11T20:00:00.000Z',
      updatedAt: '2026-08-11T20:30:00.000Z',
    });
  });

  it('skips entries with no id — they cannot be told apart between polls', () => {
    expect(readIncidents({ incidents: [{ name: 'nameless' }, INCIDENT] })).toHaveLength(1);
  });

  it('is empty for anything that is not a list', () => {
    expect(readIncidents({ incidents: 'soon' })).toEqual([]);
    expect(readIncidents(null)).toEqual([]);
  });

  it('caps a page having a very bad day', () => {
    const many = Array.from({ length: 40 }, (_, n) => ({ ...INCIDENT, id: `i${n}` }));
    expect(readIncidents({ incidents: many })).toHaveLength(10);
  });

  it('bounds an absurdly long name', () => {
    const [i] = readIncidents({ incidents: [{ ...INCIDENT, name: 'x'.repeat(5_000) }] });
    expect(i.name.length).toBe(300);
  });
});

describe('one poll', () => {
  it('reads the live all-clear', async () => {
    const p = await probeStatuspage({
      fetchImpl: feed(LIVE_STATUS, LIVE_UNRESOLVED, { 'cache-control': 'max-age=10, public' }),
    });
    expect(p.state).toBe('operational');
    expect(p.reason).toBe('ok');
    expect(p.description).toBe('All Systems Operational');
    expect(p.incidents).toEqual([]);
    expect(p.maxAgeMs).toBe(10_000);
  });

  it('reads an outage with its incident', async () => {
    const p = await probeStatuspage({
      fetchImpl: feed(
        { status: { indicator: 'major', description: 'Partial System Outage' } },
        { incidents: [INCIDENT] }
      ),
    });
    expect(p.state).toBe('outage');
    expect(p.incidents[0].name).toBe('Elevated errors on the Claude API');
  });

  it('follows redirects — the DESIGN host answers 302 to another one', async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(init);
      return jsonResponse(url.includes('incidents') ? LIVE_UNRESOLVED : LIVE_STATUS);
    }) as unknown as typeof fetch;
    await probeStatuspage({ fetchImpl });
    expect(seen.every((i) => i.redirect === 'follow')).toBe(true);
  });

  it('asks the page DESIGN names, and only that page', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse(url.includes('incidents') ? LIVE_UNRESOLVED : LIVE_STATUS);
    }) as unknown as typeof fetch;
    await probeStatuspage({ fetchImpl });
    expect(urls).toEqual([
      `${STATUSPAGE_BASE}/api/v2/status.json`,
      `${STATUSPAGE_BASE}/api/v2/incidents/unresolved.json`,
    ]);
  });

  it('sends nothing but a User-Agent — this is a read, not a report', async () => {
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string, i: RequestInit) => {
      init = i;
      return jsonResponse(LIVE_STATUS);
    }) as unknown as typeof fetch;
    await probeStatuspage({ fetchImpl, userAgent: '0.4.0' });
    expect(init?.body).toBeUndefined();
    expect(init?.method ?? 'GET').toBe('GET');
    expect(Object.keys(init?.headers as Record<string, string>).sort()).toEqual([
      'accept',
      'user-agent',
    ]);
  });

  it('is unknown when the page cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    const p = await probeStatuspage({ fetchImpl });
    expect(p).toMatchObject({ state: 'unknown', reason: 'network', incidents: [] });
  });

  it('is unknown on a non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      ({ ok: false, status: 503, headers: { get: () => null } }) as unknown as Response
    ) as unknown as typeof fetch;
    expect((await probeStatuspage({ fetchImpl })).reason).toBe('network');
  });

  it('is unknown when the body is not the JSON it promised', async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError('<html>');
        },
      }) as unknown as Response
    ) as unknown as typeof fetch;
    expect((await probeStatuspage({ fetchImpl })).reason).toBe('network');
  });

  it('is bad-response when the schema moved', async () => {
    const p = await probeStatuspage({ fetchImpl: feed({ page: {} }, LIVE_UNRESOLVED) });
    expect(p).toMatchObject({ state: 'unknown', reason: 'bad-response' });
  });

  it('keeps the verdict when only the incident list fails', async () => {
    // the detail is additive; losing it must not lose the colour
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('incidents')) throw new Error('nope');
      return jsonResponse(LIVE_STATUS);
    }) as unknown as typeof fetch;
    const p = await probeStatuspage({ fetchImpl });
    expect(p.state).toBe('operational');
    expect(p.incidents).toEqual([]);
  });

  it('never throws, whatever fetch does', async () => {
    const fetchImpl = (() => {
      throw new TypeError('synchronously rude');
    }) as unknown as typeof fetch;
    await expect(probeStatuspage({ fetchImpl })).resolves.toMatchObject({ state: 'unknown' });
  });
});
