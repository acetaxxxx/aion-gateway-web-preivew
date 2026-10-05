import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreviewRegistry } from '../src/registry.mjs';
import { PreviewChanges } from '../src/changes.mjs';
import { createGatewayServer } from '../src/server.mjs';

test('homepage discovers Shared Team HTML, viewer renames its label, stable links survive, and refresh shows new files', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-html-catalog-'));
  const data = join(root, 'data');
  const personalRoot = join(data, 'conversations', 'users');
  const teamRoot = join(data, 'teams');
  const teamProject = join(teamRoot, 'team-1', 'project');
  const sibling = join(teamRoot, 'team-2', 'private');
  await Promise.all([
    mkdir(personalRoot, { recursive: true }), mkdir(teamProject, { recursive: true }),
    mkdir(sibling, { recursive: true }), mkdir(join(data, 'credentials'), { recursive: true }),
    mkdir(join(data, 'reports'), { recursive: true }),
  ]);
  await writeFile(join(teamProject, 'index.html'), '<h1>Team screen version one</h1>');
  await writeFile(join(teamProject, 'settings.json'), '{"password":"private"}');
  await writeFile(join(teamProject, 'token.txt'), 'private token');
  await writeFile(join(sibling, 'index.html'), '<h1>Other Team private page</h1>');
  await symlink(sibling, join(teamRoot, 'team-1', 'escape'));
  await writeFile(join(data, 'credentials', 'index.html'), '<h1>Must stay hidden</h1>');
  await writeFile(join(data, 'reports', 'quarter.htm'), '<h1>Standalone HTML page</h1>');

  const config = {
    previewScanRoot: personalRoot, agentWorkspaceRoot: '/data/conversations/users',
    teamPreviewScanRoot: teamRoot, teamAgentWorkspaceRoot: '/data/teams',
    dataPreviewScanRoot: data, dataAgentWorkspaceRoot: '/data',
    catalogRenameAllowed: true, publicUrl: 'https://preview.example.com',
    adminEmails: new Set(), aionUsers: new Map(),
  };
  const registry = new PreviewRegistry(join(root, 'gateway', 'previews.json'));
  const changes = new PreviewChanges({ config, registry, pollMs: 100, debounceMs: 100 });
  const server = createGatewayServer({ config, registry, changes, authenticate: async () => ({ email: 'team-viewer@example.com' }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = origin;
  await page.setExtraHTTPHeaders({ authorization: 'Bearer access-fixture' });

  try {
    await page.goto(origin);
    const cards = page.locator('#preview-list .preview-card');
    await expect(cards).toHaveCount(2);
    await expect(page.getByText('credentials', { exact: false })).toHaveCount(0);
    const teamCard = cards.filter({ hasText: 'team-1/project/index.html' });
    await expect(teamCard).toHaveCount(1);
    await expect(teamCard.getByRole('button', { name: '改名' })).toBeVisible();
    await expect(teamCard.getByRole('button', { name: '停用' })).toHaveCount(0);
    const teamLink = teamCard.getByRole('link', { name: 'team-1', exact: true });
    const stableUrl = await teamLink.getAttribute('href');
    await expect(teamLink).toHaveAttribute('href', /^\/p\/[a-z0-9-]+$/);

    await page.once('dialog', (dialog) => dialog.accept('Team dashboard'));
    await teamCard.getByRole('button', { name: '改名' }).click();
    const catalogCards = page.locator('#preview-list .preview-card');
    const renamedCard = catalogCards.filter({ hasText: 'Team dashboard' });
    await expect(renamedCard).toHaveCount(1);
    const renamedLink = renamedCard.getByRole('link', { name: 'Team dashboard', exact: true });
    await expect(renamedLink).toHaveAttribute('href', stableUrl);
    await expect(renamedCard.getByRole('link', { name: 'team-1/project/index.html' })).toHaveAttribute('href', stableUrl);

    await renamedLink.click();
    const frame = page.frameLocator('#preview-frame');
    await expect(frame.locator('h1')).toHaveText('Team screen version one');
    await expect(page.locator('#chat-panel')).toBeHidden();
    const slug = new URL(stableUrl, origin).pathname.split('/').at(-1);
    const sensitiveJson = await page.request.get(`${origin}/preview/${slug}/settings.json`);
    const sensitiveText = await page.request.get(`${origin}/preview/${slug}/token.txt`);
    assertPrivateAssetStatuses(sensitiveJson.status(), sensitiveText.status());
    const crossTeam = await page.request.get(`${origin}/preview/${slug}/escape/index.html`, { headers: { 'sec-fetch-dest': 'iframe' } });
    expect(crossTeam.status()).toBe(404);

    await writeFile(join(teamProject, 'index.html'), '<h1>Team screen version two</h1>');
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${slug}$`));
    await expect(page.frameLocator('#preview-frame').locator('h1')).toHaveText('Team screen version two');

    await page.goto(origin);
    await expect(page.locator('#preview-list .preview-card').filter({ hasText: 'Team dashboard' }).getByRole('link', { name: 'Team dashboard', exact: true }))
      .toHaveAttribute('href', stableUrl);
    const reportCard = cards.filter({ hasText: 'reports/quarter.htm' });
    const reportLink = reportCard.getByRole('link', { name: 'reports/quarter.htm' });
    const reportUrl = await reportLink.getAttribute('href');
    await reportLink.click();
    await expect(page.frameLocator('#preview-frame').locator('h1')).toHaveText('Standalone HTML page');
    await expect(page.locator('#chat-panel')).toBeHidden();
    await page.screenshot({ path: test.info().outputPath('shared-team-html-catalog.png'), fullPage: true });

    await page.goto(`${origin}${reportUrl}`);
    await writeFile(join(data, 'reports', 'quarter.htm'), '<h1>Refreshed standalone page</h1>');
    await page.reload();
    await expect(page.frameLocator('#preview-frame').locator('h1')).toHaveText('Refreshed standalone page');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

function assertPrivateAssetStatuses(jsonStatus, textStatus) {
  expect(jsonStatus).toBe(404);
  expect(textStatus).toBe(404);
}
