const test = require("node:test");
const assert = require("node:assert/strict");
const { appFromArgv } = require("../src/main/system");

test("--app= picks the app-mode URL out of argv", () => {
  assert.equal(
    appFromArgv(["electron", ".", "--app=https://banking.southbag.cc"]),
    "https://banking.southbag.cc",
  );
  assert.equal(
    appFromArgv(["southbag-browser", "--app=https://social.southbag.cc/home"]),
    "https://social.southbag.cc/home",
  );
  assert.equal(
    appFromArgv(["southbag-browser", "--app", "https://drive.southbag.cc"]),
    "https://drive.southbag.cc",
  );
});

test("--app= rejects non-web schemes and junk", () => {
  assert.equal(
    appFromArgv(["southbag-browser", "--app=javascript:alert(1)"]),
    null,
  );
  assert.equal(appFromArgv(["southbag-browser", "--app=ftp://x"]), null);
  assert.equal(appFromArgv(["southbag-browser", "--app=not-a-url"]), null);
  assert.equal(appFromArgv(["southbag-browser", "--app="]), null);
  assert.equal(
    appFromArgv(["southbag-browser", "--app", "--other-flag"]),
    null,
  );
});

test("no --app flag means no app window", () => {
  assert.equal(appFromArgv(["electron", "."]), null);
  assert.equal(appFromArgv(["southbag-browser", "https://example.com"]), null);
  assert.equal(
    appFromArgv(["southbag-browser", "--append=https://example.com"]),
    null,
  );
});
