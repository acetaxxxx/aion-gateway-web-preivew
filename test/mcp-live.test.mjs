import { mkdtemp, mkdir, writeFile, unlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGatewayServer } from '../src/server.mjs';
import { PreviewRegistry } from '../src/registry.mjs';
import { PreviewChanges } from '../src/changes.mjs';

test('Agent MCP registers stable URLs and authenticated viewers receive live file updates', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aion-gateway-flow-'));
  const scanRoot = join(root, 'data');
  const project = join(scanRoot, 'user', 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'index.html'), '<h1>First version</h1>');
  const config = {
    previewScanRoot: scanRoot, agentWorkspaceRoot: '/data/conversations/users',
    publicUrl: 'https://preview.example.com', mcpToken: 'test-token-'.repeat(4), adminEmails: new Set(),
  };
  const registry = new PreviewRegistry(join(root, 'registry.json'));
  const changes = new PreviewChanges({ config, registry, pollMs: 40, debounceMs: 40 });
  const server = createGatewayServer({ config, registry, changes, authenticate: async (request) => (
    request.headers.authorization === 'Bearer viewer' ? { email: 'viewer@example.com' } : null
  ) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'flow-test', version: '1' });
  const controller = new AbortController();
  try {
    const denied = await fetch(`${origin}/mcp`, { method: 'POST' });
    assert.equal(denied.status, 401);
    const browserDenied = await fetch(`${origin}/api/previews`, { headers: { authorization: `Bearer ${config.mcpToken}` } });
    assert.equal(browserDenied.status, 401);
    const badOrigin = await fetch(`${origin}/mcp`, { headers: { authorization: `Bearer ${config.mcpToken}`, origin: 'https://evil.example.com' } });
    assert.equal(badOrigin.status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${config.mcpToken}` } },
    }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['preview_create', 'preview_get', 'preview_list']);
    const created = await client.callTool({ name: 'preview_create', arguments: {
      path: '/data/conversations/users/user/project', slug: 'demo', title: 'Demo', conversationId: 'conv-1',
    } });
    const preview = created.structuredContent;
    assert.equal(preview.url, 'https://preview.example.com/p/demo');
    assert.equal(preview.conversationId, 'conv-1');
    const repeated = await client.callTool({ name: 'preview_create', arguments: { path: 'user/project', slug: 'demo' } });
    assert.equal(repeated.structuredContent.id, preview.id);
    assert.equal((await registry.list()).length, 1);
    await mkdir(join(scanRoot, 'user', 'another'), { recursive: true });
    await writeFile(join(scanRoot, 'user', 'another', 'index.html'), '<h1>Another project</h1>');
    const conflict = await client.callTool({ name: 'preview_create', arguments: { path: 'user/another', slug: 'demo' } });
    assert.equal(conflict.isError, true);
    assert.equal((await registry.list()).length, 1);
    assert.equal((await client.callTool({ name: 'preview_get', arguments: { slug: 'demo' } })).structuredContent.id, preview.id);
    assert.equal((await client.callTool({ name: 'preview_list', arguments: {} })).structuredContent.previews.length, 1);
    for (const path of ['/etc', '/data/conversations/users-evil/user/project', '../outside', '/data/conversations/users/user/../project']) {
      assert.equal((await client.callTool({ name: 'preview_create', arguments: { path } })).isError, true);
    }
    await symlink(root, join(scanRoot, 'escape'));
    assert.equal((await client.callTool({ name: 'preview_create', arguments: { path: 'escape' } })).isError, true);
    assert.equal((await fetch(`${origin}/api/previews/demo/events`)).status, 401);

    const response = await fetch(`${origin}/api/previews/demo/events`, {
      headers: { authorization: 'Bearer viewer' }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    let buffer = '';
    async function event(name) {
      while (true) {
        const split = buffer.indexOf('\n\n');
        if (split >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          if (frame.startsWith(`event: ${name}\n`)) return JSON.parse(frame.split('\ndata: ')[1]);
          continue;
        }
        const read = await reader.read();
        assert.equal(read.done, false, `Stream ended before ${name}`);
        buffer += Buffer.from(read.value).toString('utf8');
      }
    }
    const initial = await event('ready');
    assert.equal(initial.available, true);
    await writeFile(join(project, 'asset.css'), 'body { color: red }');
    const updated = await event('reload');
    assert.notEqual(updated.revision, initial.revision);
    await unlink(join(project, 'index.html'));
    assert.equal((await event('reload')).available, false);
    await writeFile(join(project, 'index.html'), '<h1>Restored</h1>');
    assert.equal((await event('reload')).available, true);
    await registry.setEnabled('demo', false);
    assert.deepEqual(await event('disabled'), {});
    assert.equal((await fetch(`${origin}/api/previews/demo/events`, { headers: { authorization: 'Bearer viewer' } })).status, 404);
    const disabled = await client.callTool({ name: 'preview_create', arguments: { path: 'user/project', slug: 'demo' } });
    assert.equal(disabled.structuredContent.enabled, false);
  } finally {
    controller.abort();
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
