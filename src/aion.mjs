function failure(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// All calls retain the verified browser user's Aion identity. Aion authorizes
// conversation ownership; catalog visibility never grants chat access.
export class AionBackend {
  #sessions = new Map();
  #logins = new Map();

  constructor(config, fetchImpl = fetch) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async #token(email) {
    const identity = email.toLowerCase();
    const credentials = this.config.aionUsers?.get(identity)
      ?? [...(this.config.aionUsers ?? [])].find(([key]) => !key.includes('@') && identity.startsWith(`${key}@`))?.[1];
    if (!credentials) throw failure(403, 'This identity is not configured for Aion chat');
    const cached = this.#sessions.get(email);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    if (!this.#logins.has(email)) {
      this.#logins.set(email, (async () => {
        const response = await this.fetch(new URL('/login', this.config.aionBackendUrl), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
        });
        if (!response.ok) throw failure(502, 'Aion authentication failed');
        const body = await response.json();
        if (!body.success || typeof body.token !== 'string') throw failure(502, 'Aion authentication failed');
        this.#sessions.set(email, { token: body.token, expiresAt: Date.now() + 5 * 60_000 });
        return body.token;
      })().finally(() => this.#logins.delete(email)));
    }
    return this.#logins.get(email);
  }

  async #request(email, path, { method = 'GET', body } = {}, retry = true) {
    const token = await this.#token(email);
    const response = await this.fetch(new URL(path, this.config.aionBackendUrl), {
      method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 && retry) {
      this.#sessions.delete(email);
      return this.#request(email, path, { method, body }, false);
    }
    if (!response.ok) throw failure([401, 403, 404, 409, 429].includes(response.status) ? response.status : 502, 'Aion conversation request was rejected');
    const value = await response.json();
    if (value.success !== true) throw failure(502, 'Aion conversation response is unavailable');
    return value.data;
  }

  async conversationId(email, entry) {
    if (entry.teamId) {
      const team = await this.#request(email, `/api/teams/${encodeURIComponent(entry.teamId)}`);
      const lead = team.assistants?.find((member) => member.slot_id === team.leader_assistant_id)
        ?? team.assistants?.find((member) => ['lead', 'leader'].includes(member.role));
      const id = lead?.conversation_id;
      if (!id) throw failure(409, 'Team Leader conversation is not ready');
      return id;
    }
    if (!entry.conversationId) throw failure(409, 'This preview has no bound Aion conversation');
    return entry.conversationId;
  }

  async messages(email, entry, before) {
    const id = await this.conversationId(email, entry);
    const conversation = await this.#request(email, `/api/conversations/${encodeURIComponent(id)}`);
    const query = new URLSearchParams({ limit: '50' });
    if (before) query.set('before', before);
    const page = await this.#request(email, `/api/conversations/${encodeURIComponent(id)}/messages?${query}`);
    return {
      conversationId: id, name: conversation.name, runtime: conversation.runtime,
      messages: (page.items ?? []).filter((item) => item.type === 'text' && !item.hidden).map((item) => ({
        id: item.id, role: item.position === 'right' ? 'user' : 'assistant',
        text: typeof item.content === 'string' ? item.content : item.content?.content ?? '',
        status: item.status, createdAt: item.created_at,
      })),
      oldestCursor: page.oldest_cursor, hasMore: page.has_more_before,
    };
  }

  async send(email, entry, content) {
    const id = await this.conversationId(email, entry);
    return this.#request(email, `/api/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'POST', body: { content },
    });
  }
}
