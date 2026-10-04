import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_CANDIDATES = 500;
const MAX_VISITED_DIRECTORIES = 20_000;
const MAX_DEPTH = 12;

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function validateRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw Object.assign(new Error('A relative preview directory is required'), { statusCode: 400 });
  }
  if (value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    throw Object.assign(new Error('The preview directory must be a safe relative path'), { statusCode: 400 });
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw Object.assign(new Error('The preview directory contains an invalid path segment'), { statusCode: 400 });
  }
  return segments.join('/');
}

export async function resolvePreviewDirectory(scanRoot, relativePath, { requireEntry = true } = {}) {
  const cleanRelativePath = validateRelativePath(relativePath);
  const root = await realpath(scanRoot);
  const lexicalPath = resolve(root, cleanRelativePath);
  if (!isWithin(root, lexicalPath) || lexicalPath === root) {
    throw Object.assign(new Error('Preview directory is outside the configured root'), { statusCode: 400 });
  }

  const target = await realpath(lexicalPath);
  if (!isWithin(root, target)) {
    throw Object.assign(new Error('Preview directory resolves outside the configured root'), { statusCode: 400 });
  }
  const targetStat = await stat(target);
  const entryStat = await stat(resolve(target, 'index.html')).catch(() => null);
  if (!targetStat.isDirectory() || (requireEntry && !entryStat?.isFile())) {
    throw Object.assign(new Error('Preview directory must contain an index.html file'), { statusCode: 400 });
  }
  return { root, directory: target, relativePath: cleanRelativePath };
}

// Old registry entries have no scope and retain their original personal root.
// A separate Team root prevents widening reads to logs, databases or credentials.
export function previewScanRoot(config, entry) {
  if (entry.workspaceScope === undefined || entry.workspaceScope === 'user') return config.previewScanRoot;
  if (entry.workspaceScope === 'team' && config.teamPreviewScanRoot) return config.teamPreviewScanRoot;
  throw Object.assign(new Error('Preview workspace scope is not configured'), { statusCode: 400 });
}

export async function resolveRegisteredPreview(config, entry, options) {
  const scanRoot = previewScanRoot(config, entry);
  const preview = await resolvePreviewDirectory(scanRoot, entry.relativePath, options);
  if (entry.workspaceScope === 'team') {
    const pathTeamId = validateRelativePath(entry.relativePath).split('/')[0];
    if (entry.teamId !== pathTeamId) {
      throw Object.assign(new Error('Team workspace does not match the bound Team'), { statusCode: 400 });
    }
    const teamRoot = resolve(preview.root, pathTeamId);
    // Canonicalizing the Team root itself must not silently turn Team A into B.
    if (await realpath(teamRoot) !== teamRoot || !isWithin(teamRoot, preview.directory)) {
      throw Object.assign(new Error('Preview directory resolves outside its bound Team'), { statusCode: 400 });
    }
  }
  return preview;
}

export async function discoverCandidates(scanRoot) {
  const root = await realpath(scanRoot);
  const results = [];
  const pending = [{ directory: root, relativePath: '', depth: 0 }];
  let visited = 0;

  while (pending.length && results.length < MAX_CANDIDATES && visited < MAX_VISITED_DIRECTORIES) {
    const current = pending.pop();
    visited += 1;
    const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.name === 'index.html' && entry.isFile()) && current.relativePath) {
      results.push({
        relativePath: current.relativePath,
        title: current.relativePath.split('/').at(-1),
      });
      continue;
    }
    if (current.depth >= MAX_DEPTH) continue;

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const directory = resolve(current.directory, entry.name);
      const info = await lstat(directory).catch(() => null);
      if (!info?.isDirectory() || info.isSymbolicLink()) continue;
      pending.push({
        directory,
        relativePath: current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name,
        depth: current.depth + 1,
      });
    }
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function resolvePreviewFile(previewDirectory, requestedPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    throw Object.assign(new Error('Invalid preview file path encoding'), { statusCode: 400 });
  }
  const segments = decoded.split('/').filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) {
    throw Object.assign(new Error('Invalid preview file path'), { statusCode: 400 });
  }
  const safeSegments = segments.length ? segments : ['index.html'];
  const filePath = resolve(previewDirectory, ...safeSegments);
  if (!isWithin(previewDirectory, filePath)) {
    throw Object.assign(new Error('Preview file is outside its directory'), { statusCode: 400 });
  }
  return filePath;
}

export async function verifyPreviewFile(previewDirectory, filePath) {
  const root = await realpath(previewDirectory);
  const target = await realpath(filePath).catch(() => null);
  if (!target || !isWithin(root, target)) {
    throw Object.assign(new Error('Preview file is not available'), { statusCode: 404 });
  }
  const info = await stat(target);
  if (!info.isFile()) throw Object.assign(new Error('Preview file is not available'), { statusCode: 404 });
  return target;
}
