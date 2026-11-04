const test = require('node:test');
const assert = require('node:assert/strict');
const { OS_ENV, runningOnSouthbagOS } = require('../src/main/download-policy');

test('downloads are refused only under the Southbag OS mark', () => {
  assert.equal(runningOnSouthbagOS({}), false);
  assert.equal(runningOnSouthbagOS({ [OS_ENV]: '1' }), true);
  assert.equal(runningOnSouthbagOS({ [OS_ENV]: '' }), false);
});
