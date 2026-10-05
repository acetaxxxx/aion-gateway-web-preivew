import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { discoverHtml, resolveRegisteredPreview, validateRelativePath, previewScanRoot } from './filesystem.mjs';

// One registration seam for MCP and the browser. Agent absolute paths are
// translated to the Gateway mount; they never become arbitrary filesystem reads.
export class Previews {
  #discovery;
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
    const root = resolve(this.agentRoot(workspaceScope));
    const rel = relative(root, resolve(path));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw Object.assign(new Error('Workspace path is outside the allowed Agent root'), { statusCode: 400 });
    }
    return validateRelativePath(rel);
  }

  agentRoot(scope) {
    return scope === 'team' ? this.config.teamAgentWorkspaceRoot : scope === 'data' ? (this.config.dataAgentWorkspaceRoot ?? '/data') : this.config.agentWorkspaceRoot;
  }

  async discover() {
    if (!this.config.dataPreviewScanRoot) return { truncated: false, configured: false };
    if (!this.#discovery) this.#discovery = this.#scan().finally(() => { this.#discovery = undefined; });
    return this.#discovery;
  }

  async #scan() {
    const scan = await discoverHtml(this.config.dataPreviewScanRoot);
    const identities = new Map();
    for (const entry of await this.registry.list({ includeRemoved: true })) {
      try {
        const root = await realpath(previewScanRoot(this.config, entry));
        // Lexical identities persist tombstones even when a removed file is
        // temporarily missing. Serving still uses canonical validation.
        identities.set(entry.id, resolve(root, entry.relativePath, entry.entryFile ?? 'index.html'));
      } catch { /* An unavailable old mount cannot be matched this scan. */ }
    }
    const candidates = [];
    let rejected = 0;
    for (const item of scan.candidates) {
      let candidate = { ...item, workspaceScope: 'data' };
      try {
        const validated = await resolveRegisteredPreview(this.config, candidate);
        const file = resolve(validated.directory, candidate.entryFile);
        // Retain the old scopes for discoveries in the existing mounts. In
        // particular Team descendants remain guarded by their bound subtree.
        for (const [scope, configuredRoot] of [['team', this.config.teamPreviewScanRoot], ['user', this.config.previewScanRoot]]) {
          if (!configuredRoot) continue;
          const root = await realpath(configuredRoot).catch(() => null);
          if (!root) continue;
          const rel = relative(root, validated.directory);
          if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
          candidate = { ...candidate, relativePath: rel.split(sep).join('/'), workspaceScope: scope,
            ...(scope === 'team' ? { teamId: rel.split(sep)[0] } : {}) };
          await resolveRegisteredPreview(this.config, candidate);
          break;
        }
        candidates.push({ ...candidate, discoveryKey: file });
      } catch { rejected += 1; }
    }
    const added = await this.registry.discover(candidates, identities);
    const { candidates: found, ...status } = scan;
    return { ...status, configured: true, found: found.length, added, rejected };
  }

  async register({ path, relativePath, title, slug, teamId, conversationId, workspaceScope, entryFile = 'index.html' }, { reuse = false } = {}) {
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
    const validated = await resolveRegisteredPreview(this.config, { relativePath: clean, workspaceScope, teamId, entryFile }, { requireEntry: !reuse });
    if (reuse) return this.registry.ensure({ relativePath: validated.relativePath, title, slug, teamId, conversationId, workspaceScope, entryFile });
    return this.registry.add({ relativePath: validated.relativePath, title, workspaceScope, teamId, entryFile });
  }

  describe(entry) {
    return {
      id: entry.id, slug: entry.slug, title: entry.title, enabled: entry.enabled,
      url: `${this.config.publicUrl}/p/${entry.slug}`,
      entryFile: entry.entryFile ?? 'index.html',
      canRename: Boolean(this.config.catalogRenameAllowed),
      chatBound: Boolean(entry.conversationId || (entry.teamId && !entry.autoDiscovered)),
      workspacePath: resolve(this.agentRoot(entry.workspaceScope), entry.relativePath),
      workspaceScope: entry.workspaceScope ?? 'user',
      createdAt: entry.createdAt, updatedAt: entry.updatedAt ?? entry.createdAt,
      ...(entry.teamId ? { teamId: entry.teamId } : {}),
      ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    };
  }
}
