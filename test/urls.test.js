const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, siteOf, inputToUrl, displayUrl, isSouthbagHost, SOUTHBAG_BOOKMARKS } = require('../src/main/urls');

test('Southbag Secure classification', () => {
  assert.equal(classify('https://banking.southbag.cc/real.html'), 'southbag');
  assert.equal(classify('https://southbag.cc/'), 'southbag');
  assert.equal(classify('https://evil-southbag.cc/'), 'web');
  assert.equal(classify('https://southbag.cc.evil.com/'), 'web');
  assert.equal(classify('http://example.com/'), 'web');
  assert.equal(classify('southbag://newtab/'), 'internal');
  assert.equal(classify('about:blank'), 'internal');
  assert.equal(classify('file:///tmp/a.html'), 'file');
  assert.equal(classify('data:text/html,hi'), 'other');
  assert.equal(isSouthbagHost('SOCIAL.SOUTHBAG.CC.'), true);
});

test('a site is roughly the registrable domain', () => {
  assert.equal(siteOf('https://www.example.com/a'), 'example.com');
  assert.equal(siteOf('https://docs.example.com/'), 'example.com');
  assert.equal(siteOf('https://news.bbc.co.uk/'), 'bbc.co.uk');
  assert.equal(siteOf('https://abc.net.au/news'), 'abc.net.au');
  assert.equal(siteOf('http://127.0.0.1:8080/'), '127.0.0.1');
  assert.equal(siteOf('http://localhost:3000/'), 'localhost');
  assert.equal(siteOf('https://someone.github.io/x'), 'someone.github.io');
});

test('omnibox input becomes a URL or a search', () => {
  assert.equal(inputToUrl('example.com'), 'https://example.com');
  assert.equal(inputToUrl('example.com/path?q=1'), 'https://example.com/path?q=1');
  assert.equal(inputToUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(inputToUrl('192.168.1.1'), 'http://192.168.1.1');
  assert.equal(inputToUrl('https://example.com'), 'https://example.com');
  assert.equal(inputToUrl('southbag://settings'), 'southbag://settings/');
  assert.equal(inputToUrl('southbag:history'), 'southbag://history/');
  assert.equal(inputToUrl('how do i close a bank account'), null);
  assert.equal(inputToUrl('kevin'), null);
  assert.equal(inputToUrl('node.js'), 'https://node.js');
  assert.equal(inputToUrl('javascript:alert(1)'), null);
  assert.equal(inputToUrl(''), null);
});

test('the new tab page shows an empty address bar', () => {
  assert.equal(displayUrl('southbag://newtab/'), '');
  assert.equal(displayUrl('southbag://settings/'), 'southbag://settings');
  assert.equal(displayUrl('https://example.com/'), 'https://example.com/');
});

test('every Southbag bookmark is on southbag.cc and marked permanent', () => {
  const titles = SOUTHBAG_BOOKMARKS.map((b) => b.title);
  for (const name of ['Banking', 'Drive', 'Office', 'Git', 'Social', 'Support', 'Lore', 'Docs', 'Branch Locator']) {
    assert.ok(titles.includes(name), name);
  }
  for (const bookmark of SOUTHBAG_BOOKMARKS) {
    assert.equal(classify(bookmark.url), 'southbag', bookmark.url);
    assert.equal(bookmark.southbag, true);
  }
});
