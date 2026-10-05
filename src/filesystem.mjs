import { lstat, opendir, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_CANDIDATES = 500;
const MAX_VISITED_DIRECTORIES = 20_000;
const MAX_DEPTH = 12;
const EXCLUDED = new Set(['node_modules', 'vendor', 'bower_components', '__pycache__', 'secrets', 'credentials']);
const DATA_ASSETS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.avif', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp', '.woff', '.woff2', '.otf', '.ttf', '.mp3', '.mp4', '.webm', '.wasm', '.pdf']);

function allowedSegments(path) {
  return path.split('/').every((part) => !part.startsWith('.') && !EXCLUDED.has(part.toLowerCase())
    && !/^(?:secret|credentials?|passwords?|tokens?|auth)(?:[._-]|$)/i.test(part));
}

function isWithin(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function rejectSymlinkHops(root, path) {
  if (!isWithin(root, path)) throw Object.assign(new Error('Preview file is not available'), { statusCode: 404 });
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info || info.isSymbolicLink()) throw Object.assign(new Error('Preview file is not available'), { statusCode: 404 });
  }
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

export async function resolvePreviewDirectory(scanRoot, relativePath, { requireEntry = true, entryFile = 'index.html', allowRoot = false } = {}) {
  const cleanRelativePath = allowRoot && relativePath === '.' ? '.' : validateRelativePath(relativePath);
  if (cleanRelativePath !== '.' && !allowedSegments(cleanRelativePath)) throw Object.assign(new Error('Preview path is not available'), { statusCode: 400 });
  const cleanEntry = validateRelativePath(entryFile);
  if (!allowedSegments(cleanEntry) || !['.html', '.htm'].includes(extname(cleanEntry).toLowerCase())) throw Object.assign(new Error('Invalid HTML entry file'), { statusCode: 400 });
  const root = await realpath(scanRoot);
  const lexicalPath = resolve(root, cleanRelativePath);
  if (!isWithin(root, lexicalPath) || (!allowRoot && lexicalPath === root)) {
    throw Object.assign(new Error('Preview directory is outside the configured root'), { statusCode: 400 });
  }

  const target = await realpath(lexicalPath);
  if (!isWithin(root, target)) {
    throw Object.assign(new Error('Preview directory resolves outside the configured root'), { statusCode: 400 });
  }
  const targetStat = await stat(target);
  const entryPath = await verifyPreviewFile(target, resolve(target, cleanEntry)).catch(() => null);
  const entryStat = entryPath && await stat(entryPath);
  if (!targetStat.isDirectory() || (requireEntry && !entryStat?.isFile())) {
    throw Object.assign(new Error('Preview directory must contain an index.html file'), { statusCode: 400 });
  }
  return { root, directory: target, relativePath: cleanRelativePath, entryFile: cleanEntry };
}

// Old registry entries have no scope and retain their original personal root.
// A separate Team root prevents widening reads to logs, databases or credentials.
export function previewScanRoot(config, entry) {
  if (entry.workspaceScope === undefined || entry.workspaceScope === 'user') return config.previewScanRoot;
  if (entry.workspaceScope === 'team' && config.teamPreviewScanRoot) return config.teamPreviewScanRoot;
  if (entry.workspaceScope === 'data' && config.dataPreviewScanRoot) return config.dataPreviewScanRoot;
  throw Object.assign(new Error('Preview workspace scope is not configured'), { statusCode: 400 });
}

export async function resolveRegisteredPreview(config, entry, options) {
  const scanRoot = previewScanRoot(config, entry);
  if (entry.workspaceScope === 'data') {
    const root = await realpath(scanRoot);
    await rejectSymlinkHops(root, resolve(root, entry.relativePath));
  }
  const preview = await resolvePreviewDirectory(scanRoot, entry.relativePath, { ...options, entryFile: entry.entryFile ?? 'index.html', allowRoot: entry.workspaceScope === 'data' });
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

// Every request revalidates canonical paths. Full-data previews never expose
// arbitrary files merely because an HTML document shares their directory.
export async function verifyRegisteredFile(config, entry, requestedPath) {
  const preview = await resolveRegisteredPreview(config, entry);
  const filePath = resolvePreviewFile(preview.directory, requestedPath || preview.entryFile);
  if (entry.workspaceScope === 'data') {
    if (!allowedSegments(relative(preview.directory, filePath).split(sep).join('/'))) {
      throw Object.assign(new Error('Preview file is not available'), { statusCode: 404 });
    }
    await rejectSymlinkHops(preview.root, filePath);
  }
  const target = await verifyPreviewFile(preview.directory, filePath);
  if (entry.workspaceScope === 'data') {
    if (!DATA_ASSETS.has(extname(target).toLowerCase())) throw Object.assign(new Error('Preview file is not available'), { statusCode: 404 });
    const teamPath = config.teamPreviewScanRoot && relative(resolve(config.teamPreviewScanRoot), filePath);
    if (teamPath && teamPath !== '..' && !teamPath.startsWith(`..${sep}`) && !isAbsolute(teamPath)) {
      const teamRoot = resolve(config.teamPreviewScanRoot, teamPath.split(sep)[0]);
      if (await realpath(teamRoot) !== teamRoot || !isWithin(teamRoot, target)) throw Object.assign(new Error('Preview file is not available'), { statusCode: 404 });
    }
  }
  return target;
}

export async function discoverHtml(scanRoot) {
  const root = await realpath(scanRoot);
  const candidates = [];
  const pending = [{ directory: root, relativePath: '.', depth: 0 }];
  const started = Date.now();
  let visitedDirectories = 0, visitedEntries = 0, truncated = false, skippedDirectories = 0;
  const limits = { candidates: 500, directories: 20_000, entries: 50_000, depth: 32, durationMs: 5000 };
  while (pending.length) {
    if (visitedDirectories >= limits.directories || Date.now() - started >= limits.durationMs) { truncated = true; break; }
    const current = pending.pop();
    visitedDirectories += 1;
    // Refuse replacements/aliases encountered after enumeration.
    const info = await lstat(current.directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink() || await realpath(current.directory) !== current.directory) { skippedDirectories += 1; continue; }
    let directory;
    try { directory = await opendir(current.directory); } catch { skippedDirectories += 1; continue; }
    for await (const entry of directory) {
      if (++visitedEntries > limits.entries || Date.now() - started >= limits.durationMs) { truncated = true; break; }
      if (!allowedSegments(entry.name) || entry.isSymbolicLink()) continue;
      const path = resolve(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= limits.depth || pending.length >= limits.directories) { truncated = true; continue; }
        pending.push({ directory: path, relativePath: current.relativePath === '.' ? entry.name : `${current.relativePath}/${entry.name}`, depth: current.depth + 1 });
      } else if (entry.isFile() && ['.html', '.htm'].includes(extname(entry.name).toLowerCase())) {
        if (candidates.length >= limits.candidates) { truncated = true; break; }
        candidates.push({ relativePath: current.relativePath, entryFile: entry.name,
          title: entry.name === 'index.html' ? (current.relativePath === '.' ? 'data' : current.relativePath.split('/').at(-1)) : entry.name });
      }
    }
    if (visitedEntries > limits.entries || candidates.length >= limits.candidates || Date.now() - started >= limits.durationMs) { truncated = true; break; }
  }
  return { candidates, truncated, visitedDirectories, visitedEntries, skippedDirectories, durationMs: Date.now() - started, limits };
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
