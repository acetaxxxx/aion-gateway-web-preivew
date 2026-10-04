import { locale, t, translatePage } from './i18n.js';

translatePage();

const list = document.querySelector('#preview-list');
const emptyState = document.querySelector('#empty-state');
const adminPanel = document.querySelector('#admin-panel');
const adminStatus = document.querySelector('#admin-status');
const select = document.querySelector('#candidate-select');
const addForm = document.querySelector('#add-preview-form');
const previewSlug = document.body.dataset.previewSlug;
let catalog = [];
let catalogAdmin = false;

async function request(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options?.headers ?? {}), ...(options?.body ? { 'content-type': 'application/json' } : {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? t('request.failed', { status: response.status }));
  return body;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function loadCandidates() {
  const { candidates } = await request('/api/candidates');
  select.replaceChildren(new Option(t('admin.chooseDirectory'), ''));
  for (const candidate of candidates) {
    const option = new Option(t(candidate.workspaceScope === 'team' ? 'admin.teamCandidate' : 'admin.candidate', {
      title: candidate.title, path: candidate.relativePath,
    }), candidate.relativePath);
    option.dataset.workspaceScope = candidate.workspaceScope ?? 'user';
    select.add(option);
  }
  if (candidates.length === 0) select.add(new Option(t('admin.noDirectories'), ''));
}

function renderPreview(entry, admin) {
  const card = element('article', 'preview-card');
  const details = element('div');
  details.append(element('h3', '', entry.title));
  const state = { ready: 'preview.ready', waiting: 'preview.waiting', missing: 'preview.missing', disabled: 'preview.disabled' };
  details.append(element('p', '', t(entry.teamId ? 'preview.teamMetadata' : 'preview.metadata', {
    status: state[entry.status] ? t(state[entry.status]) : entry.status,
    teamId: entry.teamId, date: new Date(entry.updatedAt).toLocaleString(locale),
  })));
  if (admin) details.append(element('p', '', entry.relativePath));
  const actions = element('div', 'preview-actions');
  const open = element('a', '', t('preview.open'));
  open.href = `/p/${encodeURIComponent(entry.slug)}`;
  actions.append(open);
  if (admin) {
    const toggle = element('button', 'secondary', t(entry.enabled ? 'preview.disable' : 'preview.enable'));
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      try {
        await request(`/api/previews/${encodeURIComponent(entry.slug)}`, {
          method: 'PATCH', body: JSON.stringify({ enabled: !entry.enabled }),
        });
        await loadPreviews(admin);
      } catch (error) { adminStatus.textContent = error.message; }
    });
    actions.append(toggle);
    const rename = element('button', 'secondary', t('preview.rename'));
    rename.type = 'button';
    rename.addEventListener('click', async () => {
      const title = window.prompt(t('preview.renamePrompt'), entry.title);
      if (!title?.trim()) return;
      try {
        await request(`/api/previews/${encodeURIComponent(entry.slug)}`, { method: 'PATCH', body: JSON.stringify({ title }) });
        await loadPreviews(admin);
      } catch (error) { adminStatus.textContent = error.message; }
    });
    const remove = element('button', 'secondary', t('preview.remove'));
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!window.confirm(t('preview.removeConfirm'))) return;
      try {
        await request(`/api/previews/${encodeURIComponent(entry.slug)}`, { method: 'DELETE' });
        await loadPreviews(admin);
      } catch (error) { adminStatus.textContent = error.message; }
    });
    actions.append(rename, remove);
  }
  card.append(details, actions);
  return card;
}

async function loadPreviews(admin) {
  const { previews } = await request('/api/previews');
  catalog = previews;
  catalogAdmin = admin;
  renderCatalog();
}

function renderCatalog() {
  const search = document.querySelector('#preview-search').value.toLowerCase();
  const entries = catalog.filter((entry) => `${entry.title} ${entry.teamId ?? ''}`.toLowerCase().includes(search));
  list.replaceChildren(...entries.map((entry) => renderPreview(entry, catalogAdmin)));
  emptyState.classList.toggle('hidden', entries.length > 0);
}

async function showChat(slug) {
  const path = `/api/previews/${encodeURIComponent(slug)}/chat`;
  const status = document.querySelector('#chat-status');
  const messages = document.querySelector('#chat-messages');
  const older = document.querySelector('#chat-older');
  const send = document.querySelector('#chat-send');
  const history = new Map();
  let cursor;
  function render(snapshot) {
    for (const message of snapshot.messages) history.set(message.id, message);
    messages.replaceChildren(...[...history.values()].sort((a, b) => a.createdAt - b.createdAt).map((message) => {
      const node = element('article', `chat-message ${message.role}`);
      node.append(element('strong', '', message.role === 'user' ? message.actorUserId ?? t('chat.you') : t('chat.assistant')), element('div', '', message.text));
      if (message.createdAt) node.append(element('small', '', new Date(message.createdAt).toLocaleString(locale)));
      return node;
    }));
    status.textContent = t('chat.conversation', { name: snapshot.name });
    send.disabled = snapshot.runtime?.can_send_message === false;
  }
  try {
    const snapshot = await request(`${path}/messages`);
    render(snapshot);
    cursor = snapshot.oldestCursor;
    older.classList.toggle('hidden', !snapshot.hasMore);
  } catch (error) {
    status.textContent = error.message;
    send.disabled = true;
    return;
  }
  older.addEventListener('click', async () => {
    try {
      const snapshot = await request(`${path}/messages?before=${encodeURIComponent(cursor)}`);
      render(snapshot);
      cursor = snapshot.oldestCursor;
      older.classList.toggle('hidden', !snapshot.hasMore);
    } catch (error) { status.textContent = error.message; }
  });
  const events = new EventSource(`${path}/events`);
  events.addEventListener('messages', (event) => render(JSON.parse(event.data)));
  for (const name of ['disabled', 'unavailable']) events.addEventListener(name, () => {
    events.close(); send.disabled = true; status.textContent = t('chat.unavailable');
  });
  events.onerror = () => { status.textContent = t('chat.reconnecting'); };
  window.addEventListener('pagehide', () => events.close(), { once: true });
  document.querySelector('#chat-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    send.disabled = true;
    const input = document.querySelector('#chat-input');
    try {
      await request(`${path}/messages`, { method: 'POST', body: JSON.stringify({ content: input.value }) });
      input.value = '';
      status.textContent = t('chat.sent');
    } catch (error) { status.textContent = error.message; send.disabled = false; }
  });
}

async function showPreview() {
  const { previews } = await request('/api/previews');
  const entry = previews.find((item) => item.slug === previewSlug);
  if (!entry) throw new Error(t('preview.notFound'));
  document.querySelector('#page-title').textContent = entry.title;
  document.querySelector('#back-link').classList.remove('hidden');
  document.querySelector('#preview-list-panel').classList.add('hidden');
  document.querySelector('#preview-shell').classList.remove('hidden');
  document.querySelector('#preview-name').textContent = entry.title;
  const previewUrl = `/preview/${encodeURIComponent(entry.slug)}/index.html`;
  const frame = document.querySelector('#preview-frame');
  const status = document.querySelector('#preview-status');
  const events = new EventSource(`/api/previews/${encodeURIComponent(entry.slug)}/events`);
  function update(event) {
    const state = JSON.parse(event.data);
    if (!state.available) {
      frame.removeAttribute('src');
      frame.classList.add('hidden');
      status.textContent = t('preview.waitingForAgent');
      return;
    }
    frame.classList.remove('hidden');
    frame.src = `${previewUrl}?v=${encodeURIComponent(state.revision)}`;
    status.textContent = t('preview.connected');
  }
  events.addEventListener('ready', update);
  events.addEventListener('reload', update);
  events.addEventListener('disabled', () => {
    events.close(); frame.removeAttribute('src'); frame.classList.add('hidden');
    status.textContent = t('preview.disabledNotice');
  });
  events.onerror = () => { status.textContent = t('preview.reconnecting'); };
  window.addEventListener('pagehide', () => events.close(), { once: true });
  document.querySelector('#open-preview').href = `/p/${encodeURIComponent(entry.slug)}`;
  await showChat(entry.slug);
}

async function start() {
  try {
    const me = await request('/api/me');
    if (previewSlug) return await showPreview();
    if (me.admin) {
      adminPanel.classList.remove('hidden');
      await loadCandidates();
    }
    await loadPreviews(me.admin);
  } catch (error) {
    document.querySelector('#page-title').textContent = t('page.loadFailed');
    emptyState.classList.remove('hidden');
    emptyState.textContent = error.message;
  }
}

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  adminStatus.textContent = t('admin.adding');
  try {
    await request('/api/previews', {
      method: 'POST',
      body: JSON.stringify({
        relativePath: select.value,
        workspaceScope: select.selectedOptions[0]?.dataset.workspaceScope ?? 'user',
        title: document.querySelector('#preview-title-input').value,
      }),
    });
    document.querySelector('#preview-title-input').value = '';
    adminStatus.textContent = t('admin.added');
    await loadPreviews(true);
  } catch (error) { adminStatus.textContent = error.message; }
});

document.querySelector('#refresh-candidates').addEventListener('click', async () => {
  try { await loadCandidates(); adminStatus.textContent = t('admin.directoriesUpdated'); }
  catch (error) { adminStatus.textContent = error.message; }
});

document.querySelector('#preview-search').addEventListener('input', renderCatalog);
start();
