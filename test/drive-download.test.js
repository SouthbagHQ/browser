const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refusalForSize, uploadFinishedDownload, discardTemp, tempPath } = require('../src/main/drive-download');
const { QUOTA_BYTES, DriveError } = require('../src/main/drive');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-drive-test-'));
}

test('only a download bigger than the whole quota is refused up front', () => {
  assert.equal(refusalForSize(0), null);
  assert.equal(refusalForSize(50), null);
  assert.equal(refusalForSize(QUOTA_BYTES), null);
  const refusal = refusalForSize(QUOTA_BYTES + 1);
  assert.equal(refusal.message, 'Too large for Southbag Drive');
  assert.match(refusal.detail, /71\.1 floppy disks/);
});

test('a finished download is uploaded, recorded, and the temp file removed', async () => {
  const dir = tmpdir();
  const savePath = path.join(dir, 'plan.pdf');
  fs.writeFileSync(savePath, 'pdf bytes');
  const uploads = [];
  const drive = {
    upload: async (file) => {
      uploads.push(file);
      return { id: 'f1', name: file.name, size: file.body.length };
    },
  };
  const record = { filename: 'plan.pdf', contentType: 'application/pdf', isPrivate: false };
  const changes = [];
  const ok = await uploadFinishedDownload({ drive, record, savePath, onChange: (r) => changes.push({ ...r }) });
  assert.equal(ok, true);
  assert.equal(record.state, 'completed');
  assert.deepEqual(record.driveFile, { id: 'f1', name: 'plan.pdf', size: 9 });
  assert.equal(record.error, null);
  assert.equal(record.savePath, null);
  assert.equal(fs.existsSync(savePath), false);
  assert.equal(uploads[0].body.toString(), 'pdf bytes');
  assert.equal(uploads[0].contentType, 'application/pdf');
  assert.equal(changes.length, 1);
});

test('an upload failure marks the record and still removes the temp file', async () => {
  const dir = tmpdir();
  const savePath = path.join(dir, 'big.iso');
  fs.writeFileSync(savePath, 'iso');
  const drive = {
    upload: async () => {
      throw new DriveError('Upload rejected. Southbag Drive™ provides exactly 71.1 floppy disks per account.', 'storage_full', 413);
    },
  };
  const record = { filename: 'big.iso', isPrivate: false };
  const ok = await uploadFinishedDownload({ drive, record, savePath });
  assert.equal(ok, false);
  assert.equal(record.state, 'failed');
  assert.match(record.error, /71\.1 floppy disks/);
  assert.equal(record.savePath, null);
  assert.equal(fs.existsSync(savePath), false);
});

test('discardTemp removes the file and clears the record path', async () => {
  const dir = tmpdir();
  const savePath = path.join(dir, 'part.bin');
  fs.writeFileSync(savePath, 'partial');
  const record = { savePath };
  discardTemp(savePath, record);
  assert.equal(record.savePath, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(savePath), false);
});

test('tempPath sanitises and dedupes filenames', () => {
  const dir = tmpdir();
  const first = tempPath(dir, 'a/b.txt');
  assert.equal(path.basename(first), 'a_b.txt');
  fs.writeFileSync(first, 'x');
  const second = tempPath(dir, 'a/b.txt');
  assert.equal(path.basename(second), 'a_b (1).txt');
});
