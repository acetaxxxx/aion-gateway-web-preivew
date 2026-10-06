import { locale, t, translatePage } from './i18n.js';

translatePage();

const list = document.querySelector('#preview-list');
const emptyState = document.querySelector('#empty-state');
const adminPanel = document.querySelector('#admin-panel');
const adminStatus = document.querySelector('#admin-status');
const catalogStatus = document.querySelector('#catalog-status');
const discoveryStatus = document.querySelector('#discovery-status');
const select = document.querySelector('#candidate-select');
const addForm = document.querySelector('#add-preview-form');
const previewSlug = document.body.dataset.previewSlug;
let catalog = [];
let catalogAdmin = false;
let activePreviewUrl = '';

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
  const previewUrl = `/p/${encodeURIComponent(entry.slug)}`;
  const heading = element('h3');
  const titleLink = element('a', '', entry.title);
  titleLink.href = previewUrl;
  heading.append(titleLink);
  details.append(heading);
  const displayPath = entry.displayPath ?? (entry.relativePath
    ? `${entry.relativePath}/${entry.entryFile || 'index.html'}`
    : entry.entryFile || 'index.html');
  const path = element('p', 'preview-path');
  const pathLink = element('a', '', displayPath);
  pathLink.href = previewUrl;
  path.append(pathLink);
  details.append(path);
  const state = { ready: 'preview.ready', waiting: 'preview.waiting', missing: 'preview.missing', disabled: 'preview.disabled' };
  details.append(element('p', '', t(entry.teamId ? 'preview.teamMetadata' : 'preview.metadata', {
    status: state[entry.status] ? t(state[entry.status]) : entry.status,
    teamId: entry.teamId, date: new Date(entry.updatedAt).toLocaleString(locale),
  })));
  const actions = element('div', 'preview-actions');
  const open = element('a', '', t('preview.open'));
  open.href = previewUrl;
  actions.append(open);
  if (entry.canRename ?? admin) {
    const rename = element('button', 'secondary', t('preview.rename'));
    rename.type = 'button';
    rename.addEventListener('click', async () => {
      const title = window.prompt(t('preview.renamePrompt'), entry.title);
      if (!title?.trim()) return;
      try {
        await request(`/api/previews/${encodeURIComponent(entry.slug)}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) });
        await loadPreviews(admin);
        catalogStatus.textContent = t('catalog.renamed');
      } catch (error) { catalogStatus.textContent = error.message; }
    });
    actions.append(rename);
  }
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
    const remove = element('button', 'secondary', t('preview.remove'));
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!window.confirm(t('preview.removeConfirm'))) return;
      try {
        await request(`/api/previews/${encodeURIComponent(entry.slug)}`, { method: 'DELETE' });
        await loadPreviews(admin);
      } catch (error) { adminStatus.textContent = error.message; }
    });
    actions.append(remove);
  }
  card.append(details, actions);
  return card;
}

async function loadPreviews(admin) {
  const { previews, discovery } = await request('/api/previews');
  catalog = previews;
  catalogAdmin = admin;
  discoveryStatus.textContent = discovery?.truncated ? t('catalog.truncated') : '';
  renderCatalog();
}

function renderCatalog() {
  const search = document.querySelector('#preview-search').value.toLowerCase();
  const entries = catalog.filter((entry) => `${entry.title} ${entry.displayPath ?? entry.relativePath ?? ''} ${entry.entryFile ?? ''} ${entry.teamId ?? ''}`.toLowerCase().includes(search));
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
  document.title = `${entry.title} · Aion Workspace`;
  document.querySelector('#preview-list-panel').classList.add('hidden');
  document.querySelector('#preview-shell').classList.remove('hidden');
  document.querySelector('#preview-name').textContent = entry.title;
  const entryFile = (entry.entryFile || 'index.html').split('/').map(encodeURIComponent).join('/');
  const previewUrl = `/preview/${encodeURIComponent(entry.slug)}/${entryFile}`;
  activePreviewUrl = previewUrl;
  const frame = document.querySelector('#preview-frame');
  const status = document.querySelector('#preview-status');
  let liveReloadAvailable = true;
  let previewEvents = null;
  const autoRefresh = document.querySelector('#auto-refresh');
  if (entry.status === 'ready') {
    frame.src = previewUrl;
    status.textContent = t('preview.loaded');
  } else {
    frame.classList.add('hidden');
    status.textContent = t('preview.waitingForAgent');
  }
  function update(event) {
    const state = JSON.parse(event.data);
    if (!state.available) {
      frame.removeAttribute('src');
      frame.classList.add('hidden');
      status.textContent = t('preview.waitingForAgent');
      return;
    }
    frame.classList.remove('hidden');
    frame.src = state.revision === undefined ? previewUrl : `${previewUrl}?v=${encodeURIComponent(state.revision)}`;
    liveReloadAvailable = state.liveReloadAvailable !== false;
    status.textContent = t(liveReloadAvailable ? 'preview.connected' : 'preview.manualRefresh');
  }
  function connectPreviewEvents() {
    if (!autoRefresh.checked || previewEvents) return;
    const events = new EventSource(`/api/previews/${encodeURIComponent(entry.slug)}/events`);
    previewEvents = events;
    events.addEventListener('ready', update);
    events.addEventListener('reload', update);
    events.addEventListener('disabled', () => {
      events.close();
      if (previewEvents === events) previewEvents = null;
      frame.removeAttribute('src'); frame.classList.add('hidden');
      status.textContent = t('preview.disabledNotice');
    });
    events.onerror = () => {
      status.textContent = t(frame.hasAttribute('src')
        ? liveReloadAvailable ? 'preview.reconnectingManual' : 'preview.manualRefresh'
        : 'preview.reconnecting');
    };
  }
  autoRefresh.addEventListener('change', () => {
    if (autoRefresh.checked) {
      status.textContent = t('preview.connecting');
      connectPreviewEvents();
    } else {
      previewEvents?.close();
      previewEvents = null;
      status.textContent = t('preview.autoRefreshPaused');
    }
  });
  connectPreviewEvents();
  window.addEventListener('pagehide', () => previewEvents?.close(), { once: true });
  const chatBound = entry.chatBound ?? Boolean(entry.conversationId || entry.teamId);
  if (chatBound) {
    document.querySelector('#chat-toggle').classList.remove('hidden');
    await showChat(entry.slug);
  }
}

async function start() {
  try {
    const me = await request('/api/me');
    if (previewSlug) {
      document.body.classList.add('preview-mode');
      return await showPreview();
    }
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

document.querySelector('#preview-reload').addEventListener('click', () => {
  const frame = document.querySelector('#preview-frame');
  if (!activePreviewUrl || frame.classList.contains('hidden')) return;
  frame.src = `${activePreviewUrl}?v=${Date.now()}`;
});

const chatPanel = document.querySelector('#chat-panel');
const chatToggle = document.querySelector('#chat-toggle');
chatToggle.addEventListener('click', () => {
  const expanded = chatPanel.classList.toggle('hidden') === false;
  chatToggle.setAttribute('aria-expanded', String(expanded));
});
document.querySelector('#chat-close').addEventListener('click', () => {
  chatPanel.classList.add('hidden');
  chatToggle.setAttribute('aria-expanded', 'false');
});

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
  try { await loadCandidates(); await loadPreviews(catalogAdmin); adminStatus.textContent = t('admin.directoriesUpdated'); }
  catch (error) { adminStatus.textContent = error.message; }
});

document.querySelector('#refresh-previews').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  catalogStatus.textContent = t('catalog.refreshing');
  try {
    await loadPreviews(catalogAdmin);
    catalogStatus.textContent = t('catalog.refreshed');
  } catch (error) { catalogStatus.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector('#preview-search').addEventListener('input', renderCatalog);
start();
