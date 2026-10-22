const test = require('node:test');
const assert = require('node:assert/strict');
const { SecureGate, CertStore } = require('../src/main/secure');

test('the open-web warning appears once per site per session', () => {
  const gate = new SecureGate();
  const normal = {};
  const incognito = {};
  assert.equal(gate.needsWarning(normal, 'https://www.example.com/'), true);
  gate.accept(normal, 'https://www.example.com/');
  assert.equal(gate.needsWarning(normal, 'https://docs.example.com/other'), false);
  assert.equal(gate.needsWarning(normal, 'https://example.org/'), true);
  // A different session (an Incognito* window) starts over.
  assert.equal(gate.needsWarning(incognito, 'https://example.com/'), true);
  // Southbag, internal pages and files never warn.
  assert.equal(gate.needsWarning(normal, 'https://banking.southbag.cc/'), false);
  assert.equal(gate.needsWarning(normal, 'southbag://newtab/'), false);
  assert.equal(gate.needsWarning(normal, 'file:///tmp/x.html'), false);
  gate.forget(normal);
  assert.equal(gate.needsWarning(normal, 'https://example.com/'), true);
});

test('certificate exceptions are per host and per certificate', () => {
  const certs = new CertStore();
  const bad = { fingerprint: 'sha256/AAA', subjectName: 'self-signed', issuerName: 'self-signed' };
  assert.equal(certs.check('https://self-signed.badssl.com/', 'net::ERR_CERT_AUTHORITY_INVALID', bad), false);
  assert.equal(certs.lastError('https://self-signed.badssl.com/x').fingerprint, 'sha256/AAA');
  assert.equal(certs.allow('https://other.example/'), false);
  assert.equal(certs.allow('https://self-signed.badssl.com/'), true);
  assert.equal(certs.check('https://self-signed.badssl.com/', 'x', bad), true);
  assert.equal(certs.hasException('self-signed.badssl.com'), true);
  // A different certificate on the same host is not trusted.
  assert.equal(certs.check('https://self-signed.badssl.com/', 'x', { fingerprint: 'sha256/BBB' }), false);
});
