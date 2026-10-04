import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGatewayServer } from '../src/server.mjs';
import { PreviewRegistry } from '../src/registry.mjs';

test('Team MCP registration preserves personal entries and serves only the dedicated Team subtree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-team-'));
  const config = {
    previewScanRoot: join(root, 'users'), agentWorkspaceRoot: '/data/conversations/users',
    teamPreviewScanRoot: join(root, 'teams'), teamAgentWorkspaceRoot: '/data/teams',
    publicUrl: 'https://preview.example.com', mcpToken: 'team-test-token-'.repeat(3), adminEmails: new Set(['owner@example.com']),
  };
  await mkdir(join(root, 'users', 'team-1', 'project'), { recursive: true });
  await mkdir(join(root, 'teams', 'team-1', 'project'), { recursive: true });
  await writeFile(join(root, 'users', 'team-1', 'project', 'index.html'), '<h1>Personal</h1>');
  const registry = new PreviewRegistry(join(root, 'registry.json'));
  const personal = await registry.add({ relativePath: 'team-1/project', title: 'Personal' });
  const server = createGatewayServer({ config, registry, authenticate: async (request) => request.headers.authorization === 'Bearer browser' ? { email: 'owner@example.com' } : null });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'team-test', version: '1' });
  const headers = { authorization: 'Bearer browser', 'sec-fetch-dest': 'iframe' };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${config.mcpToken}` } } }));
    const create = (path, teamId = 'team-1') => client.callTool({ name: 'preview_create', arguments: { path, teamId, conversationId: 'lead', slug: 'team-web' } });
    const created = await create('/data/teams/team-1/project');
    assert.notEqual(created.isError, true);
    assert.equal(created.structuredContent.workspacePath, '/data/teams/team-1/project');
    assert.notEqual(created.structuredContent.id, personal.id);
    assert.equal((await (await fetch(`${origin}/api/previews`, { headers })).json()).previews.find((entry) => entry.slug === 'team-web').status, 'waiting');
    await writeFile(join(root, 'teams', 'team-1', 'project', 'index.html'), '<h1>Team</h1>');
    assert.equal(await (await fetch(`${origin}/preview/team-web/`, { headers })).text(), '<h1>Team</h1>');
    assert.equal(await (await fetch(`${origin}/preview/${personal.slug}/`, { headers })).text(), '<h1>Personal</h1>');
    assert.equal((await create('/data/teams/team-1/project', 'other-team')).isError, true);
    await assert.rejects(() => registry.update('team-web', { teamId: 'other-team' }), (error) => error.statusCode === 400);
    assert.equal((await create('/data/teams/team-1/../project')).isError, true);
    assert.equal((await create('/data/logs')).isError, true);
    await symlink(join(root, 'users'), join(root, 'teams', 'team-1', 'escape'));
    assert.equal((await create('/data/teams/team-1/escape')).isError, true);
    const reloaded = new PreviewRegistry(registry.filePath);
    assert.equal((await reloaded.list()).find((entry) => entry.slug === 'team-web').workspaceScope, 'team');
  } finally {
    await client.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
