import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locale, t } from '../public/i18n.js';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('every actual portal HTML and app translation key is defined', () => {
  const htmlKeys = [...html.matchAll(/\bdata-i18n(?:-[a-z]+)?="([^"]+)"/g)].map((match) => match[1]);
  // Include conditional keys and the status-to-key map, not only direct t() calls.
  const appKeys = [...app.matchAll(/(['"])([a-z][\w-]*(?:\.[\w-]+)+)\1/g)].map((match) => match[2]);
  assert.ok(htmlKeys.length > 0, 'HTML translation keys must be discovered');
  assert.ok(appKeys.length > 0, 'app translation keys must be discovered');
  for (const key of new Set([...htmlKeys, ...appKeys])) {
    const translated = t(key);
    assert.equal(typeof translated, 'string', key);
    assert.notEqual(translated, key, `Missing translation: ${key}`);
    assert.ok(translated.length > 0, `Empty translation: ${key}`);
  }
});

test('zh-TW translations preserve actual HTML fallback text, placeholders and titles', () => {
  assert.equal(locale, 'zh-TW');
  const textNodes = [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/g)];
  const textKeys = [...html.matchAll(/\bdata-i18n="([^"]+)"/g)];
  assert.equal(textNodes.length, textKeys.length, 'Every text fallback must be checked');
  for (const [, , key, fallback] of textNodes) assert.equal(t(key), fallback, key);

  let checkedAttributes = 0;
  for (const [tag] of html.matchAll(/<[a-z][^>]*>/g)) {
    for (const [, attribute, key] of tag.matchAll(/\bdata-i18n-(placeholder|title)="([^"]+)"/g)) {
      const fallback = tag.match(new RegExp(`(?:^|\\s)${attribute}="([^"]*)"`));
      assert.ok(fallback, `Missing ${attribute} fallback for ${key}`);
      assert.equal(t(key), fallback[1], key);
      checkedAttributes += 1;
    }
  }
  assert.equal(checkedAttributes, [...html.matchAll(/\bdata-i18n-(?:placeholder|title)="/g)].length);
  assert.ok(checkedAttributes > 0, 'Attribute fallbacks must be checked');
});

test('interpolation preserves untrusted values literally without replacement expansion or recursion', () => {
  const title = '<img src=x onerror=alert(1)> $& $$ $` $\' {path}';
  const path = 'owner/project/{title}';
  assert.equal(t('admin.candidate', { title, path }), `${title} — ${path}`);
  assert.equal(t('chat.conversation', { name: title }), `對話：${title}（由 Aion 驗證個人或 Team 權限）`);
  assert.equal(t('preview.teamMetadata', { status: '可用', teamId: 'team-1', date: '2026/10/5' }), '可用 · Team team-1 · 2026/10/5');
  assert.equal(t('request.failed', { status: 403 }), 'Request failed (403)');
});

test('missing keys and interpolation values retain explicit fallbacks', () => {
  assert.equal(t('missing.translation'), 'missing.translation');
  assert.equal(t('admin.candidate', { title: 'Project' }), 'Project — {path}');
  assert.equal(t('request.failed', Object.create({ status: 500 })), 'Request failed ({status})');
  assert.equal(t('request.failed', { status: 0 }), 'Request failed (0)');
});
