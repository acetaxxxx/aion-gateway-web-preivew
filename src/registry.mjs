import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

function makeSlug(title, id) {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'preview';
  return `${base}-${id.slice(0, 8)}`;
}

export class PreviewRegistry {
  #queue = Promise.resolve();

  constructor(filePath) {
    this.filePath = filePath;
  }

  async list() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async add({ relativePath, title, workspaceScope = 'user', teamId }) {
    return this.#mutate(async (entries) => {
      if (entries.some((entry) => entry.relativePath === relativePath && (entry.workspaceScope ?? 'user') === workspaceScope)) {
        throw Object.assign(new Error('This directory is already registered'), { statusCode: 409 });
      }
      const id = randomUUID();
      const cleanTitle = title?.trim().slice(0, 120) || relativePath.split('/').at(-1);
      const entry = {
        id,
        slug: makeSlug(cleanTitle, id),
        title: cleanTitle,
        relativePath,
        ...(workspaceScope === 'team' ? { workspaceScope, teamId } : {}),
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      entries.push(entry);
      return entry;
    });
  }

  async setEnabled(slug, enabled) {
    return this.update(slug, { enabled });
  }

  async update(slug, changes) {
    return this.#mutate(async (entries) => {
      const entry = entries.find((item) => item.slug === slug);
      if (!entry) return null;
      if (entry.workspaceScope === 'team' && changes.teamId !== undefined && changes.teamId !== entry.teamId) {
        throw Object.assign(new Error('A Team workspace cannot be rebound to another Team'), { statusCode: 400 });
      }
      for (const key of ['title', 'enabled', 'teamId', 'conversationId']) {
        if (changes[key] !== undefined) entry[key] = key === 'title' ? changes[key].trim() : changes[key];
      }
      entry.updatedAt = new Date().toISOString();
      return entry;
    });
  }

  async remove(slug) {
    return this.#mutate(async (entries) => {
      const index = entries.findIndex((entry) => entry.slug === slug);
      if (index < 0) return false;
      entries.splice(index, 1);
      return true;
    });
  }

  async ensure({ relativePath, slug, title, teamId, conversationId, workspaceScope = 'user' }) {
    return this.#mutate(async (entries) => {
      const named = slug && entries.find((entry) => entry.slug === slug);
      if (named && (named.relativePath !== relativePath || (named.workspaceScope ?? 'user') !== workspaceScope)) {
        throw Object.assign(new Error('This slug belongs to a different preview'), { statusCode: 409 });
      }
      const existing = named || entries.find((entry) => entry.relativePath === relativePath && (entry.workspaceScope ?? 'user') === workspaceScope);
      if (existing) {
        // Enroll older/manual registrations without silently rebinding another
        // conversation or re-enabling an administrator-disabled preview.
        if (conversationId && !existing.conversationId) {
          existing.conversationId = conversationId;
          if (teamId && !existing.teamId) existing.teamId = teamId;
          existing.updatedAt = new Date().toISOString();
        }
        return existing;
      }
      const id = randomUUID();
      const cleanTitle = title?.trim().slice(0, 120) || relativePath.split('/').at(-1);
      const entry = {
        id, slug: slug || makeSlug(cleanTitle, id), title: cleanTitle, relativePath,
        enabled: true, createdAt: new Date().toISOString(),
        ...(workspaceScope === 'team' ? { workspaceScope } : {}),
        ...(teamId ? { teamId } : {}), ...(conversationId ? { conversationId } : {}),
      };
      entries.push(entry);
      return entry;
    });
  }

  async #mutate(change) {
    const operation = this.#queue.then(async () => {
      const entries = await this.list();
      const result = await change(entries);
      await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = join(dirname(this.filePath), `.previews-${process.pid}-${randomUUID()}.tmp`);
      await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      return result;
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}
