import { Hono } from 'hono';
import { isSubscriptionChannelId } from '../subscription/index.js';
import { readSubscription } from '../subscription/read.js';

function loopback(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password;
}

/** Account snapshots are available only to the local CLI panel and its dev server. */
function allowedRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    if (!loopback(url)) return false;
    const rawHost = request.headers.get('host');
    const target = rawHost ? new URL(`http://${rawHost}`) : url;
    if (!loopback(target) || (rawHost && rawHost !== target.host)) return false;
    if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
    const rawOrigin = request.headers.get('origin');
    if (rawOrigin === null) return true;
    const origin = new URL(rawOrigin);
    if (!loopback(origin) || rawOrigin !== origin.origin) return false;
    return origin.origin === target.origin
      || ['http://localhost:5194', 'http://127.0.0.1:5194'].includes(origin.origin);
  } catch {
    return false;
  }
}

export function createSubscriptionApi(reader: typeof readSubscription = readSubscription): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (!allowedRequest(c.req.raw)) {
      return c.json({ success: false, message: 'SUBSCRIPTION_ACCESS_DENIED', data: null }, 403);
    }
    await next();
  });
  app.get('/:channel', async c => {
    const channel = c.req.param('channel');
    if (!isSubscriptionChannelId(channel)) {
      return c.json({ success: false, message: 'UNKNOWN_SUBSCRIPTION_CHANNEL', data: null }, 404);
    }
    try {
      const data = await reader(channel, { forceRefresh: c.req.query('forceRefresh') === '1' });
      return c.json({ success: true, message: 'ok', data });
    } catch {
      return c.json({ success: false, message: 'SUBSCRIPTION_READ_FAILED', data: null }, 500);
    }
  });
  return app;
}
