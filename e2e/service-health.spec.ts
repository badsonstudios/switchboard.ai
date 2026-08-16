// P2-E14-07: the provider status dot, end to end, against a STUB status page.
//
// No test in this suite may reach status.anthropic.com — the page's answer
// belongs to somebody else's afternoon, and a spec that asserts "operational"
// would fail on the day the assertion matters most. So the app is pointed at a
// tiny local server answering exactly what Statuspage's v2 API answers, which
// is the seam the poller was built with (`SWITCHBOARD_STATUS_FEED`, honoured
// only in a non-packaged build).
//
// Every other spec gets `SWITCHBOARD_STATUS_FEED=off` from the fixture, so
// nothing else in the run grows a dot.
import { test, expect, Page } from '@playwright/test';
import http from 'http';
import { AddressInfo } from 'net';
import { launchApp, LaunchedApp, openEventsDrawer } from './fixtures/app';

/** The shell is mounted and listening (the reason is in about.spec.ts). */
const stamp = (w: Page) =>
  w.getByRole('button', { name: 'Version and build — click for details' });

const dot = (w: Page) => w.locator('[data-testid="service-health"]');
const banner = (w: Page) => w.locator('[data-testid="service-health-banner"]');
const incidentNotice = (w: Page) => w.locator('[data-events-notice="incident"]');

/** One Statuspage-shaped page. `indicator`/`incidents` are swapped per launch. */
class StubStatusPage {
  private server: http.Server | null = null;
  url = '';
  indicator: string | null = 'none';
  description = 'All Systems Operational';
  incidents: unknown[] = [];
  /** answer nothing at all — the "a polling failure shows unknown" case */
  dead = false;

  async start(): Promise<void> {
    const server = http.createServer((req, res) => {
      if (this.dead) {
        res.writeHead(503).end('nope');
        return;
      }
      const page = { id: 'stub', name: 'Stub', url: this.url };
      const body = req.url?.includes('incidents')
        ? { page, incidents: this.incidents }
        : {
            page,
            ...(this.indicator === null
              ? {}
              : { status: { indicator: this.indicator, description: this.description } }),
          };
      res.writeHead(200, {
        'content-type': 'application/json',
        // a real Statuspage answers a very short max-age; the poller floors it
        'cache-control': 'max-age=10, public',
      }).end(JSON.stringify(body));
    });
    this.server = server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}

test.describe('provider service health (E14-07)', () => {
  let page: StubStatusPage;
  let a: LaunchedApp | undefined;

  test.beforeEach(async () => {
    page = new StubStatusPage();
    await page.start();
  });
  test.afterEach(async () => {
    await a?.cleanup();
    a = undefined;
    await page.stop();
  });

  const launch = (): Promise<LaunchedApp> =>
    launchApp({ env: { SWITCHBOARD_STATUS_FEED: page.url } });

  test("an all-clear page paints a quiet dot with the page's own words in its tooltip", async () => {
    a = await launch();
    const w = a.window;
    await expect(stamp(w)).toBeVisible();

    await expect(dot(w)).toHaveAttribute('data-state', 'operational');
    // no words next to it: a healthy provider is not news
    await expect(dot(w)).toHaveText('●');
    await expect(dot(w)).toHaveAttribute('title', /All Systems Operational/);
    // and the corroboration strip is up but empty — the live region that has to
    // exist before it ever has anything to say
    await expect(banner(w)).toHaveText('');
    // opened first: the incidents card lives in the events drawer, which is
    // collapsed by default (P2-E14-01) — "no incident card" read off a shut
    // drawer would be true even during an outage
    await openEventsDrawer(w);
    await expect(incidentNotice(w)).toHaveCount(0);
  });

  test('an outage colours the dot, says so in words, and lists the incident in Events', async () => {
    page.indicator = 'major';
    page.description = 'Partial System Outage';
    page.incidents = [
      {
        id: 'inc-1',
        name: 'Elevated API errors',
        status: 'investigating',
        impact: 'major',
        shortlink: 'https://stspg.io/inc-1',
      },
    ];
    a = await launch();
    const w = a.window;
    await expect(stamp(w)).toBeVisible();

    await expect(dot(w)).toHaveAttribute('data-state', 'outage');
    await expect(dot(w)).toContainText('provider outage');
    await expect(dot(w)).toHaveAttribute('title', /Elevated API errors/);
    // §5.14's "incidents become Events entries". The card is in the events
    // drawer, so before opening it the COLLAPSED tab has to say that something
    // is behind it — that secondary marker is the whole reason a notice can
    // live in a surface that is shut by default (P2-E14-01, and the #425
    // coordination note that put this card here).
    await expect(w.getByTestId('events-tab')).toHaveAttribute('data-notice', 'true');
    await openEventsDrawer(w);
    await expect(incidentNotice(w)).toContainText('Elevated API errors');
    await expect(incidentNotice(w)).toContainText('investigating');
  });

  test('a degraded page is its own state, not an outage', async () => {
    page.indicator = 'minor';
    page.description = 'Degraded Performance';
    a = await launch();
    const w = a.window;
    await expect(stamp(w)).toBeVisible();
    await expect(dot(w)).toHaveAttribute('data-state', 'degraded');
    await expect(dot(w)).toContainText('provider degraded');
  });

  test('a page that refuses shows unknown — and nothing to dismiss', async () => {
    page.dead = true;
    a = await launch();
    const w = a.window;
    await expect(stamp(w)).toBeVisible();

    await expect(dot(w)).toHaveAttribute('data-state', 'unknown');
    // hollow, not just grey: the shape carries it too
    await expect(dot(w)).toHaveText('○');
    await expect(dot(w)).toHaveAttribute('title', /Couldn't reach/);
    // no dialog, no toast, no banner: a failed check is not the user's problem
    await expect(w.locator('[role="dialog"]')).toHaveCount(0);
    await expect(banner(w)).toHaveText('');
  });

  test('a schema that moved is unknown too, never a green dot', async () => {
    page.indicator = null; // a 200 with no status block at all
    a = await launch();
    const w = a.window;
    await expect(stamp(w)).toBeVisible();
    await expect(dot(w)).toHaveAttribute('data-state', 'unknown');
  });

  test('turning the check off in About stops it and says so', async () => {
    a = await launch();
    const w = a.window;
    await expect(stamp(w)).toBeVisible();
    await expect(dot(w)).toHaveAttribute('data-state', 'operational');

    await stamp(w).click();
    const box = w.locator('[data-about-field="statusPolling"]');
    await expect(box).toBeChecked();
    await box.uncheck();
    // the dot goes to "unknown", and the tooltip says why in the app's words
    await expect(dot(w)).toHaveAttribute('data-state', 'unknown');
    await expect(dot(w)).toHaveAttribute('title', /turned off/);
  });
});
