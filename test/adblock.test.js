const test = require('node:test');
const assert = require('node:assert/strict');
const { AdBlocker, loadList } = require('../src/main/adblock');

test('blocks listed domains and their subdomains, never top-level pages', () => {
  const blocker = new AdBlocker();
  assert.ok(loadList().size > 100);
  assert.equal(blocker.shouldBlock({ url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', resourceType: 'script' }), true);
  assert.equal(blocker.shouldBlock({ url: 'https://www.google-analytics.com/analytics.js', resourceType: 'script' }), true);
  assert.equal(blocker.shouldBlock({ url: 'https://doubleclick.net/', resourceType: 'mainFrame' }), false);
  assert.equal(blocker.shouldBlock({ url: 'https://example.com/ads.js', resourceType: 'script' }), false);
  assert.equal(blocker.shouldBlock({ url: 'https://notdoubleclick.net/', resourceType: 'image' }), false);
  assert.equal(blocker.shouldBlock({ url: 'southbag://newtab/', resourceType: 'image' }), false);
  // Southbag's own analytics are, naturally, not on the list.
  assert.equal(blocker.shouldBlock({ url: 'https://palantir.southbag.cc/batch/', resourceType: 'xhr' }), false);
});
