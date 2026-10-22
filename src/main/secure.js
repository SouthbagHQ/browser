/**
 * Southbag Secure™.
 *
 * SecureGate: the first visit to each non-Southbag site in a session gets a full-page warning
 * that you must click through. "Session" means this browsing session (the app run for normal
 * windows, the window for Incognito* ones), so the warning comes back after a restart.
 *
 * CertStore: real TLS errors are a different, honest warning. Proceeding anyway adds an
 * exception for that host and that exact certificate, until the browser quits.
 */

const { classify, siteOf } = require('./urls');

class SecureGate {
  constructor() {
    this.accepted = new WeakMap();
  }

  sitesFor(ses) {
    let sites = this.accepted.get(ses);
    if (!sites) {
      sites = new Set();
      this.accepted.set(ses, sites);
    }
    return sites;
  }

  needsWarning(ses, url) {
    if (classify(url) !== 'web') return false;
    const site = siteOf(url);
    return Boolean(site) && !this.sitesFor(ses).has(site);
  }

  accept(ses, url) {
    const site = siteOf(url);
    if (site) this.sitesFor(ses).add(site);
  }

  forget(ses) {
    this.accepted.delete(ses);
  }
}

class CertStore {
  constructor() {
    /** "host fingerprint" pairs the user chose to trust. */
    this.exceptions = new Set();
    this.hosts = new Set();
    /** host → the last certificate error we saw, for the warning page. */
    this.errors = new Map();
  }

  hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }

  /** Called from app 'certificate-error'. Returns true if the user already chose to proceed. */
  check(url, error, certificate) {
    const host = this.hostOf(url);
    if (!host) return false;
    const fingerprint = certificate?.fingerprint || 'unknown';
    if (this.exceptions.has(`${host} ${fingerprint}`)) return true;
    this.errors.set(host, {
      error,
      fingerprint,
      subject: certificate?.subjectName || null,
      issuer: certificate?.issuerName || null,
      validStart: certificate?.validStart ? certificate.validStart * 1000 : null,
      validExpiry: certificate?.validExpiry ? certificate.validExpiry * 1000 : null,
    });
    return false;
  }

  lastError(url) {
    const host = this.hostOf(url);
    return (host && this.errors.get(host)) || null;
  }

  allow(url) {
    const host = this.hostOf(url);
    const last = host && this.errors.get(host);
    if (!last) return false;
    this.exceptions.add(`${host} ${last.fingerprint}`);
    this.hosts.add(new URL(url).hostname);
    return true;
  }

  hasException(hostname) {
    return this.hosts.has(hostname);
  }
}

module.exports = { SecureGate, CertStore };
