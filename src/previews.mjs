import { isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveRegisteredPreview, validateRelativePath, previewScanRoot } from './filesystem.mjs';

// One registration seam for MCP and the browser. Agent absolute paths are
// translated to the Gateway mount; they never become arbitrary filesystem reads.
export class Previews {
  constructor(config, registry) {
    this.config = config;
    this.registry = registry;
  }

  relativePath(path, workspaceScope = 'user') {
    if (typeof path !== 'string') return validateRelativePath(path);
    if (!isAbsolute(path)) return validateRelativePath(path);
    if (path.includes('\\') || path.includes('\0') || path.split('/').some((part) => part === '..' || part === '.')) {
      throw Object.assign(new Error('Invalid workspace path'), { statusCode: 400 });
    }
    const root = resolve(workspaceScope === 'team' ? this.config.teamAgentWorkspaceRoot : this.config.agentWorkspaceRoot);
    const rel = relative(root, resolve(path));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw Object.assign(new Error('Workspace path is outside the allowed Agent root'), { statusCode: 400 });
    }
    return validateRelativePath(rel);
  }

  async register({ path, relativePath, title, slug, teamId, conversationId, workspaceScope }, { reuse = false } = {}) {
    // Absolute paths select their configured mount, not the chat binding:
    // legacy private Teams may still use a personal conversation workspace.
    if (!workspaceScope) {
      const rel = typeof path === 'string' && isAbsolute(path) && this.config.teamAgentWorkspaceRoot
        ? relative(resolve(this.config.teamAgentWorkspaceRoot), resolve(path)) : null;
      workspaceScope = rel !== null && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? 'team' : 'user';
    }
    previewScanRoot(this.config, { workspaceScope });
    const requested = relativePath ?? this.relativePath(path, workspaceScope);
    const clean = validateRelativePath(requested);
    if (workspaceScope === 'team') {
      const pathTeamId = clean.split('/')[0];
      if (teamId && teamId !== pathTeamId) throw Object.assign(new Error('Team workspace does not match the bound Team'), { statusCode: 400 });
      teamId = pathTeamId;
    }
    const validated = await resolveRegisteredPreview(this.config, { relativePath: clean, workspaceScope, teamId }, { requireEntry: !reuse });
    if (reuse) return this.registry.ensure({ relativePath: validated.relativePath, title, slug, teamId, conversationId, workspaceScope });
    return this.registry.add({ relativePath: validated.relativePath, title, workspaceScope, teamId });
  }

  describe(entry) {
    return {
      id: entry.id, slug: entry.slug, title: entry.title, enabled: entry.enabled,
      url: `${this.config.publicUrl}/p/${entry.slug}`,
      workspacePath: resolve(entry.workspaceScope === 'team' ? this.config.teamAgentWorkspaceRoot : this.config.agentWorkspaceRoot, entry.relativePath),
      workspaceScope: entry.workspaceScope ?? 'user',
      createdAt: entry.createdAt, updatedAt: entry.updatedAt ?? entry.createdAt,
      ...(entry.teamId ? { teamId: entry.teamId } : {}),
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    };
  }
}
