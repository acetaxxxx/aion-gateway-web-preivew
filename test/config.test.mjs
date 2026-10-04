import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('browser origin remains configured when Agent MCP is disabled', () => {
  const config = loadConfig({
    CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', CF_ACCESS_AUDIENCE: 'audience',
    PREVIEW_SCAN_ROOT: '/data', GATEWAY_DATA_DIR: '/registry',
    GATEWAY_PUBLIC_URL: 'https://preview.example.com',
    AION_BACKEND_USERS: 'owner@example.com:local-owner:password,viewer@example.com:password',
  });
  assert.equal(config.publicUrl, 'https://preview.example.com');
  assert.equal(config.mcpToken, '');
  assert.deepEqual(config.aionUsers.get('owner@example.com'), { username: 'local-owner', password: 'password' });
  assert.deepEqual(config.aionUsers.get('viewer@example.com'), { username: 'viewer@example.com', password: 'password' });
});
