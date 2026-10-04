const list = document.querySelector('#preview-list');
const emptyState = document.querySelector('#empty-state');
const adminPanel = document.querySelector('#admin-panel');
const adminStatus = document.querySelector('#admin-status');
const select = document.querySelector('#candidate-select');
const addForm = document.querySelector('#add-preview-form');
const previewSlug = document.body.dataset.previewSlug;

async function request(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options?.headers ?? {}), ...(options?.body ? { 'content-type': 'application/json' } : {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
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
  select.replaceChildren(new Option('選擇工作目錄…', ''));
  for (const candidate of candidates) {
    select.add(new Option(`${candidate.title} — ${candidate.relativePath}`, candidate.relativePath));
  }
  if (candidates.length === 0) select.add(new Option('找不到含 index.html 的目錄', ''));
}

function renderPreview(entry, admin) {
  const card = element('article', 'preview-card');
  const details = element('div');
  details.append(element('h3', '', entry.title));
  if (admin) details.append(element('p', '', entry.relativePath));
  const actions = element('div', 'preview-actions');
  const open = element('a', '', '開啟');
  open.href = `/p/${encodeURIComponent(entry.slug)}`;
  actions.append(open);
  if (admin) {
    const toggle = element('button', 'secondary', entry.enabled ? '停用' : '啟用');
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
  }
  card.append(details, actions);
  return card;
}

async function loadPreviews(admin) {
  const { previews } = await request('/api/previews');
  list.replaceChildren(...previews.map((entry) => renderPreview(entry, admin)));
  emptyState.classList.toggle('hidden', previews.length > 0);
}

async function showPreview() {
  const { previews } = await request('/api/previews');
  const entry = previews.find((item) => item.slug === previewSlug);
  if (!entry) throw new Error('找不到這個預覽，或預覽已停用。');
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
      status.textContent = '等待 Agent 完成網頁…';
      return;
    }
    frame.classList.remove('hidden');
    frame.src = `${previewUrl}?v=${encodeURIComponent(state.revision)}`;
    status.textContent = '即時預覽已連線，檔案修改後會自動更新。';
  }
  events.addEventListener('ready', update);
  events.addEventListener('reload', update);
  events.addEventListener('disabled', () => {
    events.close(); frame.removeAttribute('src'); frame.classList.add('hidden');
    status.textContent = '此預覽已停用。';
  });
  events.onerror = () => { status.textContent = '正在重新連接即時預覽…'; };
  window.addEventListener('pagehide', () => events.close(), { once: true });
  document.querySelector('#open-preview').href = `/p/${encodeURIComponent(entry.slug)}`;
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
    document.querySelector('#page-title').textContent = '無法載入 Gateway';
    emptyState.classList.remove('hidden');
    emptyState.textContent = error.message;
  }
}

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  adminStatus.textContent = '正在加入…';
  try {
    await request('/api/previews', {
      method: 'POST',
      body: JSON.stringify({
        relativePath: select.value,
        title: document.querySelector('#preview-title-input').value,
      }),
    });
    document.querySelector('#preview-title-input').value = '';
    adminStatus.textContent = '已加入預覽。';
    await loadPreviews(true);
  } catch (error) { adminStatus.textContent = error.message; }
});

document.querySelector('#refresh-candidates').addEventListener('click', async () => {
  try { await loadCandidates(); adminStatus.textContent = '目錄清單已更新。'; }
  catch (error) { adminStatus.textContent = error.message; }
});

start();
