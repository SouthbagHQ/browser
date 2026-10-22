'use strict';

const api = window.southbag;
const $ = (id) => document.getElementById(id);
const capture = (event, properties) => api.palantir.capture(event, properties || {});
const IS_MAC = api.platform === 'darwin';

if (IS_MAC) document.body.classList.add('mac');
if (api.isPrivate) {
  document.body.classList.add('private');
  $('statusWatch').textContent = 'Kevin is still watching*';
  $('statusWatch').title = 'Incognito*: history and cookies are forgotten when this window closes. *Kevin can still see you.';
}

// ---------------------------------------------------------------------------
// Analytics for the chrome: which button, never what it was about.
// ---------------------------------------------------------------------------

let currentView = 'loading';

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  capture('browser_ui_click', {
    element: button.dataset.track || button.id || 'button',
    view: currentView,
  });
  if (button.dataset.href) api.openExternal(button.dataset.href);
});

window.addEventListener('error', (event) =>
  capture('browser_error', { source: 'renderer', name: String(event.error?.name || 'error').slice(0, 40) }),
);

// ---------------------------------------------------------------------------
// Views and login
// ---------------------------------------------------------------------------

let user = null;
let settings = {};

function showView(name) {
  if (currentView === name) return;
  currentView = name;
  $('login').hidden = name !== 'login';
  $('app').hidden = name !== 'app';
  document.body.classList.remove('loading');
  capture('browser_view_shown', { view: name });
  if (name === 'app') requestAnimationFrame(reportContent);
}

function setLoginStatus(text, isError = false) {
  const status = $('loginStatus');
  status.textContent = text;
  status.classList.toggle('error', isError);
}

function setPending(count) {
  $('pendingNotice').hidden = !count;
  $('pendingNotice').textContent = `${count} link${count === 1 ? ' is' : 's are'} waiting for you to log in. Kevin is holding ${count === 1 ? 'it' : 'them'} hostage.`;
}

function applyAuth({ status, user: nextUser, pending }) {
  setPending(pending || 0);
  if (status === 'signed-in' && nextUser) {
    user = nextUser;
    $('accountName').textContent = user.name || user.email || 'Southbag customer';
    $('accountName').title = user.email || '';
    showView('app');
    return;
  }
  if (status === 'unknown') return;
  user = null;
  closeModal();
  setKevinOpen(false);
  kevinLog.length = 0;
  renderKevin();
  $('offlinePanel').hidden = status !== 'offline';
  if (status === 'signed-out') setLoginStatus('');
  if (status === 'offline') setLoginStatus('Southbag Identity is unreachable.', true);
  showView('login');
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginButton').disabled = true;
  $('cancelButton').hidden = false;
  setLoginStatus('Complete your login in the Southbag Identity window…');
  const result = await api.auth.login();
  $('loginButton').disabled = false;
  $('cancelButton').hidden = true;
  if (!result.ok) {
    setLoginStatus(
      result.code === 'cancelled' ? 'Login cancelled. The web remains locked.' : `Login failed: ${result.message}`,
      result.code !== 'cancelled',
    );
  }
});

$('cancelButton').addEventListener('click', () => api.auth.cancel());
$('retryButton').addEventListener('click', () => location.reload());
$('logoutButton').addEventListener('click', () => api.auth.logout());

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function applySettings(next) {
  settings = next || {};
  document.body.classList.toggle('dark-mode', Boolean(settings.dark));
  $('darkModeToggle').textContent = settings.dark ? 'Light Mode' : 'Dark Mode';
  $('bookmarksBar').hidden = settings.showBookmarksBar === false;
  requestAnimationFrame(reportContent);
}

$('darkModeToggle').addEventListener('click', () => {
  api.settings.set({ dark: !settings.dark });
  capture('browser_theme_changed', { dark: !settings.dark });
});

// ---------------------------------------------------------------------------
// Content area: the active tab's view is laid exactly over #content.
// ---------------------------------------------------------------------------

function reportContent() {
  if (currentView !== 'app') return;
  const rect = $('content').getBoundingClientRect();
  api.layout.content({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
}

new ResizeObserver(reportContent).observe($('content'));
window.addEventListener('resize', reportContent);

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

let tabs = [];
let activeId = null;
const tabElements = new Map();
const active = () => tabs.find((tab) => tab.id === activeId) || null;

function tabElement(tab) {
  let el = tabElements.get(tab.id);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  el.dataset.id = String(tab.id);
  el.innerHTML =
    '<span class="tab-icon-slot"></span><span class="tab-title"></span>' +
    '<button type="button" class="tab-audio" data-track="tab_mute" hidden></button>' +
    '<button type="button" class="tab-close" data-track="tab_close_button" title="Close tab">x</button>';
  el.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  el.addEventListener('auxclick', (event) => {
    if (event.button === 1) {
      event.preventDefault();
      api.tabs.command('close', tab.id, 'middle_click');
    }
  });
  el.addEventListener('click', (event) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (event.target.closest('.tab-close')) api.tabs.command('close', tab.id, 'close_button');
    else if (event.target.closest('.tab-audio')) api.tabs.command('mute', tab.id);
    else api.tabs.command('activate', tab.id, 'click');
  });
  el.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    api.tabs.menu(tab.id);
  });
  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    startTabDrag(event, tab.id, el);
  });
  tabElements.set(tab.id, el);
  return el;
}

function clearDropMarks() {
  for (const el of tabElements.values()) el.classList.remove('drop-before', 'drop-after');
}

/**
 * Drag to reorder, with pointer events rather than HTML5 drag and drop (which is unreliable
 * on Linux). The tab only starts moving after a few pixels, so clicks stay clicks.
 */
function startTabDrag(down, id, el) {
  let dragging = false;
  let target = null;
  const move = (event) => {
    if (!dragging && Math.abs(event.clientX - down.clientX) < 6) return;
    if (!dragging) {
      dragging = true;
      el.classList.add('dragging');
      el.setPointerCapture(down.pointerId);
    }
    clearDropMarks();
    const from = tabs.findIndex((t) => t.id === id);
    target = null;
    tabs.forEach((t, index) => {
      const other = tabElements.get(t.id);
      if (!other || t.id === id) return;
      const rect = other.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right) {
        const after = event.clientX > rect.left + rect.width / 2;
        other.classList.add(after ? 'drop-after' : 'drop-before');
        target = index + (after ? 1 : 0);
        if (from < target) target -= 1;
      }
    });
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    el.classList.remove('dragging');
    clearDropMarks();
    const from = tabs.findIndex((t) => t.id === id);
    if (dragging && target != null && target !== from) {
      suppressClick = true;
      api.tabs.command('move', id, target);
    } else if (dragging) {
      suppressClick = true;
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

let suppressClick = false;

function iconFor(tab) {
  if (tab.loading) return { kind: 'spinner' };
  if (tab.internal || tab.security === 'southbag' && !tab.favicon) return { kind: 'logo' };
  if (tab.favicon) return { kind: 'img', src: tab.favicon };
  return { kind: 'none' };
}

function renderTabs() {
  const strip = $('tabs');
  const seen = new Set();
  tabs.forEach((tab, index) => {
    seen.add(tab.id);
    const el = tabElement(tab);
    el.classList.toggle('active', tab.id === activeId);
    el.setAttribute('aria-selected', String(tab.id === activeId));
    el.title = tab.title;
    el.querySelector('.tab-title').textContent = tab.title;
    const slot = el.querySelector('.tab-icon-slot');
    const icon = iconFor(tab);
    const key = icon.kind + (icon.src || '');
    if (slot.dataset.key !== key) {
      slot.dataset.key = key;
      slot.innerHTML = '';
      if (icon.kind === 'spinner') slot.innerHTML = '<span class="tab-spinner"></span>';
      else if (icon.kind === 'logo' || icon.kind === 'img') {
        const img = document.createElement('img');
        img.className = 'tab-icon';
        img.src = icon.kind === 'logo' ? 'mark.png' : icon.src;
        img.alt = '';
        slot.appendChild(img);
      }
    }
    const audio = el.querySelector('.tab-audio');
    audio.hidden = !tab.audible && !tab.muted;
    audio.textContent = tab.muted ? 'muted' : '♪';
    audio.title = tab.muted ? 'Unmute tab' : 'Mute tab';
    if (strip.children[index] !== el) strip.insertBefore(el, strip.children[index] || null);
  });
  for (const [id, el] of tabElements) {
    if (!seen.has(id)) {
      el.remove();
      tabElements.delete(id);
    }
  }
  const current = tabElements.get(activeId);
  current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

const SECURITY_LABELS = {
  southbag: 'Verified Enterprise',
  web: 'Not Southbag (Unsafe)',
  file: 'Local file (Not Southbag)',
  internal: 'Southbag',
  other: 'Not Southbag (Unsafe)',
};

function renderToolbar() {
  const tab = active();
  $('backButton').disabled = !tab?.canGoBack;
  $('forwardButton').disabled = !tab?.canGoForward;
  $('reloadButton').textContent = tab?.loading ? 'x' : '⟳';
  $('reloadButton').title = tab?.loading ? 'Stop' : 'Reload';
  const address = $('address');
  if (document.activeElement !== address || addressDirtyFor !== activeId) {
    address.value = tab ? tab.display : '';
    addressDirtyFor = null;
  }
  const security = tab?.security || 'internal';
  const padlock = $('padlock');
  padlock.className = `padlock ${security}`;
  let label = SECURITY_LABELS[security] || SECURITY_LABELS.other;
  if (security === 'southbag') label = '★ Verified Enterprise';
  if (security === 'web' && tab?.url.startsWith('http:')) label = 'Not Southbag (Unsafe, unencrypted)';
  if (tab?.page === 'newtab' && !tab.warning) label = 'Southbag';
  padlock.textContent = label;
  padlock.title =
    security === 'southbag'
      ? 'Southbag Secure™: this site is operated by the Southbag Global Enterprise Network'
      : security === 'internal'
        ? 'A Southbag Browser page'
        : 'Southbag Secure™: this site is not operated by Southbag';
  $('starButton').textContent = tab?.bookmarked ? '★' : '☆';
  $('starButton').classList.toggle('on', Boolean(tab?.bookmarked));
  $('starButton').disabled = !tab;

  const status = $('statusSecurity');
  status.className = `status-item ${security}`;
  status.textContent = security === 'southbag' ? 'Southbag Secure™' : security === 'internal' ? '' : 'Open web';
  const zoom = $('statusZoom');
  zoom.hidden = !tab || tab.zoom === 100;
  zoom.textContent = tab ? `Zoom ${tab.zoom}% (reset)` : '';
  renderBlocked();
}

function renderBlocker() {
  const tab = active();
  const blocker = $('blocker');
  const warning = tab?.warning;
  const error = tab?.error;
  blocker.hidden = !warning && !error;
  $('unsafePanel').hidden = !warning;
  $('certPanel').hidden = error?.kind !== 'cert';
  $('networkPanel').hidden = error?.kind !== 'network';
  $('crashPanel').hidden = error?.kind !== 'crash';
  if (warning) {
    $('unsafeSite').textContent = warning.site || 'This site';
    $('unsafeUrl').textContent = warning.url;
  }
  if (error?.kind === 'cert') {
    let host = '';
    try {
      host = new URL(error.url).host;
    } catch {}
    for (const id of ['certHost', 'certHost2', 'certHost3']) $(id).textContent = host;
    $('certCode').textContent = `${error.description || 'ERR_CERT_INVALID'} (${error.code})`;
    const details = $('certDetails');
    details.innerHTML = '';
    const d = error.details;
    if (d) {
      const rows = [
        ['Error', d.error],
        ['Issued to', d.subject?.commonName || d.subject],
        ['Issued by', d.issuer?.commonName || d.issuer],
        ['Valid from', d.validStart ? new Date(d.validStart).toLocaleDateString() : null],
        ['Expires', d.validExpiry ? new Date(d.validExpiry).toLocaleDateString() : null],
        ['Fingerprint', d.fingerprint],
      ];
      for (const [term, value] of rows) {
        if (!value || typeof value !== 'string') continue;
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        details.append(dt, dd);
      }
    }
    $('certProceed').hidden = !d;
  } else {
    $('certAdvancedPanel').hidden = true;
  }
  if (error?.kind === 'network') {
    let host = error.url;
    try {
      host = new URL(error.url).host || error.url;
    } catch {}
    $('networkHost').textContent = host;
    $('networkCode').textContent = `${error.description || 'ERR_FAILED'} (${error.code})`;
  }
  if (error?.kind === 'crash') $('crashCode').textContent = error.description || '';
}

let addressDirtyFor = null;

api.tabs.onState((state) => {
  const previous = activeId;
  tabs = state.tabs;
  activeId = state.activeId;
  renderTabs();
  renderToolbar();
  renderBlocker();
  const tab = active();
  document.body.classList.toggle('html-fullscreen', Boolean(tab?.htmlFullscreen));
  if (previous !== activeId) {
    $('statusHover').textContent = '';
    if (!$('findBar').hidden) runFind(false);
    if (tab?.newTab) focusOmnibox();
  }
});

$('newTab').addEventListener('click', () => api.tabs.command('new', 'button'));
$('tabs').addEventListener('dblclick', (event) => {
  if (event.target === $('tabs')) api.tabs.command('new', 'tab_bar_double_click');
});
$('backButton').addEventListener('click', () => api.tabs.command('back'));
$('forwardButton').addEventListener('click', () => api.tabs.command('forward'));
$('reloadButton').addEventListener('click', () => api.tabs.command(active()?.loading ? 'stop' : 'reload'));
$('homeButton').addEventListener('click', () => api.tabs.command('home'));
$('menuButton').addEventListener('click', () => api.appMenu());

$('unsafeAccept').addEventListener('click', () => api.tabs.command('warning-accept', activeId));
$('unsafeBack').addEventListener('click', () => api.tabs.command('warning-reject', activeId));
$('certBack').addEventListener('click', () => {
  const tab = active();
  api.tabs.command(tab?.canGoBack ? 'back' : 'home');
});
$('certAdvanced').addEventListener('click', () => {
  $('certAdvancedPanel').hidden = !$('certAdvancedPanel').hidden;
});
$('certProceed').addEventListener('click', () => api.tabs.command('cert-proceed', activeId));
$('networkRetry').addEventListener('click', () => api.tabs.command('retry', activeId));
$('crashReload').addEventListener('click', () => api.tabs.command('retry', activeId));

// ---------------------------------------------------------------------------
// Omnibox
// ---------------------------------------------------------------------------

function focusOmnibox() {
  const address = $('address');
  address.focus();
  address.select();
}

$('address').addEventListener('focus', () => requestAnimationFrame(() => $('address').select()));
$('address').addEventListener('input', async () => {
  addressDirtyFor = activeId;
  const text = $('address').value;
  const suggestions = await api.omnibox.suggest(text);
  if ($('address').value !== text) return;
  const list = $('suggestions');
  list.innerHTML = '';
  for (const suggestion of suggestions) {
    const option = document.createElement('option');
    option.value = suggestion.url;
    option.label = suggestion.title;
    list.appendChild(option);
  }
});
$('address').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    addressDirtyFor = null;
    renderToolbar();
    api.tabs.command('focus-page');
  }
});
$('omnibox').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('address').value.trim();
  if (!value) return;
  addressDirtyFor = null;
  $('suggestions').innerHTML = '';
  api.tabs.command('navigate', value);
});

$('starButton').addEventListener('click', toggleBookmark);

async function toggleBookmark() {
  const result = await api.bookmarks.toggleCurrent();
  if (result.southbag) flash(result.error);
  else if (result.removed) flash('Bookmark removed.');
  else if (result.ok && !result.existing) flash('Bookmarked. Kevin has been notified.');
}

// ---------------------------------------------------------------------------
// Bookmarks bar
// ---------------------------------------------------------------------------

function renderBookmarks({ southbag, user: mine }) {
  const bar = $('bookmarksBar');
  bar.innerHTML = '';
  const make = (bookmark) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `bookmark${bookmark.southbag ? ' southbag' : ''}`;
    button.dataset.track = bookmark.southbag ? 'bookmark_southbag' : 'bookmark_user';
    button.title = bookmark.southbag
      ? `${bookmark.title}: a permanent Southbag bookmark. It cannot be removed, and frankly, why would you?`
      : bookmark.title;
    const icon = bookmark.southbag ? 'mark.png' : bookmark.favicon;
    if (icon) {
      const img = document.createElement('img');
      img.src = icon;
      img.alt = '';
      button.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = bookmark.title;
    button.appendChild(label);
    button.addEventListener('click', (event) => {
      const newTab = event.ctrlKey || event.metaKey;
      api.bookmarks.open(bookmark.id, newTab ? 'tab' : event.shiftKey ? 'window' : 'current');
    });
    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) api.bookmarks.open(bookmark.id, 'tab');
    });
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      api.bookmarks.menu(bookmark.id);
    });
    return button;
  };
  for (const bookmark of southbag) bar.appendChild(make(bookmark));
  const divider = document.createElement('span');
  divider.className = 'bookmarks-divider';
  bar.appendChild(divider);
  if (!mine.length) {
    const hint = document.createElement('span');
    hint.className = 'bookmarks-hint';
    hint.textContent = `Your bookmarks go here (${IS_MAC ? '⌘D' : 'Ctrl+D'}). Southbag's go first.`;
    bar.appendChild(hint);
  }
  for (const bookmark of mine) bar.appendChild(make(bookmark));
}

api.bookmarks.onChange(renderBookmarks);

// ---------------------------------------------------------------------------
// Find in page
// ---------------------------------------------------------------------------

function openFind() {
  $('findBar').hidden = false;
  $('findInput').focus();
  $('findInput').select();
  if ($('findInput').value) runFind(false);
}

function closeFind() {
  $('findBar').hidden = true;
  $('findCount').textContent = '';
  api.find.stop();
  api.tabs.command('focus-page');
}

function runFind(findNext, forward = true) {
  const text = $('findInput').value;
  if (!text) {
    $('findCount').textContent = '';
    api.find.stop();
    return;
  }
  api.find.start(text, { findNext, forward });
}

$('findInput').addEventListener('input', () => runFind(false));
$('findInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runFind(true, !event.shiftKey);
  } else if (event.key === 'Escape') {
    closeFind();
  }
});
$('findNext').addEventListener('click', () => runFind(true, true));
$('findPrev').addEventListener('click', () => runFind(true, false));
$('findClose').addEventListener('click', closeFind);
api.find.onResult((result) => {
  if (!result.finalUpdate && !result.matches) return;
  $('findCount').textContent = result.matches ? `${result.activeMatchOrdinal} of ${result.matches}` : 'No matches. Try Southbag Search.';
});

// ---------------------------------------------------------------------------
// Dialogs. While one is open the page is a screenshot, so nothing hides behind the view.
// ---------------------------------------------------------------------------

let openDialog = null;

async function openModal(id, { popover = false, anchor } = {}) {
  if (openDialog) closeModal();
  openDialog = id;
  const snapshot = await api.layout.overlay(true);
  if (openDialog !== id) return;
  if (snapshot) {
    $('snapshot').src = snapshot;
    $('snapshot').hidden = false;
  }
  const modal = $('modal');
  modal.classList.toggle('popover-mode', popover);
  for (const dialog of modal.querySelectorAll('.dialog')) dialog.hidden = dialog.id !== id;
  modal.hidden = false;
  const dialog = $(id);
  if (popover && anchor) {
    const rect = anchor.getBoundingClientRect();
    dialog.style.position = 'absolute';
    dialog.style.left = `${Math.max(8, rect.left)}px`;
    dialog.style.top = `${rect.bottom + 6}px`;
  }
  dialog.querySelector('[data-close], button')?.focus();
  capture('browser_dialog_opened', { dialog: id });
}

function closeModal() {
  if (!openDialog) return;
  capture('browser_dialog_closed', { dialog: openDialog });
  openDialog = null;
  $('modal').hidden = true;
  $('snapshot').hidden = true;
  $('snapshot').removeAttribute('src');
  api.layout.overlay(false);
}

$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal') || event.target.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openDialog) {
    event.preventDefault();
    closeModal();
  }
});

// The Privacy button. The dialog is blank. That is the policy.
$('privacyButton').addEventListener('click', () => openModal('privacyDialog'));

$('padlock').addEventListener('click', () => {
  const tab = active();
  if (!tab) return;
  const body = $('securityBody');
  const popover = $('securityPopover');
  popover.className = `dialog popover ${tab.security}`;
  body.innerHTML = '';
  const h3 = document.createElement('h3');
  const p = document.createElement('p');
  const dl = document.createElement('dl');
  const row = (term, value) => {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  };
  const https = tab.url.startsWith('https:');
  if (tab.security === 'southbag') {
    h3.textContent = '★ Verified Enterprise';
    p.textContent = 'This site is operated by the Southbag Global Enterprise Network. Everything you do here is visible to Southbag, as intended.';
  } else if (tab.security === 'internal') {
    h3.textContent = 'Southbag Browser';
    p.textContent = 'This is a built-in Southbag page. It is the safest page on your computer.';
  } else if (tab.security === 'file') {
    h3.textContent = 'Local file (Not Southbag)';
    p.textContent = 'This file is on your computer, which Southbag has not audited. Yet.';
  } else {
    h3.textContent = 'Not Southbag (Unsafe)';
    p.textContent = 'This site is part of the open web. Southbag does not operate, audit or endorse it. Proceed with the usual caution, plus some extra caution for us.';
  }
  if (tab.host) row('Site', tab.host);
  if (tab.security !== 'internal') {
    row('Connection', https ? 'Encrypted (HTTPS)' : tab.url.startsWith('http:') ? 'Not encrypted (HTTP)' : 'Not applicable');
    if (https) row('Certificate', tab.certException ? 'NOT trusted. You chose to proceed anyway.' : 'Valid (trusted by your system)');
    row('Ads blocked', String(tab.blocked));
  }
  row('Kevin', 'Watching');
  body.append(h3, p, dl);
  openModal('securityPopover', { popover: true, anchor: $('padlock') });
});
$('securityReport').addEventListener('click', () => {
  closeModal();
  flash('Reported to Kevin. He said "ok".');
});

// Default browser nag: a big Yes, a tiny no, and a "don't ask again" that actually works.
api.onNag(() => {
  $('nagResult').hidden = true;
  $('nagDontAsk').checked = false;
  $('nagYes').disabled = false;
  openModal('nagDialog');
});
$('nagYes').addEventListener('click', async () => {
  $('nagYes').disabled = true;
  const result = await api.defaultBrowser.respond('yes', $('nagDontAsk').checked);
  $('nagResult').hidden = false;
  $('nagResult').textContent = result.isDefault
    ? 'Southbag Browser is now your default browser. Excellent decision.'
    : 'We asked your operating system. If it showed you a prompt, please say yes there too.';
  setTimeout(closeModal, 2200);
});
$('nagNo').addEventListener('click', async () => {
  await api.defaultBrowser.respond('no', $('nagDontAsk').checked);
  closeModal();
  if (!$('nagDontAsk').checked) flash('Noted. We will ask again next time.');
});

// ---------------------------------------------------------------------------
// Kevin
// ---------------------------------------------------------------------------

const kevinLog = [];
let kevinBusy = false;

function setKevinOpen(open) {
  $('kevin').hidden = !open;
  if (open && kevinLog.length === 0) {
    kevinLog.push({ role: 'assistant', content: `G'day${user?.name ? ` ${user.name.split(' ')[0]}` : ''}. Kevin here. What did you break?` });
    renderKevin();
  }
  if (open) $('kevinInput').focus();
  requestAnimationFrame(reportContent);
}

function renderKevin(pending) {
  const log = $('kevinLog');
  log.innerHTML = '';
  for (const message of kevinLog) {
    const div = document.createElement('div');
    div.className = `kevin-msg ${message.role}`;
    div.textContent = message.content;
    log.appendChild(div);
  }
  if (pending) {
    const div = document.createElement('div');
    div.className = 'kevin-msg assistant pending';
    div.textContent = pending;
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}

async function kevinAsk(text) {
  if (kevinBusy || !text.trim()) return;
  kevinBusy = true;
  kevinLog.push({ role: 'user', content: text.trim() });
  renderKevin('Kevin is typing. Slowly.');
  const result = await api.kevin.chat(kevinLog.filter((m) => !m.local));
  kevinLog.push({ role: 'assistant', content: result.content });
  kevinBusy = false;
  renderKevin();
}

async function kevinSummarise() {
  if (kevinBusy) return;
  setKevinOpen(true);
  kevinBusy = true;
  kevinLog.push({ role: 'user', content: 'Summarise this page.', local: true });
  renderKevin('Kevin is skimming it. Barely.');
  const result = await api.kevin.summarise();
  kevinLog.push({ role: 'assistant', content: result.content, local: true });
  kevinBusy = false;
  renderKevin();
}

$('kevinButton').addEventListener('click', () => setKevinOpen($('kevin').hidden));
$('kevinClose').addEventListener('click', () => setKevinOpen(false));
$('kevinSummarise').addEventListener('click', kevinSummarise);
$('kevinForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('kevinInput').value;
  $('kevinInput').value = '';
  kevinAsk(text);
});
$('kevinInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('kevinForm').requestSubmit();
  }
});

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

let status = null;
let flashTimer;

function flash(text) {
  $('statusMessage').textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    $('statusMessage').textContent = '';
  }, 4000);
}

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

function renderBlocked() {
  if (!status) return;
  const tab = active();
  $('statusBlocked').textContent = status.adBlock
    ? `Ads blocked: ${status.blockedSession}${tab && tab.blocked ? ` (this page: ${tab.blocked})` : ''}`
    : 'Ad blocker: off';
}

function renderStatus(next) {
  status = next;
  renderBlocked();
  const fees = next.fees;
  const feeEl = $('statusFees');
  if (!fees || !fees.enabled) {
    feeEl.textContent = 'Fees: waived (Kevin is sad)';
    feeEl.title = 'Browsing fees are off. You can turn them back on in Settings. Please.';
  } else {
    feeEl.textContent = `Fees: ${money(fees.sessionCents)}`;
    feeEl.title = [
      `Browsing fee: ${money(fees.perPageCents)} per page load.`,
      `This session: ${money(fees.sessionCents)}. Lifetime: ${money(fees.lifetimeCents)}.`,
      `Charged to your Southbag account: ${money(fees.chargedCents)}. Pending: ${money(fees.pendingCents)}.`,
      fees.lastError ? `The bank could not be reached (${fees.lastError}); Kevin is keeping count.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  $('statusRewards').textContent = `Rewards: ${next.rewards.points.toLocaleString()} pts`;
  $('statusRewards').title = 'Southbag Rewards: points for time spent on Southbag sites. Redeemable for nothing.';
  const downloads = next.downloads;
  const dl = $('statusDownloads');
  if (downloads.active) {
    dl.hidden = false;
    dl.textContent = `Downloading ${downloads.active === 1 ? downloads.latest?.filename : `${downloads.active} files`}${downloads.percent != null ? ` ${downloads.percent}%` : '…'}`;
  } else if (downloads.latest && recentDownload === downloads.latest.id) {
    dl.hidden = false;
    dl.textContent = `${downloads.latest.filename}: ${downloads.latest.state === 'completed' ? 'done' : downloads.latest.state}`;
  } else {
    dl.hidden = true;
  }
  const promo = next.promo;
  $('statusPromo').hidden = !promo;
  if (promo) {
    $('promoText').textContent = promo.text;
    $('promoCta').textContent = promo.cta;
    $('promoCta').dataset.url = promo.url;
  }
}

let recentDownload = null;
api.status.onUpdate(renderStatus);
api.status.onHover((url) => {
  $('statusHover').textContent = url || '';
});
$('statusDownloads').addEventListener('click', () => api.tabs.command('downloads'));
$('statusZoom').addEventListener('click', () => api.tabs.command('zoom-reset'));
$('statusSecurity').addEventListener('click', () => $('padlock').click());
$('promoCta').addEventListener('click', () => {
  const url = $('promoCta').dataset.url;
  if (url) api.openExternal(url);
});
$('promoDismiss').addEventListener('click', () => api.status.dismissPromo());

// ---------------------------------------------------------------------------
// Menu actions from the main process
// ---------------------------------------------------------------------------

api.onMenu((action) => {
  if (currentView !== 'app') return;
  switch (action) {
    case 'focus-omnibox':
      return focusOmnibox();
    case 'find':
      return openFind();
    case 'find-next':
      return $('findInput').value ? runFind(true, true) : openFind();
    case 'find-previous':
      return $('findInput').value ? runFind(true, false) : openFind();
    case 'kevin':
      return setKevinOpen($('kevin').hidden);
    case 'kevin-summarise':
      return kevinSummarise();
    case 'privacy':
      return openModal('privacyDialog');
    case 'bookmark-page':
      return toggleBookmark();
  }
});

api.onFullscreen((fullscreen) => document.body.classList.toggle('fullscreen', fullscreen));
api.onPending(setPending);
api.settings.onChange(applySettings);
let recentTimer;
api.onDownloadStarted((id) => {
  recentDownload = id;
  flash('Download started. Kevin has kept a copy.');
  clearTimeout(recentTimer);
  recentTimer = setTimeout(() => {
    recentDownload = null;
    if (status) renderStatus(status);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

api.auth.onChange(applyAuth);
api.settings.get().then(applySettings);
api.bookmarks.list().then(renderBookmarks);
api.status.get().then(renderStatus);
api.auth.state().then(applyAuth);
