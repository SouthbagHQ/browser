const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/main/store');

test('settings are validated, saved and reloaded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const store = new Store(dir);
  assert.equal(store.get('askDefaultBrowser'), true);
  store.set({ askDefaultBrowser: false, searchEngine: 'nonsense', adBlock: 'yes', evil: 1 });
  assert.equal(store.get('askDefaultBrowser'), false);
  assert.equal(store.get('searchEngine'), 'duckduckgo');
  assert.equal(store.get('adBlock'), true);
  assert.equal('evil' in store.settings.data, false);
  store.flush();
  store.settings.flush();
  // "Don't ask again" survives a restart.
  assert.equal(new Store(dir).get('askDefaultBrowser'), false);
});

test('search URLs come from the configured engine', () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'store-')));
  assert.equal(store.searchUrl('kevin & co'), 'https://duckduckgo.com/?q=kevin%20%26%20co');
  store.set({ searchEngine: 'google' });
  assert.equal(store.searchUrl('x'), 'https://www.google.com/search?q=x');
  store.set({ searchEngine: 'custom', customSearch: 'not a url' });
  assert.equal(store.get('customSearch'), '');
  store.set({ customSearch: 'https://search.example/?q=%s' });
  assert.equal(store.searchUrl('a b'), 'https://search.example/?q=a%20b');
});

test('history collapses repeat visits and keeps titles current', () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'store-')));
  store.addHistory('https://example.com/', '');
  store.addHistory('https://example.com/', 'Example');
  store.updateHistoryTitle('https://example.com/', 'Example Domain');
  assert.equal(store.history.data.length, 1);
  assert.equal(store.history.data[0].title, 'Example Domain');
});
