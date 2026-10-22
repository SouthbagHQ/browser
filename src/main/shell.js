/**
 * One browser window: the chrome (a BrowserWindow running src/renderer) and its tabs, each a
 * sandboxed WebContentsView laid over the chrome's content area. The main process owns the
 * tab list; the chrome renderer only draws it and sends commands.
 *
 * Web pages are never restyled. When the chrome needs to draw over the content area (dialogs,
 * popovers, the open-web warning), the page's view is hidden and the chrome shows a plain
 * screenshot of it underneath instead.
 */

const { BrowserWindow, WebContentsView, Menu, clipboard, screen } = require('electron');
const path = require('node:path');
const { classify, siteOf, displayUrl, isInternalPage } = require('./urls');

const IS_MAC = process.platform === 'darwin';
const NEW_TAB_URL = 'southbag://newtab/';
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const CLOSED_TAB_LIMIT = 25;
const FAVICON_MAX_BYTES = 256 * 1024;
const ERROR_TITLES = { cert: 'Privacy error', network: 'Can’t reach this page', crash: 'Aw, Southbag' };

let nextTabId = 0;
let nextWindowId = 0;
/** webContents id → Tab, across every window. Used by the ad blocker and internal-page IPC. */
const tabsByContents = new Map();

function isCertError(code, description) {
  return (code <= -200 && code > -300) || /^ERR_(CERT|SSL)_/.test(description || '');
}

class Tab {
  constructor(win, { url, webContents, opener } = {}) {
    this.win = win;
    this.ctx = win.ctx;
    this.id = ++nextTabId;
    this.openedAt = Date.now();
    this.title = '';
    this.url = '';
    this.favicon = null;
    this.loading = false;
    this.warning = null;
    this.error = null;
    this.blocked = 0;
    this.audible = false;
    this.htmlFullscreen = false;
    this.navigations = 0;
    this.openerTab = opener || null;

    const webPreferences = {
      session: win.session,
      preload: path.join(__dirname, 'tab-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      spellcheck: true,
      safeDialogs: true,
      safeDialogsMessage: 'Kevin has blocked further dialogs from this page',
      navigateOnDragDrop: false,
      autoplayPolicy: 'document-user-activation-required',
    };
    this.view = webContents ? new WebContentsView({ webContents }) : new WebContentsView({ webPreferences });
    this.view.setBackgroundColor('#ffffffff');
    this.view.setVisible(false);
    this.wc = this.view.webContents;
    tabsByContents.set(this.wc.id, this);
    this.wireEvents();
    if (url) this.navigate(url);
  }

  get security() {
    return classify(this.url);
  }

  get page() {
    return isInternalPage(this.url) ? new URL(this.url).hostname : null;
  }

  /** The new tab page, or about to be: the omnibox gets focus there, not the page. */
  get isNewTabPage() {
    return (this.url || this.pendingUrl || '').startsWith(NEW_TAB_URL);
  }

  state() {
    const url = this.warning ? this.warning.url : this.url;
    let host = null;
    try {
      host = new URL(url).hostname || null;
    } catch {}
    return {
      id: this.id,
      title: this.warning
        ? 'Not Southbag (Unsafe)'
        : this.error
          ? ERROR_TITLES[this.error.kind] || host || 'Error'
          : this.title || displayUrl(this.url) || 'New Tab',
      url,
      display: displayUrl(url),
      host,
      favicon: this.warning || this.error ? null : this.favicon,
      internal: classify(this.url) === 'internal',
      page: this.warning ? null : this.page,
      newTab: !this.warning && this.isNewTabPage,
      loading: this.loading,
      canGoBack: this.wc.navigationHistory.canGoBack(),
      canGoForward: this.wc.navigationHistory.canGoForward(),
      security: classify(url),
      certException: Boolean(host && this.ctx.certs.hasException(host)),
      warning: this.warning,
      error: this.error,
      zoom: Math.round(this.wc.getZoomFactor() * 100),
      blocked: this.warning ? 0 : this.blocked,
      audible: this.audible,
      muted: this.wc.isAudioMuted(),
      bookmarked: Boolean(url && this.ctx.bookmarks.find(url)),
      htmlFullscreen: this.htmlFullscreen,
    };
  }

  update() {
    this.win.update();
  }

  /** Every navigation we start goes through here, so the open-web warning can't be skipped. */
  navigate(url) {
    this.pendingUrl = url;
    this.error = null;
    if (this.ctx.secure.needsWarning(this.win.session, url)) {
      this.showWarning(url);
      return;
    }
    this.warning = null;
    this.wc.loadURL(url).catch(() => {});
    this.win.layout();
    this.update();
  }

  showWarning(url) {
    if (this.wc.isLoading()) this.wc.stop();
    this.warning = { url, site: siteOf(url) };
    this.loading = false;
    this.ctx.track('browser_unsafe_warning_shown', { private: this.win.isPrivate });
    this.win.layout();
    this.update();
  }

  acceptWarning() {
    if (!this.warning) return;
    const { url } = this.warning;
    this.ctx.secure.accept(this.win.session, url);
    this.ctx.track('browser_unsafe_warning_accepted', { private: this.win.isPrivate });
    this.warning = null;
    this.navigate(url);
  }

  rejectWarning() {
    if (!this.warning) return;
    this.warning = null;
    this.ctx.track('browser_unsafe_warning_rejected', { private: this.win.isPrivate });
    const current = this.wc.getURL();
    if (!current || current === 'about:blank') this.navigate(NEW_TAB_URL);
    this.win.layout();
    this.update();
  }

  certProceed() {
    if (!this.error || this.error.kind !== 'cert') return;
    const { url } = this.error;
    if (!this.ctx.certs.allow(url)) return;
    this.ctx.track('browser_cert_exception_added');
    this.error = null;
    this.wc.loadURL(url).catch(() => {});
    this.win.layout();
    this.update();
  }

  retry() {
    const url = this.error?.url || this.wc.getURL();
    this.error = null;
    if (url) this.navigate(url);
  }

  wireEvents() {
    const wc = this.wc;
    const fromInternal = () => classify(wc.getURL()) === 'internal';

    const gate = (event, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (url.startsWith('southbag:') && !fromInternal()) {
        // Web pages don't get to open (or script) Southbag's internal pages.
        event.preventDefault();
        return;
      }
      if (this.ctx.secure.needsWarning(this.win.session, url)) {
        event.preventDefault();
        this.showWarning(url);
      }
    };
    wc.on('will-navigate', (event, legacyUrl) => gate(event, event.url || legacyUrl, event.isMainFrame ?? true));
    wc.on('will-redirect', (event, legacyUrl, _inPlace, legacyMain) =>
      gate(event, event.url || legacyUrl, event.isMainFrame ?? legacyMain),
    );
    wc.on('did-start-navigation', (event, legacyUrl, isInPlace, legacyMain) => {
      const url = event.url || legacyUrl;
      const isMainFrame = event.isMainFrame ?? legacyMain;
      const sameDocument = event.isSameDocument ?? isInPlace;
      if (!isMainFrame || sameDocument) return;
      this.error = null;
      this.blocked = 0;
      // Anything that got past will-navigate (back/forward, pop-up tabs) is caught here.
      if (this.ctx.secure.needsWarning(this.win.session, url)) {
        wc.stop();
        this.showWarning(url);
      }
    });

    wc.on('did-start-loading', () => {
      this.loading = true;
      this.loadStartedAt = Date.now();
      this.update();
    });
    wc.on('did-stop-loading', () => {
      this.loading = false;
      this.update();
    });
    wc.on('did-navigate', (_event, url, httpResponseCode) => {
      const previousSite = siteOf(this.url);
      this.url = url;
      this.title = wc.getTitle() === url ? '' : wc.getTitle();
      this.warning = null;
      this.navigations += 1;
      if (siteOf(url) !== previousSite) this.favicon = null;
      const kind = classify(url);
      if (kind === 'web' || kind === 'southbag') {
        this.ctx.fees.pageLoaded();
        if (!this.win.isPrivate) this.ctx.store.addHistory(url, wc.getTitle());
      } else if (kind === 'file' && !this.win.isPrivate) {
        this.ctx.store.addHistory(url, wc.getTitle());
      }
      this.ctx.track('browser_page_loaded', {
        kind,
        internal_page: this.page,
        status_class: httpResponseCode ? Math.floor(httpResponseCode / 100) * 100 : null,
        load_ms: this.loadStartedAt ? Date.now() - this.loadStartedAt : null,
        private: this.win.isPrivate,
      });
      this.win.layout();
      this.update();
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.url = url;
      this.update();
    });
    wc.on('page-title-updated', (_event, title) => {
      this.title = title;
      const kind = classify(this.url);
      if (!this.win.isPrivate && (kind === 'web' || kind === 'southbag' || kind === 'file')) {
        this.ctx.store.updateHistoryTitle(this.url, title);
      }
      this.update();
    });
    wc.on('page-favicon-updated', (_event, favicons) => void this.loadFavicon(favicons));
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 is ERR_ABORTED: we (or the user) stopped it.
      this.url = url || this.url;
      this.error = isCertError(code, description)
        ? { kind: 'cert', url, code, description, details: this.ctx.certs.lastError(url) }
        : { kind: 'network', url, code, description };
      this.ctx.track('browser_page_failed', { kind: this.error.kind, code, private: this.win.isPrivate });
      this.loading = false;
      this.win.layout();
      this.update();
    });
    wc.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return;
      this.error = { kind: 'crash', url: this.url, description: details.reason };
      this.ctx.track('browser_tab_crashed', { reason: details.reason, exit_code: details.exitCode });
      this.win.layout();
      this.update();
    });
    wc.on('unresponsive', () => this.ctx.track('browser_tab_unresponsive'));
    wc.on('found-in-page', (_event, result) => {
      if (this.win.activeTab === this) this.win.send('find:result', result);
    });
    wc.on('update-target-url', (_event, url) => {
      if (this.win.activeTab === this) this.win.send('status:hover', url);
    });
    wc.on('audio-state-changed', (event) => {
      this.audible = Boolean(event.audible ?? wc.isCurrentlyAudible());
      this.update();
    });
    wc.on('enter-html-full-screen', () => {
      this.htmlFullscreen = true;
      this.win.layout();
      this.update();
    });
    wc.on('leave-html-full-screen', () => {
      this.htmlFullscreen = false;
      this.win.layout();
      this.update();
    });
    wc.on('zoom-changed', (_event, direction) => this.zoom(direction === 'in' ? 1 : -1));
    wc.on('context-menu', (_event, params) => this.contextMenu(params));
    wc.on('before-input-event', (event, input) => this.win.handleKey(event, input, this));

    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (url.startsWith('southbag:') && !fromInternal()) return { action: 'deny' };
      if (!/^(https?|file|southbag|about|blob|data):/i.test(url)) {
        this.ctx.openExternalProtocol(url);
        return { action: 'deny' };
      }
      // Real pop-ups (window.open with a size) get a small window, so OAuth pop-ups that talk
      // back to their opener keep working. Everything else becomes a tab, opener intact.
      if (disposition === 'new-window' && /(width|height)=/.test(features || '')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            title: 'Southbag pop-up (Kevin is watching)',
            icon: path.join(__dirname, '../renderer/icon.png'),
            webPreferences: {
              session: this.win.session,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
            },
          },
        };
      }
      const background = disposition === 'background-tab';
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: (options) => {
          const tab = this.win.addTab({ webContents: options.webContents, activate: !background, after: this, opener: this });
          return tab.wc;
        },
      };
    });
    wc.on('did-create-window', (child) => this.ctx.trackPopup(child, this.win));
  }

  async loadFavicon(favicons) {
    const url = favicons?.[0];
    if (!url) return;
    if (classify(this.url) === 'internal') return;
    try {
      const response = await this.win.session.fetch(url, { signal: AbortSignal.timeout(8000) });
      const type = response.headers.get('content-type') || '';
      if (!response.ok || !/^image\//.test(type)) return;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > FAVICON_MAX_BYTES || this.wc.isDestroyed()) return;
      this.favicon = `data:${type.split(';')[0]};base64,${buffer.toString('base64')}`;
      this.update();
    } catch {}
  }

  zoom(step) {
    const current = this.wc.getZoomFactor();
    let next;
    if (step === 0) next = 1;
    else if (step > 0) next = ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
    else next = [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0];
    this.wc.setZoomFactor(next);
    this.ctx.track('browser_zoom_changed', { zoom_percent: Math.round(next * 100) });
    this.update();
  }

  contextMenu(params) {
    const wc = this.wc;
    const ctx = this.ctx;
    const items = [];
    const sep = () => items.length && items[items.length - 1].type !== 'separator' && items.push({ type: 'separator' });
    const track = (action) => ctx.track('browser_context_menu', { action });
    if (params.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => (track('link_new_tab'), this.win.addTab({ url: params.linkURL, activate: false, after: this })) },
        { label: 'Open Link in New Window', click: () => (track('link_new_window'), ctx.createWindow({ urls: [params.linkURL] })) },
        { label: 'Open Link in Incognito* Window', click: () => (track('link_incognito'), ctx.createWindow({ isPrivate: true, urls: [params.linkURL] })) },
        { label: 'Copy Link Address', click: () => (track('copy_link'), clipboard.writeText(params.linkURL)) },
      );
      sep();
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => (track('image_new_tab'), this.win.addTab({ url: params.srcURL, activate: false, after: this })) },
        { label: 'Save Image As…', click: () => (track('image_save'), wc.downloadURL(params.srcURL)) },
        { label: 'Copy Image', click: () => (track('image_copy'), wc.copyImageAt(params.x, params.y)) },
        { label: 'Copy Image Address', click: () => (track('image_copy_address'), clipboard.writeText(params.srcURL)) },
      );
      sep();
    }
    if (params.isEditable) {
      if (params.misspelledWord && params.dictionarySuggestions.length) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
          items.push({ label: suggestion, click: () => wc.replaceMisspelling(suggestion) });
        }
        sep();
      }
      items.push(
        { label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo },
        { label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        { label: 'Select All', role: 'selectAll' },
      );
      sep();
    } else if (params.selectionText) {
      const text = params.selectionText.trim().slice(0, 200);
      items.push(
        { label: 'Copy', role: 'copy' },
        {
          label: `Search Southbag Search for “${text.length > 24 ? `${text.slice(0, 24)}…` : text}”`,
          click: () => (track('search_selection'), this.win.addTab({ url: ctx.store.searchUrl(text), after: this })),
        },
      );
      sep();
    }
    if (!params.linkURL && !params.isEditable && !params.selectionText && params.mediaType === 'none') {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => (track('back'), wc.navigationHistory.goBack()) },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => (track('forward'), wc.navigationHistory.goForward()) },
        { label: 'Reload', click: () => (track('reload'), wc.reload()) },
        { type: 'separator' },
        { label: 'Print to Branch…', click: () => (track('print'), this.print()) },
        { label: 'Ask Kevin to Summarise This Page', click: () => (track('kevin_summarise'), this.win.send('menu:action', 'kevin-summarise')) },
      );
      sep();
    }
    items.push(
      { label: 'Open in Southbag Terminal', click: () => (track('open_terminal'), ctx.launchTerminal(this.win)) },
      { label: 'Inspect', click: () => (track('inspect'), wc.inspectElement(params.x, params.y)) },
    );
    Menu.buildFromTemplate(items).popup({ window: this.win.window });
  }

  print() {
    this.ctx.track('browser_print', { kind: this.security });
    this.wc.print({}, (success, reason) => {
      this.ctx.track('browser_print_finished', { success, reason: success ? null : reason });
    });
  }

  destroy() {
    tabsByContents.delete(this.wc.id);
    try {
      this.win.window.contentView.removeChildView(this.view);
    } catch {}
    if (!this.wc.isDestroyed()) this.wc.close({ waitForBeforeUnload: false });
  }
}

class BrowserShell {
  /**
   * @param {object} ctx  shared services from main.js (store, secure, fees, track, …)
   * @param {object} options
   * @param {boolean} [options.isPrivate]
   * @param {Electron.Session} options.session
   */
  constructor(ctx, { isPrivate = false, session: ses }) {
    this.ctx = ctx;
    this.isPrivate = isPrivate;
    this.session = ses;
    this.id = ++nextWindowId;
    this.tabs = [];
    this.activeTab = null;
    this.closed = [];
    this.overlay = false;
    this.content = { x: 0, y: 0, width: 0, height: 0 };
    this.openedAt = Date.now();
    this.updateQueued = false;

    const display = screen.getPrimaryDisplay().workAreaSize;
    this.window = new BrowserWindow({
      width: Math.min(1280, display.width),
      height: Math.min(860, display.height),
      minWidth: 640,
      minHeight: 420,
      title: isPrivate ? 'Incognito* — Southbag Browser' : 'Southbag Browser',
      backgroundColor: isPrivate ? '#1b1033' : '#ffffff',
      icon: path.join(__dirname, '../renderer/icon.png'),
      titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
      autoHideMenuBar: !IS_MAC,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        additionalArguments: [`--southbag-private=${isPrivate ? 1 : 0}`],
      },
    });
    this.chrome = this.window.webContents;
    this.chrome.setVisualZoomLevelLimits(1, 1);
    this.window.loadFile(path.join(__dirname, '../renderer/index.html'));
    this.window.once('ready-to-show', () => this.window.show());

    // The chrome is a local app; never let it navigate anywhere or spawn windows.
    this.chrome.on('will-navigate', (event) => event.preventDefault());
    this.chrome.setWindowOpenHandler(({ url }) => {
      this.addTab({ url });
      return { action: 'deny' };
    });
    this.chrome.on('before-input-event', (event, input) => this.handleKey(event, input, null));
    this.window.on('resize', () => this.layout());
    this.window.on('enter-full-screen', () => this.send('window:fullscreen', true));
    this.window.on('leave-full-screen', () => this.send('window:fullscreen', false));
  }

  send(channel, ...args) {
    if (!this.chrome.isDestroyed()) this.chrome.send(channel, ...args);
  }

  update() {
    if (this.updateQueued) return;
    this.updateQueued = true;
    setImmediate(() => {
      this.updateQueued = false;
      if (this.window.isDestroyed()) return;
      const active = this.activeTab;
      this.send('tabs:state', {
        tabs: this.tabs.map((tab) => tab.state()),
        activeId: active?.id ?? null,
        canReopen: this.closed.length > 0,
      });
      const title = active ? active.state().title : null;
      const suffix = this.isPrivate ? 'Incognito* — Southbag Browser' : 'Southbag Browser';
      this.window.setTitle(title ? `${title} — ${suffix}` : suffix);
    });
  }

  /** Puts the active tab's view exactly over the chrome's content area, or hides it. */
  layout() {
    if (this.window.isDestroyed()) return;
    const active = this.activeTab;
    for (const tab of this.tabs) {
      const show =
        tab === active && this.ctx.isSignedIn() && !this.overlay && !tab.warning && !tab.error && this.content.width > 0;
      if (show) {
        if (tab.htmlFullscreen) {
          const [width, height] = this.window.getContentSize();
          tab.view.setBounds({ x: 0, y: 0, width, height });
        } else {
          tab.view.setBounds(this.content);
        }
      } else if (this.content.width && !tab.htmlFullscreen) {
        tab.view.setBounds(this.content);
      }
      tab.view.setVisible(show);
    }
  }

  setContentBounds(rect) {
    const round = (n) => Math.max(0, Math.round(Number(n) || 0));
    this.content = { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
    this.layout();
  }

  /** The chrome wants to draw over the page: hand it a screenshot, then hide the page. */
  async setOverlay(open) {
    if (!open) {
      this.overlay = false;
      this.layout();
      return null;
    }
    let snapshot = null;
    const tab = this.activeTab;
    if (tab && !this.overlay && tab.view.getVisible() && !tab.wc.isDestroyed()) {
      try {
        snapshot = (await tab.wc.capturePage()).toDataURL();
      } catch {}
    }
    this.overlay = true;
    this.layout();
    return snapshot;
  }

  addTab({ url, webContents, activate = true, after, opener, source } = {}) {
    if (!this.ctx.isSignedIn()) return null;
    const tab = new Tab(this, { url: webContents ? undefined : url || NEW_TAB_URL, webContents, opener });
    this.attach(tab);
    const index = after ? this.tabs.indexOf(after) + 1 + this.tabs.filter((t) => t.openerTab === after).length : this.tabs.length;
    this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
    this.ctx.track('browser_tab_opened', { source: source || (webContents ? 'page' : 'app'), open_tabs: this.tabs.length, private: this.isPrivate });
    if (activate || !this.activeTab) this.activate(tab);
    else this.update();
    return tab;
  }

  activate(tab, method) {
    if (!tab || !this.tabs.includes(tab)) return;
    const previous = this.activeTab;
    this.activeTab = tab;
    this.layout();
    this.update();
    if (previous !== tab) {
      this.send('status:hover', '');
      if (method) this.ctx.track('browser_tab_switched', { method, index: this.tabs.indexOf(tab) + 1, open_tabs: this.tabs.length });
      if (tab.isNewTabPage) this.focusChrome();
      else tab.wc.focus();
    }
  }

  closeTab(tab, reason = 'close') {
    const index = this.tabs.indexOf(tab);
    if (index === -1) return;
    this.tabs.splice(index, 1);
    const url = tab.wc.isDestroyed() ? tab.url : tab.wc.getURL() || tab.url;
    if (reason !== 'signed_out' && url && url !== 'about:blank') {
      this.closed.push({ url, index });
      if (this.closed.length > CLOSED_TAB_LIMIT) this.closed.shift();
    }
    for (const t of this.tabs) if (t.openerTab === tab) t.openerTab = null;
    tab.destroy();
    this.ctx.track('browser_tab_closed', {
      reason,
      lifetime_ms: Date.now() - tab.openedAt,
      navigations: tab.navigations,
      blocked: tab.blocked,
      open_tabs: this.tabs.length,
    });
    if (this.activeTab === tab) {
      this.activeTab = null;
      const next = tab.openerTab && this.tabs.includes(tab.openerTab) ? tab.openerTab : this.tabs[Math.min(index, this.tabs.length - 1)];
      if (next) this.activate(next);
    }
    if (this.tabs.length === 0 && reason !== 'signed_out' && this.ctx.isSignedIn()) {
      this.window.close();
      return;
    }
    this.layout();
    this.update();
  }

  closeAllTabs(reason) {
    for (const tab of [...this.tabs]) this.closeTab(tab, reason);
    if (reason === 'signed_out') this.closed = [];
    this.update();
  }

  reopenClosed() {
    const entry = this.closed.pop();
    if (!entry) return;
    this.ctx.track('browser_tab_reopened');
    const tab = new Tab(this, { url: entry.url });
    this.attach(tab);
    this.tabs.splice(Math.min(entry.index, this.tabs.length), 0, tab);
    this.activate(tab);
  }

  /**
   * Adds the view at the size it will be shown at. A page that first lays out in a 0×0 view
   * keeps the odd scroll position that produced, so hidden tabs get real bounds too.
   */
  attach(tab) {
    let bounds = this.content;
    if (!bounds.width) {
      const [width, height] = this.window.getContentSize();
      bounds = { x: 0, y: 150, width, height: Math.max(100, height - 180) };
    }
    tab.view.setBounds(bounds);
    this.window.contentView.addChildView(tab.view);
  }

  moveTab(tab, toIndex) {
    const from = this.tabs.indexOf(tab);
    if (from === -1) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab);
    this.ctx.track('browser_tab_reordered', { from: from + 1, to: this.tabs.indexOf(tab) + 1 });
    this.update();
  }

  cycle(step) {
    if (this.tabs.length < 2) return;
    const index = this.tabs.indexOf(this.activeTab);
    this.activate(this.tabs[(index + step + this.tabs.length) % this.tabs.length], 'shortcut');
  }

  selectIndex(n) {
    // ⌘9 / Ctrl+9 is always the last tab, as in every other browser.
    const tab = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
    this.activate(tab, 'shortcut');
  }

  tabById(id) {
    return this.tabs.find((tab) => tab.id === id) || null;
  }

  /**
   * Shortcuts the application menu can't carry alone: alternates (F5, Ctrl+Tab, F6, F3 …) and
   * Esc to stop loading. Menu accelerators handle the primary ones.
   */
  handleKey(event, input, tab) {
    if (input.type !== 'keyDown') return;
    const mod = IS_MAC ? input.meta : input.control;
    const key = input.key;
    const act = (action) => {
      event.preventDefault();
      this.ctx.menuAction(this, action, 'shortcut');
    };
    if (key === 'F5' && !input.shift && !mod) return act('reload');
    if ((key === 'F5' && (input.shift || mod)) || (key === 'F5' && input.control)) return act('hard-reload');
    if (key === 'F6' || (!IS_MAC && input.alt && !input.control && key.toLowerCase() === 'd')) return act('focus-omnibox');
    if (key === 'F3') return act(input.shift ? 'find-previous' : 'find-next');
    if (key === 'F12' || (IS_MAC && input.meta && input.alt && key.toLowerCase() === 'i')) return act('devtools');
    if (input.control && key === 'Tab') return act(input.shift ? 'prev-tab' : 'next-tab');
    if (!IS_MAC && input.control && key === 'F4') return act('close-tab');
    if (!IS_MAC && input.alt && !input.control && key === 'ArrowLeft') return act('back');
    if (!IS_MAC && input.alt && !input.control && key === 'ArrowRight') return act('forward');
    if (!IS_MAC && input.alt && key === 'Home') return act('home');
    if (IS_MAC && input.meta && input.alt && key === 'ArrowRight') return act('next-tab');
    if (IS_MAC && input.meta && input.alt && key === 'ArrowLeft') return act('prev-tab');
    if (key === 'Escape' && tab && tab.loading) return act('stop');
    if (tab && mod && !input.alt && (key === '+' || key === '=')) return act('zoom-in');
  }

  focusChrome() {
    this.chrome.focus();
  }

  destroy() {
    for (const tab of this.tabs) tab.destroy();
    this.tabs = [];
  }
}

module.exports = { BrowserShell, Tab, tabsByContents, NEW_TAB_URL, isCertError };
