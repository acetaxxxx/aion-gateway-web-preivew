import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

export function authenticateMcp(request, config) {
  if (!config.mcpToken) return false;
  const actual = Buffer.from(request.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${config.mcpToken}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function handleMcp(request, response, { config, registry, previews, body }) {
  const origin = request.headers.origin;
  if (origin && origin !== config.publicUrl) {
    response.writeHead(403).end();
    return;
  }
  // Stateless per-request transports avoid session affinity in Docker and let
  // multiple Aion conversations use the same endpoint concurrently.
  const server = new McpServer({ name: 'aion-workspace-preview', version: '0.1.0' }, {
    instructions: 'When an HTML artifact is ready in the current Aion workspace, call preview_create and return its URL to the user. Continue editing the same directory; the browser updates automatically. Do not upload files or register again after each edit. All registered previews are shared with the configured Cloudflare Access audience.',
  });
  server.registerTool('preview_create', {
    description: 'Start a preview: register or reuse a project directory in the current Aion workspace and return its stable browser URL to the user. You may register before index.html is ready; the page waits and updates when files appear. Existing disabled previews remain disabled.',
    inputSchema: {
      path: z.string().min(1).max(1024), slug: slugSchema.optional(), title: z.string().max(120).optional(),
      teamId: z.string().max(128).optional(), conversationId: z.string().max(128).optional(),
    },
  }, async (input) => {
    try { return result(previews.describe(await previews.register(input, { reuse: true }))); }
    catch (error) { return { content: [{ type: 'text', text: error.statusCode ? error.message : 'Workspace preview is not available' }], isError: true }; }
  });
  server.registerTool('preview_get', {
    description: 'Look up a registered preview by slug, including disabled entries.',
    inputSchema: { slug: slugSchema }, annotations: { readOnlyHint: true },
  }, async ({ slug }) => {
    const entry = (await registry.list()).find((item) => item.slug === slug);
    return entry ? result(previews.describe(entry)) : { content: [{ type: 'text', text: 'Preview not found' }], isError: true };
  });
  server.registerTool('preview_list', {
    description: 'List previews in the shared Gateway catalog. Visibility is shared, not filtered by team or conversation.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => result({ previews: (await registry.list()).map((entry) => previews.describe(entry)) }));
  const changesSchema = {
    slug: slugSchema, title: z.string().trim().min(1).max(120).optional(), enabled: z.boolean().optional(),
    teamId: z.string().max(128).optional(), conversationId: z.string().max(128).optional(),
  };
  async function update({ slug, ...changes }) {
    const entry = await registry.update(slug, changes);
    return entry ? result(previews.describe(entry)) : { content: [{ type: 'text', text: 'Preview not found' }], isError: true };
  }
  server.registerTool('preview_update', {
    description: 'Update preview display metadata or enable/disable it. The URL and workspace directory stay stable.',
    inputSchema: changesSchema,
  }, update);
  server.registerTool('preview_rename', {
    description: 'Rename the displayed title without changing the stable URL.',
    inputSchema: { slug: slugSchema, title: z.string().trim().min(1).max(120) },
  }, update);
  server.registerTool('preview_bind_conversation', {
    description: 'Bind the preview to its Aion conversation or Team Leader for in-page chat. Aion still enforces each viewer\'s chat permissions.',
    inputSchema: { slug: slugSchema, conversationId: z.string().min(1).max(128), teamId: z.string().max(128).optional() },
  }, update);
  server.registerTool('preview_remove', {
    description: 'Remove only the preview registration. Workspace files are never deleted.',
    inputSchema: { slug: slugSchema }, annotations: { destructiveHint: true },
  }, async ({ slug }) => result({ removed: await registry.remove(slug) }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  response.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
