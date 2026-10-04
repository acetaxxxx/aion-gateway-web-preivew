import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewRegistry } from '../src/registry.mjs';
import { createGatewayServer } from '../src/server.mjs';

let root;
let server;
let origin;
let registry;
const config = { previewScanRoot: '', adminEmails: new Set(['owner@example.com']) };

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'aion-gateway-http-'));
  config.previewScanRoot = join(root, 'data', 'conversations', 'users');
  await mkdir(join(config.previewScanRoot, 'owner', 'project'), { recursive: true });
  await writeFile(join(config.previewScanRoot, 'owner', 'project', 'index.html'), '<script>parent.postMessage("x", "*")</script>');
  await writeFile(join(config.previewScanRoot, 'owner', 'project', 'asset.css'), 'body { color: green }');
  registry = new PreviewRegistry(join(root, 'gateway', 'previews.json'));
  const auth = async (request) => {
    if (request.headers.authorization === 'Bearer owner') return { email: 'owner@example.com' };
    if (request.headers.authorization === 'Bearer viewer') return { email: 'viewer@example.com' };
    return null;
  };
  server = createGatewayServer({ config, registry, authenticate: auth });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

function headers(identity) {
  return identity ? { authorization: `Bearer ${identity}` } : {};
}

test('health endpoint is public, application pages require authenticated identity', async () => {
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal((await fetch(origin)).status, 401);
  assert.equal((await fetch(origin, { headers: headers('viewer') })).status, 200);
});

test('admin can register a preview and viewers can only see enabled entries', async () => {
  const denied = await fetch(`${origin}/api/candidates`, { headers: headers('viewer') });
  assert.equal(denied.status, 403);

  const created = await fetch(`${origin}/api/previews`, {
    method: 'POST', headers: { ...headers('owner'), 'content-type': 'application/json' },
    body: JSON.stringify({ relativePath: 'owner/project', title: 'Demo' }),
  });
  assert.equal(created.status, 201);
  const { preview } = await created.json();
  assert.equal(preview.title, 'Demo');

  const listing = await fetch(`${origin}/api/previews`, { headers: headers('viewer') });
  const [listed] = (await listing.json()).previews;
  assert.equal(listed.slug, preview.slug);
  assert.equal(listed.title, 'Demo');
  assert.equal(listed.enabled, true);
  assert.equal(listed.status, 'ready');
  assert.ok(Number.isFinite(Date.parse(listed.updatedAt)));
  assert.equal(listed.relativePath, undefined);
  assert.equal((await fetch(`${origin}/preview/${preview.slug}/index.html`, {
    headers: { ...headers('viewer'), 'sec-fetch-dest': 'iframe' },
  })).status, 200);

  const disable = await fetch(`${origin}/api/previews/${preview.slug}`, {
    method: 'PATCH', headers: { ...headers('owner'), 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disable.status, 200);
  assert.equal((await fetch(`${origin}/preview/${preview.slug}/index.html`, { headers: headers('viewer') })).status, 404);
});

test('preview paths reject traversal and content is framed with sandbox-compatible headers', async () => {
  const entry = (await registry.list())[0];
  const asset = await fetch(`${origin}/preview/${entry.slug}/asset.css`, { headers: headers('viewer') });
  assert.equal(asset.status, 404); // The preview was disabled by the preceding test.

  await registry.setEnabled(entry.slug, true);
  const directHtml = await fetch(`${origin}/preview/${entry.slug}/index.html`, { headers: headers('viewer') });
  assert.equal(directHtml.status, 403);
  const html = await fetch(`${origin}/preview/${entry.slug}/index.html`, {
    headers: { ...headers('viewer'), 'sec-fetch-dest': 'iframe' },
  });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /object-src 'none'/);
  assert.match(html.headers.get('content-type'), /text\/html/);

  const previewPage = await fetch(`${origin}/p/${entry.slug}`, { headers: headers('viewer') });
  assert.match(await previewPage.text(), /sandbox="allow-scripts"/);

  const traversal = await fetch(`${origin}/preview/${entry.slug}/%2e%2e/%2e%2e/gateway/previews.json`, { headers: headers('viewer') });
  assert.ok([400, 404].includes(traversal.status));
  assert.doesNotMatch(await traversal.text(), /relativePath|owner\/project/);
});

test('registered state is persisted without granting viewers registry filesystem paths', async () => {
  const entry = (await registry.list())[0];
  assert.equal(entry.relativePath, 'owner/project');
  const response = await fetch(`${origin}/api/previews`, { headers: headers('viewer') });
  assert.doesNotMatch(await response.text(), /owner\/project/);
  assert.match(await readFile(join(root, 'gateway', 'previews.json'), 'utf8'), /owner\/project/);
});
