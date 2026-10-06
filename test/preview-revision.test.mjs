import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldReloadPreview } from '../public/preview-revision.js';

test('does not reload an unchanged preview revision after an SSE reconnect', () => {
  assert.equal(shouldReloadPreview('revision-a', 'revision-a', true), false);
});

test('reloads a preview when its revision changes or no page is loaded', () => {
  assert.equal(shouldReloadPreview('revision-b', 'revision-a', true), true);
  assert.equal(shouldReloadPreview('revision-a', undefined, false), true);
});
