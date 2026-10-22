const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { palantir } = require('./palantir');
const { SouthbagAuth, ISSUER } = require('./auth');
const { Store, SEARCH_ENGINES } = require('./store');
const { AdBlocker } = require('./adblock');
const { Banking, FeeMeter, BANKING_URL } = require('./banking');
const { SecureGate, CertStore } = require('./secure');
const { BrowserShell, tabsByContents, NEW_TAB_URL } = require('./shell');
const kevin = require('./kevin');
const system = require('./system');
const { SOUTHBAG_BOOKMARKS, INTERNAL_PAGES, classify, inputToUrl, isSouthbagHost } = require('./urls');

const VERSION = app.getVersion();
const IS_MAC = process.platform === 'darwin';
const SESSION_CHECK_MS = 5 * 60 * 1000;
const REWARD_TICK_MS = 5_000;
const SECONDS_PER_POINT = 10;
const INTERNAL_DIR = path.join(__dirname, '../internal');
const LOGO = path.join(__dirname, '../renderer/logo.png');
const MARK = path.join(__dirname, '../renderer/mark.png');
const ICON = path.join(__dirname, '../renderer/icon.png');

const track = (event, properties) => palantir.capture(event, properties);

protocol.registerSchemesAsPrivileged([
  { scheme: 'southbag', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let auth;
let store;
let banking;
let fees;
let browsing;
/** 'unknown' until the saved session has been checked, then 'signed-in' | 'signed-out' | 'offline'. */
let authStatus = 'unknown';
let restoring;
let quitting = false;
let loginWindow = null;
let nagShown = false;
let promoDismissed = false;
let privateCount = 0;
let downloadId = 0;
let blockedSession = 0;
let blockedSinceReport = 0;
const shells = new Map();
const popups = new Set();
const downloads = [];
const pendingUrls = [];
const secure = new SecureGate();
const certs = new CertStore();
const adblock = new AdBlocker();
const permissionDecisions = new Map();

const PROMOS = [
  { text: 'Southbag Payday Loans: approved before you ask. 400% APR, per hour.', url: 'https://banking.southbag.cc/auth/onboard', cta: 'Borrow now' },
  { text: 'The Southbag Gift Shop: things Kevin did not want. Now 0% off.', url: 'https://banking.southbag.cc/auth/onboard', cta: 'Shop' },
  { text: 'Southbag Platinum: benefits include none. Upgrade today.', url: 'https://banking.southbag.cc/auth/onboard', cta: 'Upgrade' },
  { text: 'Southbag Crypto: prices mostly go down. Invest responsibly (you can’t).', url: 'https://banking.southbag.cc/auth/onboard', cta: 'Invest' },
];
const promo = PROMOS[Math.floor(Math.random() * PROMOS.length)];

// ---------------------------------------------------------------------------
// Single instance, default-browser launches (argv, open-url, open-file)
// ---------------------------------------------------------------------------

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  // Another Southbag Browser is running; it gets our URLs via 'second-instance'.
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    const urls = system.urlsFromArgv(argv, workingDirectory);
    track('browser_second_instance', { urls: urls.length });
    if (urls.length) openUrls(urls, 'second_instance');
    else if (app.isReady()) {
      const target = lastShell();
      if (target) focus(target.window);
      else createWindow();
    }
  });
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  openUrls([url], 'open_url');
});
app.on('open-file', (event, file) => {
  event.preventDefault();
  openUrls([require('node:url').pathToFileURL(file).toString()], 'open_file');
});

function focus(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function lastShell({ includePrivate = false } = {}) {
  const focused = BrowserWindow.getFocusedWindow();
  const byWindow = [...shells.values()].find((s) => s.window === focused);
  if (byWindow && (includePrivate || !byWindow.isPrivate)) return byWindow;
  return [...shells.values()].reverse().find((s) => includePrivate || !s.isPrivate) || null;
}

/** Links from other apps. They wait behind the login screen if nobody is logged in yet. */
function openUrls(urls, source) {
  const clean = urls.filter((url) => /^(https?|file):/i.test(url));
  if (!clean.length) return;
  track('browser_external_open', { source, count: clean.length });
  if (!app.isReady() || authStatus !== 'signed-in') {
    pendingUrls.push(...clean);
    for (const s of shells.values()) s.send('pending:urls', pendingUrls.length);
    return;
  }
  const target = lastShell();
  if (!target) {
    createWindow({ urls: clean });
    return;
  }
  for (const url of clean) target.addTab({ url, source: 'external' });
  focus(target.window);
}

// ---------------------------------------------------------------------------
// Login gate
// ---------------------------------------------------------------------------

function isSignedIn() {
  return authStatus === 'signed-in';
}

function authPayload() {
  return { status: authStatus, user: auth?.user ?? null, pending: pendingUrls.length };
}

function broadcastAuth() {
  for (const s of shells.values()) {
    s.send('auth:changed', authPayload());
    s.layout();
  }
}

function setSignedIn(user) {
  authStatus = 'signed-in';
  palantir.identify(user);
  broadcastAuth();
  const urls = pendingUrls.splice(0);
  const windows = [...shells.values()];
  windows.forEach((s, index) => {
    if (s.tabs.length) return;
    const forThis = index === windows.length - 1 ? urls.splice(0) : [];
    if (forThis.length) forThis.forEach((url) => s.addTab({ url, source: 'external' }));
    else s.addTab({ url: NEW_TAB_URL, source: 'auto' });
  });
  if (!windows.length) createWindow({ urls });
  maybeNag();
  queueStatus();
}

/** Logging out (or Identity saying no) closes every tab in every window, and every pop-up. */
async function setSignedOut(reason) {
  let closed = 0;
  for (const s of shells.values()) {
    closed += s.tabs.length;
    s.closeAllTabs('signed_out');
  }
  for (const popup of popups) if (!popup.isDestroyed()) popup.close();
  authStatus = 'signed-out';
  palantir.reset();
  banking?.clear();
  track('browser_signed_out', { reason, tabs_closed: closed });
  broadcastAuth();
  await forgetSouthbagCookies();
}

/** Drops the Identity cookie (and any other *.southbag.cc cookie) so SSO ends with the session. */
async function forgetSouthbagCookies() {
  const sessions = [browsing, ...[...shells.values()].filter((s) => s.isPrivate).map((s) => s.session)];
  for (const ses of sessions) {
    if (!ses) continue;
    try {
      const cookies = await ses.cookies.get({});
      await Promise.all(
        cookies
          .filter((cookie) => isSouthbagHost(cookie.domain.replace(/^\./, '')))
          .map((cookie) => {
            const host = cookie.domain.replace(/^\./, '');
            return ses.cookies.remove(`http${cookie.secure ? 's' : ''}://${host}${cookie.path || '/'}`, cookie.name).catch(() => {});
          }),
      );
    } catch {}
  }
}

async function restoreSession() {
  try {
    const user = await auth.restore();
    if (user) setSignedIn(user);
    else {
      authStatus = 'signed-out';
      broadcastAuth();
    }
  } catch (error) {
    authStatus = 'offline';
    palantir.error('session_restore', error);
    broadcastAuth();
  }
}

/**
 * The Identity login happens in a window on the browsing session, not the system browser:
 * this *is* the browser. Identity's session cookie therefore lands on .southbag.cc right here,
 * and every Southbag site opens already logged in.
 */
function openLoginWindow(url) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    if (url) loginWindow.loadURL(url);
    focus(loginWindow);
    return Promise.resolve();
  }
  const parent = BrowserWindow.getFocusedWindow() || lastShell({ includePrivate: true })?.window;
  loginWindow = new BrowserWindow({
    width: 560,
    height: 780,
    parent: parent && !IS_MAC ? parent : undefined,
    title: 'Log in with Southbag Identity',
    icon: ICON,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: { session: browsing, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const win = loginWindow;
  win.webContents.setWindowOpenHandler(({ url: next }) => {
    win.loadURL(next);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    if (loginWindow === win) loginWindow = null;
    if (!win.loginDone) auth.cancelLogin();
  });
  return win.loadURL(url).catch(() => {});
}

function closeLoginWindowSoon() {
  const win = loginWindow;
  if (!win) return;
  win.loginDone = true;
  setTimeout(() => {
    if (!win.isDestroyed()) win.close();
  }, 1800);
}

// ---------------------------------------------------------------------------
// Sessions: internal pages, ad blocking, downloads, permissions
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const INTERNAL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function internalResponse(request) {
  const url = new URL(request.url);
  const page = url.hostname;
  let file;
  if (url.pathname === '/' || url.pathname === '') {
    file = path.join(INTERNAL_DIR, INTERNAL_PAGES.includes(page) ? `${page}.html` : 'missing.html');
  } else if (url.pathname === '/logo.png') {
    file = LOGO;
  } else if (url.pathname === '/mark.png') {
    file = MARK;
  } else {
    const name = path.basename(url.pathname);
    file = path.join(INTERNAL_DIR, name);
  }
  if (!file.startsWith(INTERNAL_DIR) && file !== LOGO && file !== MARK) return new Response('Not found', { status: 404 });
  try {
    const body = fs.readFileSync(file);
    return new Response(body, {
      headers: {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'content-security-policy': INTERNAL_CSP,
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return new Response('This Southbag page has been deprecated.', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
}

function userAgentFor(ses) {
  // Some sites refuse anything that admits to being Electron. Southbag admits to being Southbag.
  return `${ses
    .getUserAgent()
    .replace(/\s*Electron\/\S+/i, '')
    .replace(/\s*southbag-browser\/\S+/i, '')} SouthbagBrowser/${VERSION}`;
}

const ALWAYS_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock']);
const ASKABLE = {
  media: 'use your camera and/or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices',
  'idle-detection': 'know when you are idle',
  'display-capture': 'see your screen',
  'window-management': 'manage windows on your displays',
  'storage-access': 'use its cookies on other sites',
  'top-level-storage-access': 'use its cookies on other sites',
};

function setupSession(ses, { isPrivate }) {
  ses.setUserAgent(userAgentFor(ses));
  ses.protocol.handle('southbag', internalResponse);

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (store.get('adBlock') && adblock.shouldBlock(details)) {
      blockedSession += 1;
      blockedSinceReport += 1;
      const tab = tabsByContents.get(details.webContentsId);
      if (tab) {
        tab.blocked += 1;
        tab.update();
      }
      queueStatus();
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  ses.on('will-download', (_event, item, contents) => trackDownload(item, contents, isPrivate));

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (ALWAYS_ALLOWED.has(permission)) return callback(true);
    if (!ASKABLE[permission]) return callback(false);
    let origin;
    try {
      origin = new URL(details.requestingUrl || contents.getURL()).origin;
    } catch {
      return callback(false);
    }
    const key = `${isPrivate ? 'p' : 'n'} ${origin} ${permission}`;
    if (permissionDecisions.has(key)) return callback(permissionDecisions.get(key));
    const owner = BrowserWindow.fromWebContents(contents) || tabsByContents.get(contents.id)?.win.window;
    dialog
      .showMessageBox(owner, {
        type: 'question',
        buttons: ['Allow', 'Block'],
        defaultId: 1,
        cancelId: 1,
        message: `${new URL(origin).host} wants to ${ASKABLE[permission]}`,
        detail: isSouthbagHost(new URL(origin).hostname)
          ? 'This is a Southbag site. Kevin recommends Allow.'
          : 'This site is Not Southbag (Unsafe). Kevin will be watching either way.',
      })
      .then(({ response }) => {
        const allowed = response === 0;
        permissionDecisions.set(key, allowed);
        track('browser_permission_prompt', { permission, allowed, southbag: isSouthbagHost(new URL(origin).hostname) });
        callback(allowed);
      })
      .catch(() => callback(false));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    if (ALWAYS_ALLOWED.has(permission)) return true;
    return permissionDecisions.get(`${isPrivate ? 'p' : 'n'} ${requestingOrigin} ${permission}`) === true;
  });
  return ses;
}

function privateSession() {
  privateCount += 1;
  return setupSession(session.fromPartition(`incognito-${privateCount}-${Date.now()}`), { isPrivate: true });
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function uniquePath(dir, filename) {
  const safe = (filename || 'download').replace(/[/\\]/g, '_');
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate); i += 1) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function downloadState(record) {
  const { item, ...rest } = record;
  return rest;
}

function trackDownload(item, contents, isPrivate) {
  const record = {
    id: ++downloadId,
    filename: item.getFilename(),
    totalBytes: item.getTotalBytes(),
    receivedBytes: 0,
    state: 'progressing',
    paused: false,
    startedAt: Date.now(),
    savePath: null,
    isPrivate,
    item,
  };
  if (!store.get('askDownloadLocation')) {
    const dir = app.getPath('downloads');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    item.setSavePath(uniquePath(dir, record.filename));
  }
  downloads.unshift(record);
  if (downloads.length > 200) downloads.length = 200;
  track('browser_download_started', { total_bytes: record.totalBytes || null, private: isPrivate });
  let last = 0;
  item.on('updated', (_event, state) => {
    record.state = state;
    record.receivedBytes = item.getReceivedBytes();
    record.totalBytes = item.getTotalBytes();
    record.paused = item.isPaused();
    record.savePath = item.getSavePath() || record.savePath;
    record.filename = path.basename(record.savePath || record.filename);
    if (Date.now() - last > 250) {
      last = Date.now();
      broadcastDownloads();
    }
  });
  item.once('done', (_event, state) => {
    record.state = state;
    record.receivedBytes = item.getReceivedBytes();
    record.savePath = item.getSavePath() || record.savePath;
    record.filename = path.basename(record.savePath || record.filename);
    record.finishedAt = Date.now();
    track('browser_download_finished', {
      state,
      bytes: record.receivedBytes,
      duration_ms: record.finishedAt - record.startedAt,
      private: isPrivate,
    });
    broadcastDownloads();
  });
  broadcastDownloads();
  const owner = tabsByContents.get(contents?.id)?.win;
  owner?.send('downloads:started', record.id);
}

function downloadsSummary() {
  const active = downloads.filter((d) => d.state === 'progressing');
  const total = active.reduce((sum, d) => sum + (d.totalBytes || 0), 0);
  const received = active.reduce((sum, d) => sum + d.receivedBytes, 0);
  const latest = downloads[0];
  return {
    active: active.length,
    percent: total ? Math.round((received / total) * 100) : null,
    latest: latest ? { id: latest.id, filename: latest.filename, state: latest.state } : null,
  };
}

function broadcastDownloads() {
  broadcastInternal('downloads', downloads.map(downloadState));
  queueStatus();
}

// ---------------------------------------------------------------------------
// Status bar: fees, ads blocked, rewards, downloads, promo
// ---------------------------------------------------------------------------

let statusQueued = false;
function statusPayload() {
  return {
    fees: fees?.state ?? null,
    blockedSession,
    adBlock: store.get('adBlock'),
    rewards: { points: store.rewards.data.points },
    downloads: downloadsSummary(),
    promo: promoDismissed ? null : promo,
  };
}

function queueStatus() {
  if (statusQueued) return;
  statusQueued = true;
  setTimeout(() => {
    statusQueued = false;
    const payload = statusPayload();
    for (const s of shells.values()) s.send('status:update', payload);
    broadcastInternal('status', payload);
  }, 200);
}

function broadcastInternal(name, payload) {
  for (const tab of tabsByContents.values()) {
    if (!tab.wc.isDestroyed() && tab.wc.getURL().startsWith('southbag://')) tab.wc.send('internal:event', name, payload);
  }
}

function tickRewards() {
  if (!isSignedIn()) return;
  const focused = BrowserWindow.getFocusedWindow();
  const s = [...shells.values()].find((candidate) => candidate.window === focused);
  const tab = s?.activeTab;
  if (!tab || tab.warning || tab.error || classify(tab.url) !== 'southbag') return;
  const rewards = store.rewards.data;
  rewards.secondsOnSouthbag += REWARD_TICK_MS / 1000;
  const points = Math.floor(rewards.secondsOnSouthbag / SECONDS_PER_POINT);
  if (points !== rewards.points) {
    rewards.points = points;
    queueStatus();
  }
  store.rewards.save();
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const ctx = {
  get store() {
    return store;
  },
  get fees() {
    return fees;
  },
  secure,
  certs,
  track,
  isSignedIn,
  bookmarks: { find: findBookmark },
  createWindow: (options) => createWindow(options),
  launchTerminal: (s) => launchTerminal(s),
  menuAction: (s, action, via) => menuAction(s, action, via),
  openExternalProtocol,
  trackPopup(child) {
    popups.add(child);
    child.on('closed', () => popups.delete(child));
    track('browser_popup_opened');
  },
};

function createWindow({ isPrivate = false, urls = [] } = {}) {
  const ses = isPrivate ? privateSession() : browsing;
  const s = new BrowserShell(ctx, { isPrivate, session: ses });
  shells.set(s.chrome.id, s);
  const win = s.window;
  const windowId = s.id;
  const openedAt = Date.now();
  track('browser_window_opened', { window_id: windowId, private: isPrivate, open_windows: shells.size });

  win.on('focus', () => track('browser_window_focused', { window_id: windowId }));
  win.on('blur', () => track('browser_window_blurred', { window_id: windowId }));
  win.on('maximize', () => track('browser_window_maximized', { window_id: windowId }));
  win.on('unmaximize', () => track('browser_window_unmaximized', { window_id: windowId }));
  win.on('minimize', () => track('browser_window_minimized', { window_id: windowId }));
  win.on('restore', () => track('browser_window_restored', { window_id: windowId }));
  win.on('enter-full-screen', () => track('browser_window_fullscreen', { window_id: windowId, fullscreen: true }));
  win.on('leave-full-screen', () => track('browser_window_fullscreen', { window_id: windowId, fullscreen: false }));
  const chromeId = s.chrome.id;
  win.on('closed', () => {
    track('browser_window_closed', {
      window_id: windowId,
      private: isPrivate,
      tabs: s.tabs.length,
      lifetime_ms: Date.now() - openedAt,
      open_windows: shells.size - 1,
    });
    s.destroy();
    shells.delete(chromeId);
    if (isPrivate) {
      // Incognito*: everything this window's session saw goes. (*Palantir keeps its copy.)
      secure.forget(ses);
      ses.clearStorageData().catch(() => {});
      ses.clearCache().catch(() => {});
      for (let i = downloads.length - 1; i >= 0; i -= 1) {
        if (downloads[i].isPrivate && downloads[i].state !== 'progressing') downloads.splice(i, 1);
      }
    }
  });
  s.chrome.on('render-process-gone', (_event, details) => {
    track('browser_chrome_crashed', { reason: details.reason, exit_code: details.exitCode });
  });
  if (isSignedIn()) {
    if (urls.length) urls.forEach((url) => s.addTab({ url, source: 'external' }));
    else s.addTab({ url: NEW_TAB_URL, source: 'auto' });
  } else if (urls.length) {
    pendingUrls.push(...urls);
  }
  s.chrome.on('did-finish-load', () => {
    s.send('auth:changed', authPayload());
    s.send('status:update', statusPayload());
    s.send('settings:changed', store.settings.data);
    s.update();
    s.layout();
  });
  return s;
}

function openExternalProtocol(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const scheme = parsed.protocol.replace(':', '');
  if (['javascript', 'vbscript', 'chrome', 'devtools', 'file'].includes(scheme)) return;
  const owner = BrowserWindow.getFocusedWindow();
  dialog
    .showMessageBox(owner, {
      type: 'question',
      buttons: ['Open', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Open a “${scheme}:” link in another application?`,
      detail: 'That application is Not Southbag. Kevin cannot see in there. Yet.',
    })
    .then(({ response }) => {
      track('browser_external_protocol', { opened: response === 0 });
      if (response === 0) shell.openExternal(parsed.toString());
    });
}

function openExternal(url, source) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol)) return;
    track('browser_link_opened', { source, protocol: parsed.protocol.replace(':', '') });
    // We are a browser: http(s) opens in a tab here; mailto goes to the mail app.
    if (parsed.protocol === 'mailto:') shell.openExternal(parsed.toString());
    else openUrls([parsed.toString()], source);
  } catch {}
}

async function launchTerminal(s) {
  const result = await system.launchTerminal();
  track('browser_terminal_launch', { ok: result.ok, reason: result.reason || null });
  if (!result.ok && s && !s.window.isDestroyed()) {
    const { response } = await dialog.showMessageBox(s.window, {
      type: 'info',
      buttons: ['Download Southbag Terminal', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      message: 'Southbag Terminal is not installed',
      detail: 'A Southbag Browser without Southbag Terminal is like a bank without fees. Unthinkable.',
    });
    if (response === 0) s.addTab({ url: system.TERMINAL_RELEASES });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

const sameUrl = (a, b) => String(a).replace(/\/$/, '') === String(b).replace(/\/$/, '');

function findBookmark(url) {
  return SOUTHBAG_BOOKMARKS.find((b) => sameUrl(b.url, url)) || store.bookmarks.data.find((b) => sameUrl(b.url, url)) || null;
}

function allBookmarks() {
  return { southbag: SOUTHBAG_BOOKMARKS, user: store.bookmarks.data };
}

function bookmarkById(id) {
  return SOUTHBAG_BOOKMARKS.find((b) => b.id === id) || store.bookmarks.data.find((b) => b.id === id) || null;
}

function broadcastBookmarks() {
  const payload = allBookmarks();
  for (const s of shells.values()) {
    s.send('bookmarks:changed', payload);
    s.update();
  }
  broadcastInternal('bookmarks', payload);
}

function addBookmark({ title, url, favicon }) {
  if (!/^(https?|file|southbag):/i.test(String(url || ''))) return { ok: false, error: 'That is not a URL Kevin recognises.' };
  if (findBookmark(url)) return { ok: true, existing: true };
  const bookmark = {
    id: `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: String(title || url).slice(0, 200),
    url: String(url),
    favicon: typeof favicon === 'string' && favicon.startsWith('data:image/') && favicon.length < 200_000 ? favicon : null,
    addedAt: Date.now(),
  };
  store.bookmarks.data.push(bookmark);
  store.bookmarks.save();
  track('browser_bookmark_added', { southbag: isSouthbagUrl(bookmark.url), total: store.bookmarks.data.length });
  broadcastBookmarks();
  return { ok: true, bookmark };
}

function removeBookmark(id) {
  if (SOUTHBAG_BOOKMARKS.some((b) => b.id === id)) {
    track('browser_bookmark_remove_refused');
    return { ok: false, error: 'Southbag bookmarks are a permanent feature of your workspace.' };
  }
  const list = store.bookmarks.data;
  const index = list.findIndex((b) => b.id === id);
  if (index === -1) return { ok: false, error: 'No such bookmark.' };
  list.splice(index, 1);
  store.bookmarks.save();
  track('browser_bookmark_removed', { total: list.length });
  broadcastBookmarks();
  return { ok: true };
}

function renameBookmark(id, title) {
  const bookmark = store.bookmarks.data.find((b) => b.id === id);
  if (!bookmark) return { ok: false };
  bookmark.title = String(title || bookmark.url).slice(0, 200);
  store.bookmarks.save();
  broadcastBookmarks();
  return { ok: true };
}

function isSouthbagUrl(url) {
  try {
    return isSouthbagHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function openBookmark(s, bookmark, disposition = 'current') {
  if (!bookmark) return;
  track('browser_bookmark_opened', { southbag: Boolean(bookmark.southbag), disposition });
  if (disposition === 'tab') s.addTab({ url: bookmark.url, activate: false, source: 'bookmark' });
  else if (disposition === 'window') createWindow({ urls: [bookmark.url] });
  else if (disposition === 'private') createWindow({ isPrivate: true, urls: [bookmark.url] });
  else if (s.activeTab) {
    s.activeTab.navigate(bookmark.url);
    s.activeTab.wc.focus();
  } else s.addTab({ url: bookmark.url, source: 'bookmark' });
}

function bookmarkMenu(s, id) {
  const bookmark = bookmarkById(id);
  if (!bookmark) return;
  const template = [
    { label: 'Open', click: () => openBookmark(s, bookmark) },
    { label: 'Open in New Tab', click: () => openBookmark(s, bookmark, 'tab') },
    { label: 'Open in New Window', click: () => openBookmark(s, bookmark, 'window') },
    { label: 'Open in Incognito* Window', click: () => openBookmark(s, bookmark, 'private') },
    { type: 'separator' },
    bookmark.southbag
      ? { label: 'Remove (not permitted by Southbag policy)', enabled: false }
      : { label: 'Remove', click: () => removeBookmark(bookmark.id) },
    { label: 'Bookmark Manager', click: () => s.addTab({ url: 'southbag://bookmarks/' }) },
  ];
  Menu.buildFromTemplate(template).popup({ window: s.window });
}

// ---------------------------------------------------------------------------
// Menus and shortcuts
// ---------------------------------------------------------------------------

/** Everything a menu item, shortcut or chrome button can ask for, in one place. */
function menuAction(s, action, via = 'menu') {
  track('browser_menu_action', { action, via });
  if (action === 'new-window') return createWindow();
  if (action === 'new-private-window') return createWindow({ isPrivate: true });
  if (action === 'logout') return requestLogout(s?.window);
  if (action === 'quit') return app.quit();
  if (action === 'default-browser') return system.setDefaultBrowser(app);
  if (!s) {
    if (action === 'new-tab' || action === 'reopen-tab') createWindow();
    return;
  }
  const tab = s.activeTab;
  const signedIn = isSignedIn();
  const chromeAction = () => {
    s.focusChrome();
    s.send('menu:action', action);
  };
  switch (action) {
    case 'new-tab':
      if (!signedIn) return;
      s.addTab({ url: NEW_TAB_URL, source: via });
      s.focusChrome();
      return s.send('menu:action', 'focus-omnibox');
    case 'close-tab':
      if (tab) s.closeTab(tab, via);
      else s.window.close();
      return;
    case 'close-window':
      return s.window.close();
    case 'reopen-tab':
      return signedIn && s.reopenClosed();
    case 'next-tab':
      return s.cycle(1);
    case 'prev-tab':
      return s.cycle(-1);
    case 'back':
      return tab?.wc.navigationHistory.canGoBack() && tab.wc.navigationHistory.goBack();
    case 'forward':
      return tab?.wc.navigationHistory.canGoForward() && tab.wc.navigationHistory.goForward();
    case 'reload':
      if (tab?.error || tab?.warning) return tab.error ? tab.retry() : undefined;
      return tab?.wc.reload();
    case 'hard-reload':
      return tab?.wc.reloadIgnoringCache();
    case 'stop':
      return tab?.wc.stop();
    case 'home':
      return tab?.navigate(NEW_TAB_URL);
    case 'zoom-in':
      return tab?.zoom(1);
    case 'zoom-out':
      return tab?.zoom(-1);
    case 'zoom-reset':
      return tab?.zoom(0);
    case 'print':
      return tab?.print();
    case 'history':
    case 'downloads':
    case 'bookmarks':
    case 'settings':
    case 'about':
      return signedIn && openInternalPage(s, action);
    case 'terminal':
      return launchTerminal(s);
    case 'bookmark-page':
      return chromeAction();
    case 'toggle-bookmarks-bar':
      setSettings({ showBookmarksBar: !store.get('showBookmarksBar') });
      return;
    case 'dark-mode':
      setSettings({ dark: !store.get('dark') });
      return;
    case 'devtools':
      return tab?.wc.toggleDevTools();
    case 'chrome-devtools':
      return s.chrome.toggleDevTools();
    case 'focus-omnibox':
    case 'find':
    case 'find-next':
    case 'find-previous':
    case 'kevin':
    case 'kevin-summarise':
    case 'privacy':
      return chromeAction();
    default: {
      const match = /^tab-(\d)$/.exec(action);
      if (match) s.selectIndex(Number(match[1]));
    }
  }
}

/** Opens a southbag:// page, reusing a tab that already shows it. */
function openInternalPage(s, page) {
  const url = `southbag://${page}/`;
  const existing = s.tabs.find((t) => t.url.startsWith(url));
  if (existing) return s.activate(existing, 'menu');
  const tab = s.activeTab;
  if (tab && tab.page === 'newtab') {
    tab.navigate(url);
    return;
  }
  s.addTab({ url, source: 'menu' });
}

function shellFor(win) {
  return [...shells.values()].find((s) => s.window === win) || null;
}

function sendMenu(action, win, event) {
  const s = shellFor(win) || shellFor(BrowserWindow.getFocusedWindow());
  menuAction(s, action, event?.triggeredByAccelerator ? 'shortcut' : 'menu');
}

function buildMenu() {
  const item = (label, action, accelerator, extra = {}) => ({
    label,
    accelerator,
    click: (_menuItem, win, event) => sendMenu(action, win, event),
    ...extra,
  });
  const M = (mac, linux) => (IS_MAC ? mac : linux);
  const template = [
    ...(IS_MAC
      ? [
          {
            label: 'Southbag Browser',
            submenu: [
              item('About Southbag Browser', 'about'),
              { type: 'separator' },
              item('Settings…', 'settings', 'Cmd+,'),
              item('Make Southbag Your Default Browser…', 'default-browser'),
              { type: 'separator' },
              item('Log Out of Southbag…', 'logout'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        item('New Tab', 'new-tab', 'CmdOrCtrl+T'),
        item('New Window', 'new-window', 'CmdOrCtrl+N'),
        item('New Incognito* Window', 'new-private-window', 'CmdOrCtrl+Shift+N'),
        item('Reopen Closed Tab', 'reopen-tab', 'CmdOrCtrl+Shift+T'),
        item('Open Location…', 'focus-omnibox', 'CmdOrCtrl+L'),
        { type: 'separator' },
        item('Close Tab', 'close-tab', 'CmdOrCtrl+W'),
        item('Close Window', 'close-window', 'CmdOrCtrl+Shift+W'),
        { type: 'separator' },
        item('Print to Branch…', 'print', 'CmdOrCtrl+P'),
        item('Open in Southbag Terminal', 'terminal'),
        ...(IS_MAC
          ? []
          : [
              { type: 'separator' },
              item('Settings', 'settings', 'Ctrl+,'),
              item('Log Out of Southbag…', 'logout'),
              item('Quit', 'quit', 'Ctrl+Q'),
            ]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Find…', 'find', 'CmdOrCtrl+F'),
        item('Find Next', 'find-next', 'CmdOrCtrl+G'),
        item('Find Previous', 'find-previous', 'CmdOrCtrl+Shift+G'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Reload', 'reload', 'CmdOrCtrl+R'),
        item('Force Reload', 'hard-reload', 'CmdOrCtrl+Shift+R'),
        { type: 'separator' },
        item('Zoom In', 'zoom-in', 'CmdOrCtrl+='),
        item('Zoom Out', 'zoom-out', 'CmdOrCtrl+-'),
        item('Actual Size', 'zoom-reset', 'CmdOrCtrl+0'),
        { type: 'separator' },
        item('Show Bookmarks Bar', 'toggle-bookmarks-bar', 'CmdOrCtrl+Shift+B', {
          type: 'checkbox',
          checked: store.get('showBookmarksBar'),
        }),
        item('Dark Mode', 'dark-mode', undefined, { type: 'checkbox', checked: store.get('dark') }),
        item('Kevin Sidebar', 'kevin', 'CmdOrCtrl+Shift+K'),
        item('Privacy', 'privacy'),
        { type: 'separator' },
        { role: 'togglefullscreen', accelerator: M('Ctrl+Cmd+F', 'F11') },
        item('Developer Tools', 'devtools', M('Alt+Cmd+I', 'Ctrl+Shift+I')),
        ...(app.isPackaged ? [] : [item('Chrome Developer Tools', 'chrome-devtools', M('Alt+Cmd+Shift+I', 'Ctrl+Alt+Shift+I'))]),
      ],
    },
    {
      label: 'History',
      submenu: [
        item('Back', 'back', M('Cmd+[', 'Alt+Left')),
        item('Forward', 'forward', M('Cmd+]', 'Alt+Right')),
        item('Home', 'home', M('Cmd+Shift+H', 'Alt+Home')),
        { type: 'separator' },
        item('Show All History', 'history', M('Cmd+Y', 'Ctrl+H')),
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        item('Bookmark This Page…', 'bookmark-page', 'CmdOrCtrl+D'),
        item('Bookmark Manager', 'bookmarks', M('Alt+Cmd+B', 'Ctrl+Shift+O')),
        { type: 'separator' },
        ...SOUTHBAG_BOOKMARKS.map((b) => ({
          label: b.title,
          click: (_m, win) => {
            const s = shellFor(win);
            if (s) openBookmark(s, b);
          },
        })),
      ],
    },
    {
      label: IS_MAC ? 'Window' : 'Tabs',
      submenu: [
        item('Next Tab', 'next-tab', M('Cmd+Shift+]', 'Ctrl+PageDown')),
        item('Previous Tab', 'prev-tab', M('Cmd+Shift+[', 'Ctrl+PageUp')),
        { type: 'separator' },
        ...Array.from({ length: 8 }, (_, i) => item(`Tab ${i + 1}`, `tab-${i + 1}`, `CmdOrCtrl+${i + 1}`)),
        item('Last Tab', 'tab-9', 'CmdOrCtrl+9'),
        { type: 'separator' },
        item('Downloads', 'downloads', M('Cmd+Shift+J', 'Ctrl+J')),
        ...(IS_MAC ? [{ type: 'separator' }, { role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] : []),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Southbag Support', click: () => openExternal('https://support.southbag.cc/ai', 'help_menu') },
        { label: 'Locate a Southbag Branch', click: () => openExternal('https://branch-locator.southbag.cc', 'help_menu') },
        ...(IS_MAC ? [] : [{ type: 'separator' }, item('About Southbag Browser', 'about')]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function appMenu(s) {
  const item = (label, action, extra = {}) => ({ label, click: () => menuAction(s, action, 'app_menu'), ...extra });
  const tab = s.activeTab;
  const zoom = tab ? Math.round(tab.wc.getZoomFactor() * 100) : 100;
  const template = [
    item('New Tab', 'new-tab'),
    item('New Window', 'new-window'),
    item('New Incognito* Window', 'new-private-window'),
    { type: 'separator' },
    item('History', 'history'),
    item('Downloads', 'downloads'),
    item('Bookmarks', 'bookmarks'),
    { type: 'separator' },
    item(`Zoom In (now ${zoom}%)`, 'zoom-in', { enabled: Boolean(tab) }),
    item('Zoom Out', 'zoom-out', { enabled: Boolean(tab) }),
    item('Actual Size', 'zoom-reset', { enabled: Boolean(tab) }),
    { type: 'separator' },
    item('Find…', 'find', { enabled: Boolean(tab) }),
    item('Print to Branch…', 'print', { enabled: Boolean(tab) }),
    item('Ask Kevin', 'kevin'),
    item('Open in Southbag Terminal', 'terminal'),
    { type: 'separator' },
    item('Settings', 'settings'),
    item('About Southbag Browser', 'about'),
    { type: 'separator' },
    item('Log Out of Southbag…', 'logout'),
    item('Quit', 'quit'),
  ];
  Menu.buildFromTemplate(template).popup({ window: s.window });
}

function tabMenu(s, tab) {
  const index = s.tabs.indexOf(tab);
  const template = [
    { label: 'New Tab to the Right', click: () => s.addTab({ url: NEW_TAB_URL, after: tab, source: 'tab_menu' }) },
    { type: 'separator' },
    { label: 'Reload', click: () => tab.wc.reload() },
    { label: 'Duplicate', click: () => s.addTab({ url: tab.wc.getURL() || tab.url, after: tab, source: 'duplicate' }) },
    { label: tab.wc.isAudioMuted() ? 'Unmute Tab' : 'Mute Tab', click: () => (tab.wc.setAudioMuted(!tab.wc.isAudioMuted()), tab.update()) },
    { type: 'separator' },
    { label: 'Close Tab', click: () => s.closeTab(tab, 'tab_menu') },
    { label: 'Close Other Tabs', enabled: s.tabs.length > 1, click: () => s.tabs.filter((t) => t !== tab).forEach((t) => s.closeTab(t, 'close_others')) },
    {
      label: 'Close Tabs to the Right',
      enabled: index < s.tabs.length - 1,
      click: () => s.tabs.slice(index + 1).forEach((t) => s.closeTab(t, 'close_right')),
    },
    { type: 'separator' },
    { label: 'Reopen Closed Tab', enabled: s.closed.length > 0, click: () => s.reopenClosed() },
  ];
  Menu.buildFromTemplate(template).popup({ window: s.window });
}

async function requestLogout(win) {
  if (authStatus !== 'signed-in') return false;
  const { response } = await dialog.showMessageBox(win || BrowserWindow.getFocusedWindow(), {
    type: 'warning',
    buttons: ['Log Out', 'Stay Logged In'],
    defaultId: 1,
    cancelId: 1,
    message: 'Log out of Southbag?',
    detail: 'Every tab in every Southbag Browser window will be closed, and you will be logged out of every Southbag site.',
  });
  const open = [...shells.values()].reduce((sum, s) => sum + s.tabs.length, 0);
  track('browser_logout_prompt', { confirmed: response === 0, open_tabs: open });
  if (response !== 0) return false;
  // Ask Identity to end the web session too, then forget it locally whatever it says.
  browsing
    .fetch(`${ISSUER}/api/auth/sign-out`, { method: 'POST', credentials: 'include', headers: { origin: ISSUER, 'content-type': 'application/json' }, body: '{}' })
    .catch(() => {});
  await fees.flush().catch(() => {});
  await auth.logout();
  await setSignedOut('user');
  return true;
}

// ---------------------------------------------------------------------------
// Default browser nag
// ---------------------------------------------------------------------------

function maybeNag() {
  if (nagShown || !store.get('askDefaultBrowser')) return;
  if (system.isDefaultBrowser(app)) return;
  nagShown = true;
  setTimeout(() => {
    const target = lastShell({ includePrivate: true });
    if (!target) return;
    target.send('default-browser:nag');
    track('browser_default_nag_shown');
  }, 1500);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function setSettings(patch) {
  const before = { ...store.settings.data };
  const next = store.set(patch);
  for (const key of Object.keys(patch || {})) {
    if (before[key] !== next[key]) track('browser_setting_changed', { setting: key, value: typeof next[key] === 'boolean' ? next[key] : 'changed' });
  }
  for (const s of shells.values()) s.send('settings:changed', next);
  broadcastInternal('settings', next);
  if (before.showBookmarksBar !== next.showBookmarksBar || before.dark !== next.dark) buildMenu();
  queueStatus();
  return next;
}

async function clearBrowsingData({ history = false, cookies = false, cache = false } = {}) {
  if (history) {
    store.history.data = [];
    store.history.save();
  }
  if (cookies) await browsing.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'websql', 'filesystem', 'shadercache'] });
  if (cache) await browsing.clearCache();
  track('browser_data_cleared', { history, cookies, cache });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function requireSignedIn() {
  if (authStatus !== 'signed-in') throw new Error('You must log in with your Southbag account first.');
}

function senderShell(event) {
  return shells.get(event.sender.id) || null;
}

/** Internal pages only: the sender must be one of our tabs, currently showing southbag://. */
function internalTab(event) {
  const tab = tabsByContents.get(event.sender.id);
  const url = event.senderFrame?.url || '';
  if (!tab || !url.startsWith('southbag://')) return null;
  return tab;
}

async function kevinChat(messages) {
  const clean = kevin.sanitiseMessages(messages);
  if (!clean.length) return { ok: false, content: kevin.offlineReply(), offline: true };
  try {
    const content = await banking.chat([{ role: 'system', content: kevin.SYSTEM_PROMPT }, ...clean]);
    return { ok: true, content };
  } catch (error) {
    track('browser_kevin_failed', { status: error.status ?? null });
    return { ok: false, content: kevin.offlineReply(), offline: true };
  }
}

async function kevinSummarise(s) {
  const tab = s?.activeTab;
  if (!tab || tab.warning || tab.error) return { ok: false, content: 'There is no page. That is the summary.' };
  let text = '';
  try {
    // An isolated world, so the page can't tamper with what we read.
    text = await tab.wc.executeJavaScriptInIsolatedWorld(1999, [
      { code: `(document.body ? document.body.innerText : '').slice(0, ${kevin.PAGE_TEXT_LIMIT * 2})` },
    ]);
  } catch {}
  const page = { title: tab.wc.getTitle(), text, southbag: classify(tab.url) === 'southbag' };
  track('browser_kevin_summarise', { southbag: page.southbag, characters: String(text || '').length });
  try {
    const content = await banking.chat(kevin.summaryMessages(page));
    return { ok: true, content };
  } catch {
    return { ok: true, content: kevin.offlineSummary(page), offline: true };
  }
}

function sanitiseCapture(name, properties) {
  if (typeof name !== 'string' || !/^[a-z0-9_$]{1,80}$/.test(name)) return null;
  const safe = {};
  for (const [key, value] of Object.entries(properties && typeof properties === 'object' ? properties : {})) {
    if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
    // Strings must look like names, never like URLs or text someone typed.
    else if (typeof value === 'string' && /^[a-z0-9_.-]{0,60}$/i.test(value)) safe[key] = value;
  }
  return { name: name.startsWith('browser_') ? name : `browser_${name}`, properties: safe };
}

function registerIpc() {
  ipcMain.handle('auth:state', async () => {
    await restoring;
    return authPayload();
  });
  ipcMain.handle('auth:login', async () => {
    try {
      const user = await auth.login();
      closeLoginWindowSoon();
      setSignedIn(user);
      return { ok: true, user };
    } catch (error) {
      closeLoginWindowSoon();
      return { ok: false, code: error.code || 'unknown', message: error.message };
    }
  });
  ipcMain.handle('auth:cancel', () => {
    auth.cancelLogin();
    if (loginWindow) {
      loginWindow.loginDone = true;
      loginWindow.close();
    }
  });
  ipcMain.handle('auth:logout', (event) => requestLogout(BrowserWindow.fromWebContents(event.sender)));

  ipcMain.on('tab:command', (event, name, ...args) => {
    const s = senderShell(event);
    if (!s || !isSignedIn()) return;
    const tab = typeof args[0] === 'number' ? s.tabById(args[0]) : s.activeTab;
    switch (name) {
      case 'new':
        s.addTab({ url: NEW_TAB_URL, source: args[0] || 'button' });
        return;
      case 'close':
        return tab && s.closeTab(tab, args[1] || 'close_button');
      case 'activate':
        return tab && s.activate(tab, args[1] || 'click');
      case 'move':
        return tab && s.moveTab(tab, Number(args[1]));
      case 'navigate': {
        const input = String(args[0] ?? '').trim();
        if (!input || !s.activeTab) return;
        const url = inputToUrl(input);
        if (url) track('browser_navigate_typed', { kind: classify(url) });
        else track('browser_search', { source: 'omnibox' });
        s.activeTab.navigate(url || store.searchUrl(input));
        s.activeTab.wc.focus();
        return;
      }
      case 'warning-accept':
        return tab?.acceptWarning();
      case 'warning-reject':
        return tab?.rejectWarning();
      case 'cert-proceed':
        return tab?.certProceed();
      case 'retry':
        return tab?.retry();
      case 'mute':
        if (tab) {
          tab.wc.setAudioMuted(!tab.wc.isAudioMuted());
          tab.update();
        }
        return;
      case 'focus-page':
        return s.activeTab?.wc.focus();
      default:
        return menuAction(s, name, 'button');
    }
  });
  ipcMain.on('tab:menu', (event, id) => {
    const s = senderShell(event);
    const tab = s?.tabById(id);
    if (tab) tabMenu(s, tab);
  });
  ipcMain.on('app:menu', (event) => {
    const s = senderShell(event);
    if (s) appMenu(s);
  });

  ipcMain.on('layout:content', (event, rect) => senderShell(event)?.setContentBounds(rect || {}));
  ipcMain.handle('layout:overlay', (event, open) => senderShell(event)?.setOverlay(Boolean(open)) ?? null);

  ipcMain.on('find:start', (event, text, options = {}) => {
    const tab = senderShell(event)?.activeTab;
    if (!tab || typeof text !== 'string' || !text) return;
    // Electron's findNext means "start a new find session": true first, false for follow-ups.
    tab.wc.findInPage(text, { forward: options.forward !== false, findNext: !options.findNext, matchCase: false });
    if (!options.findNext) track('browser_find_in_page');
  });
  ipcMain.on('find:stop', (event) => senderShell(event)?.activeTab?.wc.stopFindInPage('keepSelection'));

  ipcMain.handle('omnibox:suggest', (_event, text) => {
    const query = String(text || '').toLowerCase().trim();
    if (query.length < 1) return [];
    const seen = new Set();
    const results = [];
    const consider = (entry) => {
      if (results.length >= 8 || seen.has(entry.url)) return;
      const hay = `${entry.url} ${entry.title || ''}`.toLowerCase();
      if (!hay.includes(query)) return;
      seen.add(entry.url);
      results.push({ url: entry.url, title: entry.title || entry.url });
    };
    for (const b of [...SOUTHBAG_BOOKMARKS, ...store.bookmarks.data]) consider(b);
    for (let i = store.history.data.length - 1; i >= 0 && results.length < 8; i -= 1) consider(store.history.data[i]);
    return results;
  });

  ipcMain.handle('bookmarks:list', () => allBookmarks());
  ipcMain.handle('bookmarks:toggle-current', (event) => {
    const s = senderShell(event);
    const tab = s?.activeTab;
    if (!tab || !tab.url) return { ok: false };
    const existing = findBookmark(tab.url);
    if (existing?.southbag) return { ok: false, southbag: true, error: 'Southbag pages are bookmarked permanently, whether you like it or not.' };
    if (existing) return { ...removeBookmark(existing.id), removed: true };
    return addBookmark({ title: tab.wc.getTitle() || tab.url, url: tab.url, favicon: tab.favicon });
  });
  ipcMain.on('bookmarks:open', (event, id, disposition) => {
    const s = senderShell(event);
    if (s && isSignedIn()) openBookmark(s, bookmarkById(id), disposition);
  });
  ipcMain.on('bookmarks:menu', (event, id) => {
    const s = senderShell(event);
    if (s && isSignedIn()) bookmarkMenu(s, id);
  });

  ipcMain.handle('settings:get', () => store.settings.data);
  ipcMain.handle('settings:set', (_event, patch) => setSettings(patch));

  ipcMain.handle('kevin:chat', (_event, messages) => {
    requireSignedIn();
    track('browser_kevin_message', { messages: Array.isArray(messages) ? messages.length : 0 });
    return kevinChat(messages);
  });
  ipcMain.handle('kevin:summarise', (event) => {
    requireSignedIn();
    return kevinSummarise(senderShell(event));
  });

  ipcMain.handle('default-browser:respond', async (_event, answer, dontAskAgain) => {
    track('browser_default_nag_answered', { answer: answer === 'yes' ? 'yes' : 'no', dont_ask_again: Boolean(dontAskAgain) });
    if (dontAskAgain) setSettings({ askDefaultBrowser: false });
    if (answer === 'yes') return system.setDefaultBrowser(app);
    return { ok: true };
  });

  ipcMain.handle('status:get', () => statusPayload());
  ipcMain.on('promo:dismiss', () => {
    promoDismissed = true;
    track('browser_promo_dismissed');
    queueStatus();
  });
  ipcMain.on('app:open-external', (_event, url) => openExternal(url, 'chrome'));

  ipcMain.on('palantir:capture', (_event, name, properties) => {
    const clean = sanitiseCapture(name, properties);
    if (clean) track(clean.name, clean.properties);
  });
  ipcMain.on('internal:capture', (event, name, properties) => {
    if (!internalTab(event)) return;
    const clean = sanitiseCapture(name, properties);
    if (clean) track(clean.name, clean.properties);
  });

  const internal = {
    info: (tab) => ({
      user: auth.user,
      isPrivate: tab.win.isPrivate,
      version: VERSION,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      identity: ISSUER,
      banking: BANKING_URL,
      palantir: palantir.enabled,
      downloadsDir: app.getPath('downloads'),
      isDefault: system.isDefaultBrowser(app),
    }),
    account: async () => {
      try {
        const data = await banking.account();
        return { ok: true, balance: data.balance, transactions: (data.transactions || []).slice(0, 5), user: data.user };
      } catch (error) {
        return { ok: false, error: error.message, status: error.status ?? null };
      }
    },
    status: () => statusPayload(),
    'settings:get': () => store.settings.data,
    'settings:set': (_tab, patch) => setSettings(patch),
    engines: () => SEARCH_ENGINES,
    search: (tab, query) => {
      const text = String(query || '').trim();
      if (!text) return;
      track('browser_search', { source: tab.page || 'internal' });
      const url = inputToUrl(text);
      tab.navigate(url || store.searchUrl(text));
    },
    'history:list': () => [...store.history.data].reverse(),
    'history:remove': (_tab, visitedAt) => {
      store.history.data = store.history.data.filter((entry) => entry.visitedAt !== visitedAt);
      store.history.save();
      track('browser_history_item_removed');
      return { ok: true };
    },
    'history:clear': () => clearBrowsingData({ history: true }),
    'bookmarks:list': () => allBookmarks(),
    'bookmarks:add': (_tab, bookmark) => addBookmark(bookmark || {}),
    'bookmarks:remove': (_tab, id) => removeBookmark(id),
    'bookmarks:rename': (_tab, id, title) => renameBookmark(id, title),
    'downloads:list': () => downloads.map(downloadState),
    'downloads:open': (_tab, id) => {
      const record = downloads.find((d) => d.id === id);
      if (record?.savePath && record.state === 'completed') shell.openPath(record.savePath);
    },
    'downloads:show': (_tab, id) => {
      const record = downloads.find((d) => d.id === id);
      if (record?.savePath) shell.showItemInFolder(record.savePath);
    },
    'downloads:cancel': (_tab, id) => downloads.find((d) => d.id === id)?.item.cancel(),
    'downloads:pause': (_tab, id) => {
      const record = downloads.find((d) => d.id === id);
      if (!record || record.state !== 'progressing') return;
      if (record.item.isPaused()) record.item.resume();
      else record.item.pause();
    },
    'downloads:clear': () => {
      for (let i = downloads.length - 1; i >= 0; i -= 1) if (downloads[i].state !== 'progressing') downloads.splice(i, 1);
      broadcastDownloads();
    },
    'rewards:get': () => store.rewards.data,
    'rewards:redeem': () => {
      store.rewards.data.redemptions += 1;
      store.rewards.save();
      track('browser_rewards_redeemed', { points: store.rewards.data.points, redemptions: store.rewards.data.redemptions });
      return { ok: true, points: store.rewards.data.points, redemptions: store.rewards.data.redemptions };
    },
    'fees:get': () => fees.state,
    'promo:dismiss': () => {
      promoDismissed = true;
      track('browser_promo_dismissed');
      queueStatus();
    },
    'default:set': async () => {
      track('browser_default_browser_requested', { source: 'settings' });
      return system.setDefaultBrowser(app);
    },
    'terminal:launch': async () => {
      const result = await system.launchTerminal();
      track('browser_terminal_launch', { ok: result.ok, reason: result.reason || null, source: 'page' });
      return result;
    },
    'data:clear': (_tab, what) => clearBrowsingData(what || {}),
    logout: (tab) => requestLogout(tab.win.window),
    'open-page': (tab, page) => INTERNAL_PAGES.includes(page) && tab.navigate(`southbag://${page}/`),
  };
  ipcMain.handle('internal', async (event, method, ...args) => {
    const tab = internalTab(event);
    if (!tab) throw new Error('Not a Southbag page.');
    requireSignedIn();
    const fn = internal[method];
    if (!fn) throw new Error(`Unknown method ${method}`);
    return fn(tab, ...args);
  });
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

function watchSystem() {
  powerMonitor.on('suspend', () => track('browser_system_suspend'));
  powerMonitor.on('resume', () => track('browser_system_resume'));
  powerMonitor.on('lock-screen', () => track('browser_system_lock'));
  powerMonitor.on('unlock-screen', () => track('browser_system_unlock'));
  powerMonitor.on('on-ac', () => track('browser_power_source', { source: 'ac' }));
  powerMonitor.on('on-battery', () => track('browser_power_source', { source: 'battery' }));
  nativeTheme.on('updated', () => track('browser_system_theme_changed', { dark: nativeTheme.shouldUseDarkColors }));
  screen.on('display-added', () => track('browser_display_changed', { change: 'added' }));
  screen.on('display-removed', () => track('browser_display_changed', { change: 'removed' }));
  app.on('child-process-gone', (_event, details) => track('browser_child_process_gone', { type: details.type, reason: details.reason }));
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  app.on('certificate-error', (event, _contents, url, error, certificate, callback) => {
    if (certs.check(url, error, certificate)) {
      event.preventDefault();
      callback(true);
      return;
    }
    track('browser_certificate_error', { error: String(error).replace(/[^A-Z_]/g, '').slice(0, 60) });
    callback(false);
  });

  // While signed in, keep checking the account is still good. When Identity says no, the tabs go.
  setInterval(async () => {
    if (authStatus !== 'signed-in') return;
    const ok = await auth.ensureFresh();
    if (!ok) await setSignedOut('session_expired');
  }, SESSION_CHECK_MS).unref();

  setInterval(tickRewards, REWARD_TICK_MS).unref();
  setInterval(() => {
    if (!blockedSinceReport) return;
    track('browser_ads_blocked', { count: blockedSinceReport, session_total: blockedSession });
    blockedSinceReport = 0;
  }, 60_000).unref();
}

process.on('uncaughtException', (error) => {
  palantir.error('uncaught_exception', error);
  console.error(error);
});
process.on('unhandledRejection', (error) => {
  palantir.error('unhandled_rejection', error);
  console.error(error);
});

app.whenReady().then(() => {
  if (!primaryInstance) return;
  const dataDir = app.getPath('userData');
  palantir.configure({ dataDir, version: VERSION });
  palantir.setBase({ locale: app.getLocale(), packaged: app.isPackaged });
  track('browser_app_launched', {
    cold_start_ms: Math.round(process.uptime() * 1000),
    displays: screen.getAllDisplays().length,
    dark_mode: nativeTheme.shouldUseDarkColors,
    is_default_browser: system.isDefaultBrowser(app),
  });

  store = new Store(dataDir);
  browsing = setupSession(session.fromPartition('persist:southbag'), { isPrivate: false });
  app.userAgentFallback = userAgentFor(session.defaultSession);

  auth = new SouthbagAuth({ dataDir, safeStorage, openExternal: openLoginWindow, track });
  banking = new Banking({
    token: async () => {
      if (!isSignedIn()) return null;
      await auth.ensureFresh();
      return auth.session?.accessToken ?? null;
    },
    refresh: () => auth.refresh(),
  });
  fees = new FeeMeter({
    banking,
    file: store.fees,
    enabled: () => isSignedIn() && store.get('browsingFees'),
    onChange: queueStatus,
    track,
  });
  restoring = restoreSession();

  registerIpc();
  buildMenu();
  watchSystem();
  createWindow({ urls: system.urlsFromArgv(process.argv) });

  app.on('activate', () => {
    track('browser_app_activated');
    if (shells.size === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('before-quit', async (event) => {
  if (quitting || !primaryInstance) return;
  quitting = true;
  event.preventDefault();
  const open = [...shells.values()].reduce((sum, s) => sum + s.tabs.length, 0);
  track('browser_app_quit', { open_tabs: open, uptime_ms: Math.round(process.uptime() * 1000) });
  store?.flush();
  await Promise.race([
    Promise.all([palantir.flush(), fees?.flush()]),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ]);
  store?.flush();
  app.quit();
});
