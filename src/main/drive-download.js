/**
 * Drive-first downloads on Southbag OS.
 *
 * The OS gives the customer no local file storage (see download-policy.js), so
 * a download is only a way station: the bytes land in a temp file, are handed
 * to Southbag Drive, and the temp file is removed. This module holds the two
 * decisions in that journey that are worth testing on their own - whether a
 * download can ever fit, and what happens to the record once the temp file is
 * on disk.
 */

const fs = require('node:fs');
const path = require('node:path');
const { QUOTA_BYTES } = require('./drive');

/** A download bigger than the whole quota can never fit: refuse up front. */
function refusalForSize(totalBytes, quotaBytes = QUOTA_BYTES) {
  if (totalBytes && totalBytes > quotaBytes) {
    return {
      message: 'Too large for Southbag Drive',
      detail: `This file is ${Math.ceil(totalBytes / 1024 / 1024)}MB and Southbag Drive gives you 71.1 floppy disks (100MB) in total. It was not downloaded.`,
    };
  }
  return null;
}

/**
 * Uploads a finished temp download to Drive and reflects the outcome on the
 * download record. The temp file is removed whether the upload works or not;
 * on Southbag OS there is deliberately no local copy to fall back to.
 *
 * @param {object} options
 * @param {import('./drive').Drive} options.drive
 * @param {object} options.record  the downloads-list record, mutated
 * @param {string} options.savePath  the temp file holding the download
 * @param {(record: object) => void} [options.onChange]  called after each mutation
 * @param {(event: string, props?: object) => void} [options.track]
 * @returns {Promise<boolean>} whether the file is now in Drive
 */
async function uploadFinishedDownload({ drive, record, savePath, onChange = () => {}, track = () => {} }) {
  const started = Date.now();
  try {
    const body = await fs.promises.readFile(savePath);
    const stored = await drive.upload({
      name: record.filename,
      contentType: record.contentType,
      body,
    });
    record.state = 'completed';
    record.driveFile = { id: stored.id, name: stored.name, size: stored.size };
    record.error = null;
    track('browser_download_drive_uploaded', {
      bytes: stored.size,
      duration_ms: Date.now() - started,
      private: record.isPrivate,
    });
    return true;
  } catch (error) {
    record.state = 'failed';
    record.error = error.message || 'Upload to Southbag Drive failed.';
    track('browser_download_drive_failed', {
      reason: error.code || 'unknown',
      status: error.status ?? null,
      private: record.isPrivate,
    });
    return false;
  } finally {
    await fs.promises.rm(savePath, { force: true }).catch(() => {});
    record.savePath = null; // the temp file is gone; the file lives in Drive or nowhere
    onChange(record);
  }
}

/** Best-effort temp cleanup for downloads that never reached the upload. */
function discardTemp(savePath, record) {
  if (savePath) fs.promises.rm(savePath, { force: true }).catch(() => {});
  if (record) record.savePath = null;
}

function tempPath(tempDir, filename) {
  const safe = (filename || 'download').replace(/[/\\]/g, '_');
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(tempDir, safe);
  for (let i = 1; fs.existsSync(candidate); i += 1) candidate = path.join(tempDir, `${base} (${i})${ext}`);
  return candidate;
}

module.exports = { refusalForSize, uploadFinishedDownload, discardTemp, tempPath };
