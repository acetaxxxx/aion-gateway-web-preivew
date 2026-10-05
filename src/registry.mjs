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

  async list({ includeRemoved = false } = {}) {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed.filter((entry) => includeRemoved || !entry.removed) : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async add({ relativePath, title, workspaceScope = 'user', teamId, entryFile = 'index.html' }) {
    return this.#mutate(async (entries) => {
      if (entries.some((entry) => !entry.removed && entry.relativePath === relativePath && (entry.entryFile ?? 'index.html') === entryFile && (entry.workspaceScope ?? 'user') === workspaceScope)) {
        throw Object.assign(new Error('This directory is already registered'), { statusCode: 409 });
      }
      const id = randomUUID();
      const cleanTitle = title?.trim().slice(0, 120) || relativePath.split('/').at(-1);
      const entry = {
        id,
        slug: makeSlug(cleanTitle, id),
        title: cleanTitle,
        relativePath,
        ...(entryFile !== 'index.html' ? { entryFile } : {}),
        ...(workspaceScope !== 'user' ? { workspaceScope } : {}),
        ...(teamId ? { teamId } : {}),
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
      const entry = entries.find((item) => item.slug === slug && !item.removed);
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
      const index = entries.findIndex((entry) => entry.slug === slug && !entry.removed);
      if (index < 0) return false;
      entries[index].removed = true;
      entries[index].enabled = false;
      entries[index].updatedAt = new Date().toISOString();
      return true;
    });
  }

  async ensure({ relativePath, slug, title, teamId, conversationId, workspaceScope = 'user', entryFile = 'index.html' }) {
    return this.#mutate(async (entries) => {
      const named = slug && entries.find((entry) => entry.slug === slug);
      if (named?.removed) {
        if (named.relativePath !== relativePath || (named.entryFile ?? 'index.html') !== entryFile
          || (named.workspaceScope ?? 'user') !== workspaceScope) {
          throw Object.assign(new Error('This slug belongs to a different preview'), { statusCode: 409 });
        }
        // An explicit Agent create can republish its removed entry with the
        // same URL. Automatic scans continue treating removed files as tombstones.
        delete named.removed;
        named.enabled = true;
        if (conversationId && !named.conversationId) named.conversationId = conversationId;
        if (teamId && !named.teamId) named.teamId = teamId;
        named.updatedAt = new Date().toISOString();
        return named;
      }
      if (named && (named.relativePath !== relativePath || (named.entryFile ?? 'index.html') !== entryFile || (named.workspaceScope ?? 'user') !== workspaceScope)) {
        throw Object.assign(new Error('This slug belongs to a different preview'), { statusCode: 409 });
      }
      const existing = named || entries.find((entry) => !entry.removed && entry.relativePath === relativePath && (entry.entryFile ?? 'index.html') === entryFile && (entry.workspaceScope ?? 'user') === workspaceScope);
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
        ...(workspaceScope !== 'user' ? { workspaceScope } : {}),
        ...(entryFile !== 'index.html' ? { entryFile } : {}),
        ...(teamId ? { teamId } : {}), ...(conversationId ? { conversationId } : {}),
      };
      entries.push(entry);
      return entry;
    });
  }

  // Called with canonical identities from the filesystem boundary. Reconcile
  // in one serialized write without changing existing titles/chat/enablement.
  async discover(candidates, identities) {
    return this.#mutate(async (entries) => {
      const seen = new Set(entries.map((entry) => identities.get(entry.id) ?? entry.discoveryKey).filter(Boolean));
      let added = 0;
      for (const candidate of candidates) {
        if (seen.has(candidate.discoveryKey)) continue;
        // Also check lexical identity under the mutation lock (manual additions
        // may have completed while the scan was running).
        if (entries.some((entry) => entry.relativePath === candidate.relativePath
          && (entry.workspaceScope ?? 'user') === candidate.workspaceScope
          && (entry.entryFile ?? 'index.html') === candidate.entryFile)) continue;
        const id = randomUUID();
        entries.push({ ...candidate, autoDiscovered: true, id, slug: makeSlug(candidate.title, id), enabled: true, createdAt: new Date().toISOString() });
        seen.add(candidate.discoveryKey);
        added += 1;
      }
      return added;
    });
  }

  async #mutate(change) {
    const operation = this.#queue.then(async () => {
      const entries = await this.list({ includeRemoved: true });
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
