import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewRegistry } from '../src/registry.mjs';
import { createGatewayServer } from '../src/server.mjs';

test('authenticated catalog automatically discovers and serves standalone HTML across the data root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-discovery-'));
  const config = {
    previewScanRoot: join(root, 'data', 'conversations', 'users'),
    agentWorkspaceRoot: '/data/conversations/users',
    dataPreviewScanRoot: join(root, 'data'), dataAgentWorkspaceRoot: '/data',
    catalogRenameAllowed: true, publicUrl: 'https://preview.example.com',
    adminEmails: new Set(['owner@example.com']),
  };
  await mkdir(config.previewScanRoot, { recursive: true });
  await mkdir(join(config.dataPreviewScanRoot, 'reports'), { recursive: true });
  await writeFile(join(config.dataPreviewScanRoot, 'reports', 'quarter.htm'), '<h1>Quarter report</h1>');
  const registry = new PreviewRegistry(join(root, 'gateway', 'previews.json'));
  const server = createGatewayServer({ config, registry, authenticate: async () => ({ email: 'viewer@example.com' }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/api/previews`);
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.equal(catalog.previews.length, 1, 'standalone HTML is enrolled without manual registration');
    const [preview] = catalog.previews;
    assert.equal(preview.entryFile, 'quarter.htm');
    assert.equal(preview.displayPath, 'reports/quarter.htm');
    assert.equal(preview.canRename, true);
    assert.equal(preview.chatBound, false);
    assert.equal(preview.url, `https://preview.example.com/p/${preview.slug}`);
    assert.equal(catalog.discovery.truncated, false);
    const page = await fetch(`${origin}/preview/${preview.slug}/${preview.entryFile}`, { headers: { 'sec-fetch-dest': 'iframe' } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<h1>Quarter report</h1>');
    const next = await (await fetch(`${origin}/api/previews`)).json();
    assert.equal(next.previews.length, 1);
    assert.equal(next.previews[0].url, preview.url);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
