/**
 * Southbag Drive client.
 *
 * Drive's /api/* accepts a Southbag Identity access token as a Bearer token
 * (see the drive repo's bearer auth), which is what lets Southbag Browser on
 * Southbag OS send downloads straight to the customer's Drive instead of a
 * local disk the OS does not have. Token supply and refresh are injected with
 * the same shape Banking uses, so the session rules live in one place (auth).
 */

// Drive enforces its quota server-side; mirrored here only so an impossible
// download can be refused before a byte is fetched.
const QUOTA_BYTES = 100 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

const DRIVE_URL = process.env.SOUTHBAG_DRIVE_URL || 'https://drive.southbag.cc';

class DriveError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'DriveError';
    this.code = code;
    this.status = status ?? null;
  }
}

class Drive {
  /**
   * @param {object} options
   * @param {() => Promise<string|null>} options.token  fresh access token, or null when signed out
   * @param {() => Promise<void>} [options.refresh]    force a token refresh
   * @param {string} [options.baseUrl]
   */
  constructor({ token, refresh, baseUrl = DRIVE_URL }) {
    this.token = token;
    this.refresh = refresh;
    this.baseUrl = baseUrl;
  }

  /**
   * Uploads a file. Resolves with Drive's { id, name, size }.
   * @param {{ name: string, contentType?: string, body: Buffer }} file
   */
  async upload({ name, contentType, body }) {
    const attempt = async () => {
      const accessToken = await this.token();
      if (!accessToken) throw new DriveError('Not signed in to Southbag Identity.', 'unauthorized', 401);
      try {
        return await fetch(`${this.baseUrl}/api/upload`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/octet-stream',
            'content-length': String(body.length),
            'x-sb-filename': encodeURIComponent(name),
            'x-sb-content-type': (contentType || 'application/octet-stream').slice(0, 120),
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new DriveError(`Could not reach Southbag Drive: ${error.message}`, 'network');
      }
    };

    let response = await attempt();
    if (response.status === 401 && this.refresh) {
      // One refresh and one retry: the token may simply have aged out.
      try {
        await this.refresh();
      } catch {}
      response = await attempt();
    }

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {}

    if (response.status === 401 || response.status === 403) {
      throw new DriveError('Southbag Identity no longer accepts this session.', 'unauthorized', response.status);
    }
    if (response.status === 413 || data.error === 'storage_full') {
      throw new DriveError(
        data.message ||
          'Upload rejected. Southbag Drive™ provides exactly 71.1 floppy disks per account. Try deleting something.',
        'storage_full',
        response.status,
      );
    }
    if (response.status === 400 && data.error === 'empty_file') {
      throw new DriveError('Empty files cannot be uploaded.', 'empty_file', 400);
    }
    if (!response.ok) {
      throw new DriveError(
        data.message || data.error || `Upload failed (${response.status}).`,
        data.error || 'upload_failed',
        response.status,
      );
    }
    return data;
  }
}

module.exports = { Drive, DriveError, DRIVE_URL, QUOTA_BYTES };
