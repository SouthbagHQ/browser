/**
 * URL helpers: what the omnibox should do with what you typed, which sites count as
 * Southbag (Southbag Secure™), and what "a site" is for the open-web warning.
 */

const SOUTHBAG_DOMAIN = 'southbag.cc';

/** Every Southbag app. These live on the bookmarks bar and cannot be removed. */
const SOUTHBAG_BOOKMARKS = [
  { id: 'sb-home', title: 'Southbag', url: 'https://southbag.cc/' },
  // /auth/onboard signs in through Identity if banking has no session yet, which is instant
  // thanks to the shared .southbag.cc cookie, then lands on the dashboard.
  { id: 'sb-banking', title: 'Banking', url: 'https://banking.southbag.cc/auth/onboard' },
  { id: 'sb-drive', title: 'Drive', url: 'https://drive.southbag.cc/' },
  { id: 'sb-office', title: 'Office', url: 'https://office.southbag.cc/' },
  { id: 'sb-git', title: 'Git', url: 'https://git.southbag.cc/' },
  { id: 'sb-social', title: 'Social', url: 'https://social.southbag.cc/' },
  { id: 'sb-code', title: 'Code', url: 'https://code.southbag.cc/' },
  { id: 'sb-support', title: 'Support', url: 'https://support.southbag.cc/' },
  { id: 'sb-lore', title: 'Lore', url: 'https://lore.southbag.cc/' },
  { id: 'sb-docs', title: 'Docs', url: 'https://docs.southbag.cc/' },
  { id: 'sb-branch', title: 'Branch Locator', url: 'https://branch-locator.southbag.cc/' },
  { id: 'sb-identity', title: 'Identity', url: 'https://identity.southbag.cc/' },
].map((bookmark) => ({ ...bookmark, southbag: true }));

const INTERNAL_PAGES = ['newtab', 'settings', 'history', 'bookmarks', 'downloads', 'about', 'terminal'];

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isSouthbagHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return host === SOUTHBAG_DOMAIN || host.endsWith(`.${SOUTHBAG_DOMAIN}`);
}

/**
 * 'southbag'  https on *.southbag.cc: gold Verified Enterprise badge
 * 'web'       any other http(s) site: Not Southbag (Unsafe)
 * 'internal'  southbag:// pages and about:blank
 * 'file'      local files
 * 'other'     everything else (data:, blob:, view-source: …)
 */
function classify(url) {
  const parsed = parse(url);
  if (!parsed) return 'other';
  if (parsed.protocol === 'southbag:' || url === 'about:blank') return 'internal';
  if (parsed.protocol === 'file:') return 'file';
  if (parsed.protocol === 'https:' && isSouthbagHost(parsed.hostname)) return 'southbag';
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return 'web';
  return 'other';
}

const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'org.nz', 'govt.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.cn', 'co.in', 'co.za',
  'com.mx', 'com.sg', 'com.hk', 'co.kr', 'github.io', 'pages.dev', 'workers.dev', 'vercel.app',
  'netlify.app', 'herokuapp.com', 'blogspot.com',
]);

/** Roughly the registrable domain, so www.example.com and docs.example.com are one site. */
function siteOf(url) {
  const parsed = parse(url);
  if (!parsed || !parsed.hostname) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const labels = host.split('.');
  const lastTwo = labels.slice(-2).join('.');
  const take = TWO_LEVEL_SUFFIXES.has(lastTwo) && labels.length > 2 ? 3 : 2;
  return labels.slice(-take).join('.');
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HOST_LIKE = /^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z][a-z0-9-]*)(:\d+)?([/?#].*)?$/i;

/** Turns omnibox input into a URL, or null if it should be searched for. */
function inputToUrl(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/^southbag:\/*([a-z-]+)/i.test(text)) {
    const page = text.replace(/^southbag:\/*/i, '').split(/[/?#]/)[0].toLowerCase();
    return `southbag://${page}/`;
  }
  if (/^(about:blank)$/i.test(text)) return 'about:blank';
  if (/\s/.test(text)) return null;
  if (/^(https?|file):/i.test(text)) return parse(text) ? text : null;
  if (SCHEME.test(text) && !HOST_LIKE.test(text)) return null;
  if (HOST_LIKE.test(text)) {
    const host = text.split(/[/?#:]/)[0];
    const scheme = /^(localhost|(\d{1,3}\.){3}\d{1,3})$/i.test(host) ? 'http' : 'https';
    return parse(`${scheme}://${text}`) ? `${scheme}://${text}` : null;
  }
  return null;
}

/** What the omnibox shows. The new tab page shows nothing so you can just type. */
function displayUrl(url) {
  if (!url || url === 'about:blank' || url.startsWith('southbag://newtab')) return '';
  if (url.startsWith('southbag://')) return url.replace(/\/$/, '');
  return url;
}

function isInternalPage(url) {
  const parsed = parse(url);
  return Boolean(parsed && parsed.protocol === 'southbag:' && INTERNAL_PAGES.includes(parsed.hostname));
}

module.exports = {
  SOUTHBAG_DOMAIN,
  SOUTHBAG_BOOKMARKS,
  INTERNAL_PAGES,
  classify,
  siteOf,
  inputToUrl,
  displayUrl,
  isSouthbagHost,
  isInternalPage,
};
