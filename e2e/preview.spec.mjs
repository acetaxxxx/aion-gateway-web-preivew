import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PreviewRegistry } from '../src/registry.mjs';
import { PreviewChanges } from '../src/changes.mjs';
import { createGatewayServer } from '../src/server.mjs';

test('Agent creates a website and returns a link that updates HTML, CSS, and JS without another MCP call', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-browser-'));
  const project = join(root, 'workspaces', 'user', 'project');
  await mkdir(project, { recursive: true });
  const html = (title) => `<!doctype html><link rel="stylesheet" href="style.css"><h1>${title}</h1><p id="script-output"></p><script src="app.js"></script>`;
  await writeFile(join(project, 'style.css'), 'h1 { color: rgb(0, 128, 0) }');
  await writeFile(join(project, 'app.js'), 'document.querySelector("#script-output").textContent = "Script one";');
  const config = {
    previewScanRoot: join(root, 'workspaces'), agentWorkspaceRoot: '/data/conversations/users',
    publicUrl: 'https://preview.example.com', mcpToken: 'browser-test-token-'.repeat(3), adminEmails: new Set(),
    aionUsers: new Map([['viewer@example.com', { username: 'viewer@example.com', password: 'fixture-only' }]]),
  };
  const items = [{ id: 'm1', type: 'text', content: { content: 'Hello from Aion' }, position: 'left', created_at: 1 }];
  const backend = createServer(async (request, response) => {
    const json = (value) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (request.url === '/login') return json({ success: true, token: 'browser-fixture' });
    if (request.headers.authorization !== 'Bearer browser-fixture') return response.writeHead(403).end();
    if (request.url === '/api/conversations/conv') return json({ success: true, data: { name: 'Web design', runtime: { can_send_message: true } } });
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      items.push({ id: 'm2', type: 'text', content: { content: JSON.parse(body).content }, position: 'right', created_at: 2 });
      items.push({ id: 'm3', type: 'text', content: { content: 'Website updated' }, position: 'left', created_at: 3 });
      await writeFile(join(project, 'index.html'), html('Changed from preview chat'));
      return json({ success: true, data: { accepted: true } });
    }
    return json({ success: true, data: { items, has_more_before: false, oldest_cursor: 'm1' } });
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  config.aionBackendUrl = `http://127.0.0.1:${backend.address().port}`;
  const registry = new PreviewRegistry(join(root, 'registry.json'));
  const changes = new PreviewChanges({ config, registry, pollMs: 100, debounceMs: 100 });
  const server = createGatewayServer({ config, registry, changes, authenticate: async (request) => (
    request.headers.authorization === 'Bearer browser' ? { email: 'viewer@example.com' } : null
  ) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = origin;
  const client = new Client({ name: 'agent-fixture', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${config.mcpToken}` } },
    }));
    const created = await client.callTool({ name: 'preview_create', arguments: { path: '/data/conversations/users/user/project', slug: 'my-web', conversationId: 'conv' } });
    expect(created.isError).not.toBe(true);
    await page.setExtraHTTPHeaders({ authorization: 'Bearer browser' });
    await page.goto(`${origin}${new URL(created.structuredContent.url).pathname}`);
    await expect(page.locator('#preview-status')).toHaveText('等待 Agent 完成網頁…');
    await writeFile(join(project, 'index.html'), html('First version'));
    const preview = page.frameLocator('#preview-frame');
    await expect(preview.locator('h1')).toHaveText('First version');
    await expect(preview.locator('h1')).toHaveCSS('color', 'rgb(0, 128, 0)');
    await expect(preview.locator('#script-output')).toHaveText('Script one');
    expect(await preview.locator('body').evaluate(() => {
      try { return parent.document.body !== undefined; } catch { return false; }
    })).toBe(false);
    await expect(page.locator('#chat-messages')).toContainText('Hello from Aion');
    await page.locator('#chat-input').fill('Change the heading');
    await page.locator('#chat-send').click();
    await expect(page.locator('#chat-messages')).toContainText('Website updated');
    await expect(preview.locator('h1')).toHaveText('Changed from preview chat');

    await writeFile(join(project, 'index.html'), html('Updated by Agent'));
    await expect(preview.locator('h1')).toHaveText('Updated by Agent');
    await writeFile(join(project, 'style.css'), 'h1 { color: rgb(255, 0, 0) }');
    await expect(preview.locator('h1')).toHaveCSS('color', 'rgb(255, 0, 0)');
    await writeFile(join(project, 'app.js'), 'document.querySelector("#script-output").textContent = "Script two";');
    await expect(preview.locator('#script-output')).toHaveText('Script two');

    await unlink(join(project, 'index.html'));
    await expect(page.locator('#preview-status')).toHaveText('等待 Agent 完成網頁…');
    await writeFile(join(project, 'index.html'), html('Restored automatically'));
    await expect(preview.locator('h1')).toHaveText('Restored automatically');
    await page.screenshot({ path: test.info().outputPath('live-preview.png'), fullPage: true });
    await registry.setEnabled('my-web', false);
    await expect(page.locator('#preview-status')).toHaveText('此預覽已停用。');
    await expect(page.locator('#preview-frame')).not.toHaveAttribute('src', /.+/);
  } finally {
    await page.close(); await client.close();
    server.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => backend.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  }
});
