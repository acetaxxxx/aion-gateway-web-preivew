import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveRegisteredPreview, verifyPreviewFile } from './filesystem.mjs';

async function revision(directory) {
  const hash = createHash('sha256');
  const pending = [directory];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop();
    const rel = relative(directory, await realpath(current));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Preview directory escaped its root');
    if (!(await lstat(current)).isDirectory()) throw new Error('Preview directory changed during polling');
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > 5000) throw new Error('Preview has too many files for live reload');
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink()) continue;
      hash.update(JSON.stringify([path.slice(directory.length), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]));
      if (info.isDirectory()) pending.push(path);
    }
  }
  return hash.digest('hex');
}

// Scan only subscribed previews. Polling works with bind mounts (including
// Docker Desktop) where native filesystem notifications may not cross hosts.
export class PreviewChanges {
  #subscriptions = new Map();

  constructor({ config, registry, pollMs = 1000, debounceMs = 400 }) {
    this.config = config;
    this.registry = registry;
    this.pollMs = pollMs;
    this.debounceMs = debounceMs;
  }

  subscribe(slug, listener) {
    let subscription = this.#subscriptions.get(slug);
    if (!subscription) {
      subscription = { listeners: new Set(), current: undefined, pending: undefined, timer: undefined, stopped: false };
      this.#subscriptions.set(slug, subscription);
    }
    subscription.listeners.add(listener);
    if (subscription.current) listener('ready', subscription.current);
    if (!subscription.timer) void this.#poll(slug, subscription).catch(() => {});
    return () => {
      subscription.listeners.delete(listener);
      if (subscription.listeners.size === 0) {
        subscription.stopped = true;
        clearTimeout(subscription.timer);
        this.#subscriptions.delete(slug);
      }
    };
  }

  close() {
    for (const subscription of this.#subscriptions.values()) {
      subscription.stopped = true;
      clearTimeout(subscription.timer);
    }
    this.#subscriptions.clear();
  }

  async #poll(slug, subscription) {
    if (subscription.running || subscription.stopped) return;
    subscription.running = true;
    try {
      const entry = (await this.registry.list()).find((item) => item.slug === slug && item.enabled);
      if (!entry) {
        for (const listener of subscription.listeners) listener('disabled', {});
        return;
      }
      let next;
      try {
        const preview = await resolveRegisteredPreview(this.config, entry);
        const entryPath = await verifyPreviewFile(preview.directory, resolve(preview.directory, preview.entryFile));
        try {
          next = { revision: await revision(preview.directory), available: true, liveReloadAvailable: true };
        } catch {
          // A bounded polling failure does not make a valid HTML entry vanish.
          const info = await stat(entryPath);
          next = { revision: `entry-${info.mtimeMs}-${info.size}`, available: true, liveReloadAvailable: false };
        }
      } catch {
        next = { revision: 'unavailable', available: false };
      }
      if (!subscription.stopped) {
        if (!subscription.current) {
          subscription.current = next;
          for (const listener of subscription.listeners) listener('ready', next);
        } else if (next.revision !== subscription.current.revision) {
          if (subscription.pending?.revision !== next.revision) subscription.pending = { ...next, since: Date.now() };
          if (Date.now() - subscription.pending.since >= this.debounceMs) {
            subscription.current = next;
            subscription.pending = undefined;
            for (const listener of subscription.listeners) listener('reload', next);
          }
        } else subscription.pending = undefined;
      }
    } finally {
      subscription.running = false;
      if (!subscription.stopped) {
        subscription.timer = setTimeout(() => { void this.#poll(slug, subscription).catch(() => {}); }, this.pollMs);
        subscription.timer.unref();
      }
    }
  }
}
