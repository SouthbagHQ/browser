const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Drive, DriveError, QUOTA_BYTES } = require('../src/main/drive');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// undici keeps sockets alive; close them or server.close never settles.
const close = (server) =>
  new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });

test('upload PUTs the body with the Drive headers and returns the stored file', async () => {
  let seen;
  const { server, url } = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        filename: req.headers['x-sb-filename'],
        contentType: req.headers['x-sb-content-type'],
        length: req.headers['content-length'],
        body: Buffer.concat(chunks).toString(),
      };
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'f1', name: 'plan.pdf', size: 5 }));
    });
  });
  try {
    const drive = new Drive({ token: async () => 'tok1', baseUrl: url });
    const stored = await drive.upload({ name: 'plan.pdf', contentType: 'application/pdf', body: Buffer.from('hello') });
    assert.deepEqual(stored, { id: 'f1', name: 'plan.pdf', size: 5 });
    assert.equal(seen.method, 'PUT');
    assert.equal(seen.url, '/api/upload');
    assert.equal(seen.auth, 'Bearer tok1');
    assert.equal(seen.filename, encodeURIComponent('plan.pdf'));
    assert.equal(seen.contentType, 'application/pdf');
    assert.equal(seen.length, '5');
    assert.equal(seen.body, 'hello');
  } finally {
    await close(server);
  }
});

test('a 401 triggers one refresh and one retry with the new token', async () => {
  const auths = [];
  const { server, url } = await serve((req, res) => {
    auths.push(req.headers.authorization);
    if (auths.length === 1) {
      res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'f2', name: 'a.txt', size: 1 }));
  });
  try {
    let token = 'old';
    let refreshed = 0;
    const drive = new Drive({
      token: async () => token,
      refresh: async () => { refreshed += 1; token = 'new'; },
      baseUrl: url,
    });
    const stored = await drive.upload({ name: 'a.txt', body: Buffer.from('x') });
    assert.equal(stored.id, 'f2');
    assert.equal(refreshed, 1);
    assert.deepEqual(auths, ['Bearer old', 'Bearer new']);
  } finally {
    await close(server);
  }
});

test('a persistent 401 fails as unauthorized', async () => {
  const { server, url } = await serve((_req, res) => res.writeHead(401).end(JSON.stringify({ error: 'unauthorized' })));
  try {
    const drive = new Drive({ token: async () => 'tok', refresh: async () => {}, baseUrl: url });
    await assert.rejects(drive.upload({ name: 'a.txt', body: Buffer.from('x') }), (error) => {
      assert.equal(error.name, 'DriveError');
      assert.equal(error.code, 'unauthorized');
      return true;
    });
  } finally {
    await close(server);
  }
});

test("a full Drive keeps Drive's own answer", async () => {
  const message = 'Upload rejected. Southbag Drive™ provides exactly 71.1 floppy disks per account. Try deleting something.';
  const { server, url } = await serve((_req, res) =>
    res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'storage_full', message })),
  );
  try {
    const drive = new Drive({ token: async () => 'tok', baseUrl: url });
    await assert.rejects(drive.upload({ name: 'big.iso', body: Buffer.from('x') }), (error) => {
      assert.equal(error.code, 'storage_full');
      assert.equal(error.message, message);
      return true;
    });
  } finally {
    await close(server);
  }
});

test('empty files are rejected with their own code', async () => {
  const { server, url } = await serve((_req, res) =>
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'empty_file' })),
  );
  try {
    const drive = new Drive({ token: async () => 'tok', baseUrl: url });
    await assert.rejects(drive.upload({ name: 'a.txt', body: Buffer.from('x') }), (error) => {
      assert.equal(error.code, 'empty_file');
      return true;
    });
  } finally {
    await close(server);
  }
});

test('an unreachable Drive is a network error, not an auth error', async () => {
  const drive = new Drive({ token: async () => 'tok', baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(drive.upload({ name: 'a.txt', body: Buffer.from('x') }), (error) => {
    assert.equal(error.code, 'network');
    return true;
  });
});

test('no session means no upload is even attempted', async () => {
  let hit = false;
  const { server, url } = await serve((_req, res) => {
    hit = true;
    res.writeHead(500).end();
  });
  try {
    const drive = new Drive({ token: async () => null, baseUrl: url });
    await assert.rejects(drive.upload({ name: 'a.txt', body: Buffer.from('x') }), (error) => {
      assert.equal(error.code, 'unauthorized');
      return true;
    });
    assert.equal(hit, false);
  } finally {
    await close(server);
  }
});

test("the quota mirror matches Drive's 100MB", () => {
  assert.equal(QUOTA_BYTES, 100 * 1024 * 1024);
});

test('DriveError carries its status', () => {
  const error = new DriveError('nope', 'upload_failed', 502);
  assert.equal(error.status, 502);
  assert.equal(error.code, 'upload_failed');
});
