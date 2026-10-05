export const locale = 'zh-TW';

const translations = {
  'page.title': 'Aion Workspace Previews',
  'page.brand': 'AION WORKSPACE',
  'page.heading': '預覽工作區',
  'page.back': '所有預覽',
  'page.loadFailed': '無法載入 Gateway',
  'request.failed': 'Request failed ({status})',
  'admin.heading': '管理',
  'admin.addPreview': '加入預覽',
  'admin.rescan': '重新掃描',
  'admin.directoryLabel': '包含 index.html 的工作目錄',
  'admin.loading': '載入中…',
  'admin.titlePlaceholder': '顯示名稱（選填）',
  'admin.add': '加入',
  'admin.chooseDirectory': '選擇工作目錄…',
  'admin.noDirectories': '找不到含 index.html 的目錄',
  'admin.candidate': '{title} — {path}',
  'admin.teamCandidate': '{title} — Team · {path}',
  'admin.adding': '正在加入…',
  'admin.added': '已加入預覽。',
  'admin.directoriesUpdated': '目錄清單已更新。',
  'preview.openNewTab': '在新分頁開啟',
  'preview.connecting': '正在連接即時預覽…',
  'preview.loaded': '預覽已載入；可重新整理查看最新內容。',
  'preview.manualRefresh': '預覽可用；即時更新暫不可用，請手動重新整理查看最新內容。',
  'preview.reconnectingManual': '正在重新連接即時預覽；可手動重新整理查看最新內容。',
  'preview.frameTitle': '工作區預覽',
  'preview.ready': '可用',
  'preview.waiting': '等待網頁',
  'preview.missing': '目錄不存在',
  'preview.disabled': '已停用',
  'preview.metadata': '{status} · {date}',
  'preview.teamMetadata': '{status} · Team {teamId} · {date}',
  'preview.open': '開啟',
  'preview.disable': '停用',
  'preview.enable': '啟用',
  'preview.rename': '改名',
  'preview.renamePrompt': '新的顯示名稱（網址不變）',
  'preview.remove': '移除',
  'preview.removeConfirm': '移除此預覽？工作目錄與檔案不會刪除。',
  'preview.notFound': '找不到這個預覽，或預覽已停用。',
  'preview.waitingForAgent': '等待 Agent 完成網頁…',
  'preview.connected': '即時預覽已連線，檔案修改後會自動更新。',
  'preview.disabledNotice': '此預覽已停用。',
  'preview.reconnecting': '正在重新連接即時預覽…',
  'chat.heading': '與 Aion 繼續協作',
  'chat.loading': '正在載入綁定對話…',
  'chat.older': '載入較早訊息',
  'chat.messageLabel': '訊息',
  'chat.messagePlaceholder': '請 Aion 修改這個網頁…',
  'chat.send': '傳送',
  'chat.you': '你',
  'chat.assistant': 'Aion',
  'chat.conversation': '對話：{name}（由 Aion 驗證個人或 Team 權限）',
  'chat.unavailable': '對話已無法存取，請重新整理確認登入與預覽狀態。',
  'chat.reconnecting': '正在重新連接 Aion 對話…',
  'chat.sent': '已交給 Aion；回覆與網頁修改將自動更新。',
  'catalog.enabled': '已啟用',
  'catalog.heading': '可用預覽',
  'catalog.searchLabel': '搜尋預覽',
  'catalog.searchPlaceholder': '名稱、路徑或 Team',
  'catalog.refresh': '重新整理',
  'catalog.refreshing': '正在掃描 HTML 並更新預覽…',
  'catalog.refreshed': '預覽清單已更新。',
  'catalog.renamed': '顯示名稱已更新；網址與檔案不變。',
  'catalog.truncated': '掃描已達上限，部分 HTML 尚未列出。',
  'catalog.empty': '目前沒有已啟用的預覽。',
};

export function t(key, values = {}) {
  const text = translations[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (placeholder, name) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);
}

export function translatePage(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const attribute of ['placeholder', 'title']) {
    for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
