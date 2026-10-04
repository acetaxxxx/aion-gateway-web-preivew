import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticateRequest } from './access.mjs';
import { discoverCandidates, resolvePreviewDirectory, resolvePreviewFile, verifyPreviewFile } from './filesystem.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY_BYTES = 16 * 1024;
const MIME_TYPES = new Map([
  ['.avif', 'image/avif'], ['.css', 'text/css; charset=utf-8'], ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'], ['.ico', 'image/x-icon'], ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'], ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'], ['.mp3', 'audio/mpeg'], ['.mp4', 'video/mp4'],
  ['.otf', 'font/otf'], ['.pdf', 'application/pdf'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'], ['.wasm', 'application/wasm'], ['.webm', 'video/webm'],
  ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.webp', 'image/webp'],
]);

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function sendError(response, error) {
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error('Gateway request failed:', error.message);
  sendJson(response, status, { error: status >= 500 ? 'Internal server error' : error.message });
}

function isAdmin(identity, config) {
  return config.adminEmails.has(identity.email);
}

function safePreview(entry, admin) {
  const value = { slug: entry.slug, title: entry.title, enabled: entry.enabled };
  if (admin) value.relativePath = entry.relativePath;
  return value;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('Request body must be a JSON object'), { statusCode: 400 });
  }
  return parsed;
}

function contentSecurityPolicy(isHtml) {
  if (!isHtml) return "default-src 'none'";
  return "default-src 'self' data: blob: https:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline' https:; connect-src 'self' https:; font-src 'self' data: https:; object-src 'none'; base-uri 'none'; form-action 'none'";
}

async function streamFile(request, response, filePath) {
  const extension = extname(filePath).toLowerCase();
  const isHtml = extension === '.html' || extension === '.htm';
  response.writeHead(200, {
    'content-type': MIME_TYPES.get(extension) ?? 'application/octet-stream',
    'cache-control': 'no-store',
    'content-security-policy': contentSecurityPolicy(isHtml),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (request.method === 'HEAD') return response.end();
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on('error', rejectPromise);
    response.on('close', () => stream.destroy());
    stream.on('end', resolvePromise);
    stream.pipe(response);
  });
}

function adminPage(slug) {
  const publicPath = resolve(PUBLIC_DIR, 'index.html');
  if (!slug) return readFile(publicPath);
  return readFile(publicPath, 'utf8').then((html) => Buffer.from(
    html.replace('<body>', `<body data-preview-slug="${slug.replace(/[&<>"']/g, '')}">`),
  ));
}

export function createGatewayServer({ config, registry, authenticate = (request) => authenticateRequest(request, config) }) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://gateway.local');
      if (url.pathname === '/healthz' && request.method === 'GET') {
        return sendJson(response, 200, { status: 'ok' });
      }

      const identity = await authenticate(request);
      if (!identity) return sendJson(response, 401, { error: 'Cloudflare Access authentication required' });
      const admin = isAdmin(identity, config);

      if (url.pathname === '/' && request.method === 'GET') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        return response.end(await adminPage());
      }

      if (['/app.js', '/app.css'].includes(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
        return await streamFile(request, response, resolve(PUBLIC_DIR, url.pathname.slice(1)));
      }

      const pageMatch = url.pathname.match(/^\/p\/([a-z0-9-]+)\/?$/);
      if (pageMatch && request.method === 'GET') {
        const entries = await registry.list();
        const entry = entries.find((item) => item.slug === pageMatch[1] && item.enabled);
        if (!entry) return sendJson(response, 404, { error: 'Preview not found' });
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        });
        return response.end(await adminPage(entry.slug));
      }

      if (url.pathname === '/api/me' && request.method === 'GET') {
        return sendJson(response, 200, { email: identity.email, admin });
      }

      if (url.pathname === '/api/previews' && request.method === 'GET') {
        const entries = (await registry.list()).filter((entry) => admin || entry.enabled);
        return sendJson(response, 200, { previews: entries.map((entry) => safePreview(entry, admin)) });
      }

      if (url.pathname === '/api/candidates' && request.method === 'GET') {
        if (!admin) return sendJson(response, 403, { error: 'Administrator access required' });
        return sendJson(response, 200, { candidates: await discoverCandidates(config.previewScanRoot) });
      }

      if (url.pathname === '/api/previews' && request.method === 'POST') {
        if (!admin) return sendJson(response, 403, { error: 'Administrator access required' });
        const body = await readJson(request);
        if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
          return sendJson(response, 400, { error: 'title must be a string' });
        }
        const validated = await resolvePreviewDirectory(config.previewScanRoot, body.relativePath);
        const entry = await registry.add({ relativePath: validated.relativePath, title: body.title });
        return sendJson(response, 201, { preview: safePreview(entry, true) });
      }

      const toggleMatch = url.pathname.match(/^\/api\/previews\/([a-z0-9-]+)$/);
      if (toggleMatch && request.method === 'PATCH') {
        if (!admin) return sendJson(response, 403, { error: 'Administrator access required' });
        const body = await readJson(request);
        if (typeof body.enabled !== 'boolean') {
          return sendJson(response, 400, { error: 'enabled must be a boolean' });
        }
        const entry = await registry.setEnabled(toggleMatch[1], body.enabled);
        return entry
          ? sendJson(response, 200, { preview: safePreview(entry, true) })
          : sendJson(response, 404, { error: 'Preview not found' });
      }

      const fileMatch = url.pathname.match(/^\/preview\/([a-z0-9-]+)(?:\/(.*))?$/);
      if (fileMatch && ['GET', 'HEAD'].includes(request.method)) {
        const entries = await registry.list();
        const entry = entries.find((item) => item.slug === fileMatch[1] && item.enabled);
        if (!entry) return sendJson(response, 404, { error: 'Preview not found' });
        const preview = await resolvePreviewDirectory(config.previewScanRoot, entry.relativePath);
        const requestedPath = fileMatch[2] ?? '';
        const filePath = resolvePreviewFile(preview.directory, requestedPath);
        const verifiedPath = await verifyPreviewFile(preview.directory, filePath);
        if (['.html', '.htm', '.svg'].includes(extname(verifiedPath).toLowerCase())
          && request.headers['sec-fetch-dest'] !== 'iframe') {
          return sendJson(response, 403, { error: 'Active preview documents must be loaded in the sandboxed preview frame' });
        }
        return await streamFile(request, response, verifiedPath);
      }

      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      return sendError(response, error);
    }
  });
}
