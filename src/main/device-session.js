/** A scoped handoff from the OS login, never a renderer-provided identity. */
const fs = require('node:fs');
const path = require('node:path');

function readDeviceSession({ dataDir, generation, now = Date.now() }) {
  if (!generation) throw new Error('The OS session generation is missing.');
  const root = path.dirname(dataDir);
  const privateRead = (name) => {
    const file = path.join(root, name);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 65536) {
        throw new Error('The OS session handoff is not private.');
      }
      return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  };
  // Both files are inside the private, generation-scoped device-session root.
  if (privateRead('generation').trim() !== generation) throw new Error('The OS session was retired.');
  const session = JSON.parse(privateRead('browser-handoff.json'));
  if (session.generation !== generation || typeof session.subject !== 'string' || !session.subject ||
      typeof session.accessToken !== 'string' || !/^[A-Za-z0-9._~-]{20,}$/.test(session.accessToken) ||
      !Number.isFinite(session.expiresAt) || session.expiresAt <= now || session.expiresAt > now + 86400000) {
    throw new Error('The OS session handoff is expired or invalid.');
  }
  if (!Array.isArray(session.cookies) || !session.cookies.length || session.cookies.length > 2) throw new Error('The OS Identity cookie is missing.');
  const cookies = [];
  for (const cookie of session.cookies || []) {
    // Only Identity's secure HttpOnly session cookie can cross runtimes.
    // No arbitrary host, URL, service cookie, or renderer-controlled object.
    if (!['southbag.cc', '.southbag.cc', 'identity.southbag.cc'].includes(cookie.domain) ||
        !['__Secure-better-auth.session_token', 'better-auth.session_token'].includes(cookie.name) ||
        cookie.path !== '/' || cookie.secure !== true || cookie.httpOnly !== true ||
        typeof cookie.value !== 'string' || !cookie.value || cookie.value.length > 8192) {
      throw new Error('The OS Identity cookie handoff is invalid.');
    }
    const item = { url: 'https://identity.southbag.cc/', name: cookie.name, value: cookie.value,
      domain: cookie.domain, path: '/', secure: true, httpOnly: true, sameSite: 'lax' };
    if (Number.isFinite(cookie.expirationDate) && cookie.expirationDate > now / 1000) item.expirationDate = cookie.expirationDate;
    cookies.push(item);
  }
  return { ...session, cookies };
}

async function adoptDeviceSession({ auth, browsing, dataDir, generation }) {
  const candidate = readDeviceSession({ dataDir, generation });
  // Userinfo is the live authority. Never trust the local subject on its own.
  auth.session = { accessToken: candidate.accessToken, expiresAt: candidate.expiresAt,
    deviceGeneration: generation, refreshToken: null, clientId: null };
  try {
    const user = await auth.fetchUser();
    if (user.sub !== candidate.subject) throw new Error('The OS account changed during sign-in.');
    // Recheck the era after network I/O, before publishing any cookies or user.
    const current = readDeviceSession({ dataDir, generation });
    if (current.accessToken !== candidate.accessToken || current.subject !== candidate.subject) throw new Error('The OS account changed during sign-in.');
    for (const cookie of candidate.cookies) await browsing.cookies.set(cookie);
    await browsing.cookies.flushStore();
    auth.session.user = user;
    return user;
  } catch (error) {
    auth.session = null;
    // A partial cookie import must not leave an apparently signed-in service.
    for (const cookie of candidate.cookies) {
      try { await browsing.cookies.remove(cookie.url, cookie.name); } catch {}
    }
    throw error;
  }
}
module.exports = { readDeviceSession, adoptDeviceSession };
