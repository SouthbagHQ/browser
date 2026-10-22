const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { JsonFile } = require('../src/main/store');

const calls = [];
const bank = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  calls.push({ path: req.url, method: req.method, auth: req.headers.authorization, origin: req.headers.origin, body: body ? JSON.parse(body) : null });
  const json = (status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.headers.authorization === 'Bearer stale') return json(401, { error: 'Authentication required' });
  if (req.headers.authorization !== 'Bearer good') return json(401, { error: 'Authentication required' });
  if (req.url === '/api/account') return json(200, { user: { id: 'u' }, balance: 1000000, transactions: [] });
  if (req.url === '/api/chat') return json(200, { choices: [{ message: { content: 'Visit a branch.' } }] });
  if (req.url === '/api/economy') return json(200, { ok: true, text: 'Charged', balance: 999990 });
  return json(404, {});
});

let Banking;
let FeeMeter;
test.before(async () => {
  await new Promise((resolve) => bank.listen(0, '127.0.0.1', resolve));
  process.env.SOUTHBAG_BANKING_URL = `http://127.0.0.1:${bank.address().port}`;
  ({ Banking, FeeMeter } = require('../src/main/banking'));
});
test.after(() => bank.close());

test('uses the Identity access token as a bearer, refreshing once on 401', async () => {
  let token = 'stale';
  const banking = new Banking({ token: async () => token, refresh: async () => { token = 'good'; } });
  const account = await banking.account();
  assert.equal(account.balance, 1000000);
  assert.deepEqual(calls.slice(-2).map((c) => c.auth), ['Bearer stale', 'Bearer good']);
  assert.equal(calls.at(-1).origin, undefined);
  assert.equal(await banking.chat([{ role: 'user', content: 'hi' }]), 'Visit a branch.');
});

test('browsing fees: a cent a page, billed in one economy fee', async () => {
  const banking = new Banking({ token: async () => 'good' });
  const file = new JsonFile(fs.mkdtempSync(path.join(os.tmpdir(), 'fees-')), 'fees.json', { lifetimeCents: 0, chargedCents: 0, pendingCents: 0, pageLoads: 0 });
  let enabled = true;
  const meter = new FeeMeter({ banking, file, enabled: () => enabled });
  meter.pageLoaded();
  meter.pageLoaded();
  meter.pageLoaded();
  enabled = false;
  meter.pageLoaded();
  assert.equal(meter.state.pendingCents, 3);
  await meter.flush();
  meter.stop();
  const fee = calls.at(-1);
  assert.equal(fee.path, '/api/economy');
  assert.equal(fee.body.action, 'fee');
  assert.equal(fee.body.amount, 0.03);
  assert.doesNotMatch(fee.body.reason, /https?:/);
  assert.equal(meter.state.chargedCents, 3);
  assert.equal(meter.state.pendingCents, 0);
  assert.equal(meter.state.sessionCents, 3);
});

test('fees are kept locally when the bank is unreachable', async () => {
  const banking = new Banking({ token: async () => null });
  const file = new JsonFile(fs.mkdtempSync(path.join(os.tmpdir(), 'fees-')), 'fees.json', { lifetimeCents: 0, chargedCents: 0, pendingCents: 0, pageLoads: 0 });
  const meter = new FeeMeter({ banking, file, enabled: () => true });
  meter.pageLoaded();
  await meter.flush();
  meter.stop();
  assert.equal(meter.state.pendingCents, 1);
  assert.ok(meter.state.lastError);
});
