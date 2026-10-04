import { isAbsolute, relative, resolve, sep } from 'node:path';
import { resolvePreviewDirectory, validateRelativePath } from './filesystem.mjs';

// One registration seam for MCP and the browser. Agent absolute paths are
// translated to the Gateway mount; they never become arbitrary filesystem reads.
export class Previews {
  constructor(config, registry) {
    this.config = config;
    this.registry = registry;
  }

  relativePath(path) {
    if (typeof path !== 'string') return validateRelativePath(path);
    if (!isAbsolute(path)) return validateRelativePath(path);
    if (path.includes('\\') || path.includes('\0') || path.split('/').some((part) => part === '..' || part === '.')) {
      throw Object.assign(new Error('Invalid workspace path'), { statusCode: 400 });
    }
    const root = resolve(this.config.agentWorkspaceRoot);
    const rel = relative(root, resolve(path));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw Object.assign(new Error('Workspace path is outside the allowed Agent root'), { statusCode: 400 });
    }
    return validateRelativePath(rel);
  }

  async register({ path, relativePath, title, slug, teamId, conversationId }, { reuse = false } = {}) {
    const requested = relativePath ?? this.relativePath(path);
    const validated = await resolvePreviewDirectory(this.config.previewScanRoot, requested, { requireEntry: !reuse });
    if (reuse) return this.registry.ensure({ relativePath: validated.relativePath, title, slug, teamId, conversationId });
    return this.registry.add({ relativePath: validated.relativePath, title });
  }

  describe(entry) {
    return {
      id: entry.id, slug: entry.slug, title: entry.title, enabled: entry.enabled,
      url: `${this.config.publicUrl}/p/${entry.slug}`,
      workspacePath: resolve(this.config.agentWorkspaceRoot, entry.relativePath),
      createdAt: entry.createdAt, updatedAt: entry.updatedAt ?? entry.createdAt,
      ...(entry.teamId ? { teamId: entry.teamId } : {}),
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    };
  }
}
