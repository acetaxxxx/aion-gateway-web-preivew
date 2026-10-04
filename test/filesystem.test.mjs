import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCandidates, resolvePreviewDirectory, resolvePreviewFile, verifyPreviewFile } from '../src/filesystem.mjs';

const temporaryDirectories = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'aion-gateway-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('discovers only directories containing index.html and does not follow symlinks', async () => {
  const root = await temporaryDirectory();
  const preview = join(root, 'user', 'project');
  await mkdir(preview, { recursive: true });
  await writeFile(join(preview, 'index.html'), '<h1>ok</h1>');
  await mkdir(join(root, 'user', 'not-a-preview'), { recursive: true });
  await symlink(preview, join(root, 'linked-preview'));

  assert.deepEqual(await discoverCandidates(root), [{ relativePath: 'user/project', title: 'project' }]);
});

test('rejects absolute and traversal paths and symlink targets outside the root', async () => {
  const root = await temporaryDirectory();
  const outside = await temporaryDirectory();
  await mkdir(join(root, 'safe'), { recursive: true });
  await writeFile(join(root, 'safe', 'index.html'), 'ok');
  await mkdir(join(outside, 'foreign'));
  await writeFile(join(outside, 'foreign', 'index.html'), 'secret');
  await symlink(join(outside, 'foreign'), join(root, 'escape'));

  await assert.rejects(resolvePreviewDirectory(root, '../foreign'), /invalid path segment/);
  await assert.rejects(resolvePreviewDirectory(root, '/etc'), /safe relative path/);
  await assert.rejects(resolvePreviewDirectory(root, 'escape'), /outside the configured root/);
});

test('rejects preview files that escape through a symlink', async () => {
  const root = await temporaryDirectory();
  const outside = await temporaryDirectory();
  const preview = join(root, 'site');
  await mkdir(preview);
  await writeFile(join(preview, 'index.html'), 'ok');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(preview, 'secret.txt'));

  const resolved = await resolvePreviewDirectory(root, 'site');
  const target = resolvePreviewFile(resolved.directory, 'secret.txt');
  await assert.rejects(verifyPreviewFile(resolved.directory, target), /not available/);
});
