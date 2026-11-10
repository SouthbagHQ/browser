const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/main/main.js'), 'utf8');
const start = source.indexOf("  ses.on('will-download',");
const end = source.indexOf('\n  ses.setPermissionRequestHandler', start);
const handler = source.slice(start, end);
function run(contents) {
  let listener;
  const calls = { drive: 0, local: 0 };
  const ses = { on: (_name, cb) => { listener = cb; } };
  new Function('ses', 'runningOnSouthbagOS', 'trackDriveDownload', 'trackDownload', 'isPrivate', handler)(
    ses,
    () => calls.os,
    () => { calls.drive += 1; },
    () => { calls.local += 1; },
    false,
  );
  calls.os = true;
  listener({}, {}, contents);
  calls.os = false;
  listener({}, {}, contents);
  return calls;
}
test('OS downloads go to the Drive-first tracker, never the local manager', () => {
  const calls = run(null);
  assert.equal(calls.drive, 1);
  assert.equal(calls.local, 1); // the standalone leg
});
test('OS contents download also goes Drive-first', () => {
  const calls = run({ id: 123 });
  assert.equal(calls.drive, 1);
});
