import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer } from '../src/server.mjs';
import { PreviewRegistry } from '../src/registry.mjs';

// Wire shapes mirror aionui-api-types auth, conversation, and team responses.
test('bound chat retains Aion ownership, resolves Team Leader, and delivers updates without exposing credentials', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-chat-'));
  const project = join(root, 'workspaces', 'owner', 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'index.html'), '<h1>Preview</h1>');
  const items = [{ id: 'm1', type: 'text', content: { content: 'Welcome' }, position: 'left', created_at: 1 }];
  let expired = true;
  const backend = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://backend');
    const json = (status, value) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (url.pathname === '/login') {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const { username, password } = JSON.parse(raw);
      if (password !== 'server-only-password') return json(401, { success: false });
      return json(200, { success: true, token: username });
    }
    if (request.headers.authorization !== 'Bearer owner@example.com') return json(403, { success: false });
    if (expired) { expired = false; return json(401, { success: false }); }
    if (url.pathname === '/api/teams/team') return json(200, { success: true, data: {
      leader_assistant_id: 'lead-slot', assistants: [{ slot_id: 'lead-slot', role: 'lead', conversation_id: 'leader' }],
    } });
    if (url.pathname === '/api/conversations/leader') return json(200, { success: true, data: {
      id: 'leader', name: 'Leader', runtime: { can_send_message: true },
    } });
    if (url.pathname === '/api/conversations/leader/messages') {
      if (request.method === 'POST') {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const content = JSON.parse(raw).content;
        items.push({ id: 'm2', type: 'text', content: { content }, position: 'right', created_at: 2 });
        items.push({ id: 'm3', type: 'text', content: { content: 'Updated website' }, position: 'left', created_at: 3 });
        return json(200, { success: true, data: { accepted: true } });
      }
      return json(200, { success: true, data: { items, oldest_cursor: 'm1', has_more_before: false } });
    }
    return json(404, { success: false });
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const config = {
    previewScanRoot: join(root, 'workspaces'), adminEmails: new Set(['owner@example.com']),
    aionBackendUrl: `http://127.0.0.1:${backend.address().port}`,
    aionUsers: new Map(['owner@example.com', 'viewer@example.com'].map((username) => [username, { username, password: 'server-only-password' }])),
  };
  const registry = new PreviewRegistry(join(root, 'registry.json'));
  const entry = await registry.ensure({ relativePath: 'owner/project', slug: 'demo', teamId: 'team', conversationId: 'worker' });
  const server = createGatewayServer({ config, registry, authenticate: async (request) => {
    const email = request.headers.authorization?.replace('Bearer ', '');
    return config.aionUsers.has(email) ? { email } : null;
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.publicUrl = `http://127.0.0.1:${server.address().port}`;
  const path = `${config.publicUrl}/api/previews/${entry.slug}/chat`;
  const headers = { authorization: 'Bearer owner@example.com' };
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${path}/messages`)).status, 401);
    assert.equal((await fetch(`${path}/messages`, { headers: { authorization: 'Bearer viewer@example.com' } })).status, 403);
    const history = await fetch(`${path}/messages`, { headers });
    assert.equal(history.status, 200);
    const snapshot = await history.json();
    assert.equal(snapshot.conversationId, 'leader');
    assert.deepEqual(snapshot.messages.map((item) => item.text), ['Welcome']);
    assert.doesNotMatch(JSON.stringify(snapshot), /server-only-password|Bearer/);
    const stream = await fetch(`${path}/events`, { headers, signal: controller.signal });
    const reader = stream.body.getReader();
    let buffer = '';
    async function next() {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split('\ndata: ')[1];
          if (data) return JSON.parse(data);
          continue;
        }
        const result = await reader.read();
        assert.equal(result.done, false);
        buffer += Buffer.from(result.value).toString();
      }
    }
    assert.equal((await next()).messages.length, 1);
    const send = (origin, content = 'Make it blue') => fetch(`${path}/messages`, {
      method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json' }, body: JSON.stringify({ content }),
    });
    assert.equal((await send('https://attacker.example.com')).status, 403);
    assert.equal((await send(config.publicUrl, '')).status, 400);
    assert.equal((await send(config.publicUrl)).status, 202);
    assert.deepEqual((await next()).messages.map((item) => item.text), ['Welcome', 'Make it blue', 'Updated website']);
    await registry.setEnabled(entry.slug, false);
    assert.deepEqual(await next(), {});
    assert.equal((await fetch(`${path}/messages`, { headers })).status, 404);
  } finally {
    controller.abort(); server.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => backend.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  }
});
