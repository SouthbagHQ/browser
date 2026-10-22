'use strict';

/* Shared by every southbag:// page. window.southbag only exists on these pages (tab-preload.js). */

const sb = window.southbag;
const $ = (id) => document.getElementById(id);
const call = (method, ...args) => sb.call(method, ...args);
const money = (cents) =>
  `${Number(cents || 0) < 0 ? '-' : ''}$${(Math.abs(Number(cents || 0)) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PAGES = [
  ['newtab', 'New Tab'],
  ['history', 'History'],
  ['bookmarks', 'Bookmarks'],
  ['downloads', 'Downloads'],
  ['settings', 'Settings'],
  ['about', 'About'],
];

function applyTheme(settings) {
  document.body.classList.toggle('dark-mode', Boolean(settings?.dark));
}

function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function renderHeader(current) {
  const header = document.querySelector('.page-header');
  if (!header) return;
  const nav = el('nav', { class: 'page-nav' });
  for (const [page, label] of PAGES) {
    nav.append(el('a', { href: `southbag://${page}/`, class: page === current ? 'current' : null, text: label }));
  }
  header.append(nav);
}

/** Sets up theme, header and analytics; resolves with browser info. */
async function initPage(name) {
  renderHeader(name);
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button) sb.capture('browser_page_click', { page: name, element: button.dataset.track || button.id || 'button' });
  });
  applyTheme(await call('settings:get'));
  sb.on('settings', applyTheme);
  const info = await call('info');
  document.body.classList.toggle('private', info.isPrivate);
  return info;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
