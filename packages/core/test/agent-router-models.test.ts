import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { pullProviderModels, pullProviderModelCatalog, RouterCredentials, type RouterProvider } from '../src/agent-router/index.js';

async function upstream(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
function provider(baseUrl: string, protocol: RouterProvider['protocol'] = 'chat'): RouterProvider {
  return { id: 'test', name: 'test', enabled: true, baseUrl, protocol, models: ['preview'], auth: { kind: 'env', variable: 'KEY' } };
}

test('official OpenAI catalog uses upstream credentials and deduplicates model IDs', async t => {
  const baseUrl = await upstream(t, (req, res) => {
    assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer secret');
    res.end(JSON.stringify({ data: [{ id: 'beta' }, { id: 'alpha' }, { id: 'beta' }] }));
  });
  assert.deepEqual(await pullProviderModels(new RouterCredentials({ KEY: 'secret' }), provider(baseUrl)), ['alpha', 'beta']);
});

test('official Claude catalog uses native auth and follows pagination', async t => {
  let pages = 0;
  const baseUrl = await upstream(t, (req, res) => {
    pages++; assert.equal(req.headers['x-api-key'], 'secret'); assert.equal(req.headers['anthropic-version'], '2023-06-01');
    if (pages === 1) res.end(JSON.stringify({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }));
    else { assert.equal(req.url, '/v1/models?after_id=claude-a'); res.end(JSON.stringify({ data: [{ id: 'claude-b' }], has_more: false })); }
  });
  assert.deepEqual(await pullProviderModels(new RouterCredentials({ KEY: 'secret' }), provider(baseUrl, 'messages')), ['claude-a', 'claude-b']);
  assert.equal(pages, 2);
});

test('catalog errors never forward supplier response bodies or follow credential redirects', async t => {
  const baseUrl = await upstream(t, (_req, res) => { res.writeHead(401); res.end('private-supplier-secret'); });
  await assert.rejects(pullProviderModels(new RouterCredentials({ KEY: 'secret' }), provider(baseUrl)), /^Error: MODEL_CATALOG_UNAUTHORIZED$/);
  const redirect = await upstream(t, (_req, res) => { res.writeHead(302, { location: baseUrl + '/models' }); res.end(); });
  await assert.rejects(pullProviderModels(new RouterCredentials({ KEY: 'secret' }), provider(redirect)), /MODEL_CATALOG_UNAVAILABLE/);
});

test('catalog rejects malformed lists and repeated pagination cursors', async t => {
  const invalid = await upstream(t, (_req, res) => res.end(JSON.stringify({ data: [{ name: 'missing-id' }] })));
  await assert.rejects(pullProviderModels(new RouterCredentials({ KEY: 'secret' }), provider(invalid)), /MODEL_CATALOG_INVALID/);
  const repeated = await upstream(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: 'same' }], has_more: true, last_id: 'same' })));
  await assert.rejects(pullProviderModels(new RouterCredentials({ KEY: 'secret' }), provider(repeated)), /MODEL_CATALOG_INVALID/);
});

test('catalog requires credentials, accepts empty results and rejects gateway loops', async t => {
  const baseUrl = await upstream(t, (_req, res) => res.end('{"data":[]}'));
  await assert.rejects(pullProviderModels(new RouterCredentials({}), provider(baseUrl)), /CREDENTIAL_UNAVAILABLE/);
  assert.deepEqual(await pullProviderModels(new RouterCredentials({ KEY: 'secret' }), provider(baseUrl)), []);
  await assert.rejects(pullProviderModels(new RouterCredentials({ KEY: 'secret' }), provider(baseUrl), Number(new URL(baseUrl).port)), /GATEWAY_LOOP/);
});


test('API catalogs preserve compatible display names without inventing vision or pricing metadata', async t => {
  const baseUrl = await upstream(t, (_req, res) => res.end(JSON.stringify({ data: [{ id: 'test-model', name: 'Test model', supportsVision: true, price: 0, api_key: 'must-not-leak' }] })));
  const catalog = await pullProviderModelCatalog(new RouterCredentials({ KEY: 'secret' }), provider(baseUrl));
  assert.deepEqual(catalog.models, ['test-model']);
  assert.deepEqual(catalog.metadata?.['test-model'], { name: 'Test model' });
  assert.equal(catalog.names?.['test-model'], 'Test model');
  assert.ok(!JSON.stringify(catalog).includes('must-not-leak'));
});
