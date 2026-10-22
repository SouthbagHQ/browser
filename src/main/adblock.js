/**
 * Southbag Ad Blocker™: blocks requests to the bundled list of ad and tracker domains
 * (blocklist.txt, subdomains included). Top-level navigations are never blocked, so typing
 * an ad domain into the omnibox still works; it is your funeral.
 */

const fs = require('node:fs');
const path = require('node:path');

function loadList(file = path.join(__dirname, 'blocklist.txt')) {
  const domains = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const domain = line.trim().toLowerCase();
    if (domain && !domain.startsWith('#')) domains.add(domain);
  }
  return domains;
}

class AdBlocker {
  constructor(domains = loadList()) {
    this.domains = domains;
  }

  /** True when the hostname, or any parent domain of it, is on the list. */
  matches(hostname) {
    let host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    while (host) {
      if (this.domains.has(host)) return true;
      const dot = host.indexOf('.');
      if (dot === -1) return false;
      host = host.slice(dot + 1);
    }
    return false;
  }

  shouldBlock(details) {
    if (details.resourceType === 'mainFrame') return false;
    let url;
    try {
      url = new URL(details.url);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') return false;
    return this.matches(url.hostname);
  }
}

module.exports = { AdBlocker, loadList };
