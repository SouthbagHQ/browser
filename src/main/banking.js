/**
 * Southbag Online Banking, the same way Southbag Mobile talks to it: the Identity access token
 * goes to banking.southbag.cc as `Authorization: Bearer …` (see banking/worker.js `session()`).
 * Calls come from the main process, so there is no Origin header and no CORS to negotiate.
 *
 *   GET  /api/account   → { user, balance (cents), transactions }
 *   POST /api/chat      { messages } → { choices: [{ message: { content } }] }
 *   POST /api/economy   { action: 'fee', amount (dollars), reason } → { ok, text, balance }
 */

const BANKING_URL = process.env.SOUTHBAG_BANKING_URL || 'https://banking.southbag.cc';
const REQUEST_TIMEOUT_MS = 20_000;
const CHAT_TIMEOUT_MS = 60_000;

class BankingError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BankingError';
    this.status = status;
  }
}

class Banking {
  /**
   * @param {object} options
   * @param {() => Promise<string|null>} options.token  current Identity access token, refreshed if needed
   * @param {() => Promise<void>} [options.refresh]    force a token refresh after a 401
   */
  constructor({ token, refresh }) {
    this.token = token;
    this.refresh = refresh || (async () => {});
    this.cache = new Map();
  }

  async request(pathname, { method = 'GET', body, timeout = REQUEST_TIMEOUT_MS, retried = false } = {}) {
    const token = await this.token();
    if (!token) throw new BankingError('Not logged in', 401);
    let response;
    try {
      response = await fetch(`${BANKING_URL}${pathname}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new BankingError(`Could not reach Southbag Online Banking: ${error.message}`, 0);
    }
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {}
    if (response.status === 401 && !retried) {
      await this.refresh().catch(() => {});
      return this.request(pathname, { method, body, timeout, retried: true });
    }
    if (!response.ok) throw new BankingError(data.error || `Banking said ${response.status}`, response.status);
    return data;
  }

  /** Balance and recent transactions, cached briefly because every new tab asks. */
  async account({ fresh = false } = {}) {
    const cached = this.cache.get('account');
    if (!fresh && cached && Date.now() - cached.at < 30_000) return cached.value;
    const value = await this.request('/api/account');
    this.cache.set('account', { at: Date.now(), value });
    return value;
  }

  async chat(messages) {
    const data = await this.request('/api/chat', { method: 'POST', body: { messages }, timeout: CHAT_TIMEOUT_MS });
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new BankingError('Kevin said nothing', 502);
    return content;
  }

  /** The economy's generic `fee` action. `amount` is in dollars, as the economy expects. */
  async fee(cents, reason) {
    const result = await this.request('/api/economy', {
      method: 'POST',
      body: { action: 'fee', amount: cents / 100, reason },
    });
    this.cache.delete('account');
    if (result.ok === false) throw new BankingError(result.text || result.error || 'Fee rejected', 400);
    return result;
  }

  clear() {
    this.cache.clear();
  }
}

/**
 * Browsing fees: one cent per page load, batched into a single economy `fee` every so often so
 * the bank isn't hit on every click. Everything is also tracked locally, so the ticker keeps
 * counting even when the bank is unreachable. Kevin never forgets a debt.
 */
const FEE_CENTS = 1;
const FLUSH_MS = 20_000;

class FeeMeter {
  constructor({ banking, file, enabled, onChange, track }) {
    this.banking = banking;
    this.file = file;
    this.enabled = enabled;
    this.onChange = onChange || (() => {});
    this.track = track || (() => {});
    this.sessionCents = 0;
    this.lastError = null;
    this.flushing = null;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  get state() {
    const data = this.file.data;
    return {
      enabled: this.enabled(),
      perPageCents: FEE_CENTS,
      sessionCents: this.sessionCents,
      pendingCents: data.pendingCents,
      chargedCents: data.chargedCents,
      lifetimeCents: data.lifetimeCents,
      pageLoads: data.pageLoads,
      lastError: this.lastError,
    };
  }

  pageLoaded() {
    if (!this.enabled()) return;
    const data = this.file.data;
    data.pendingCents += FEE_CENTS;
    data.lifetimeCents += FEE_CENTS;
    data.pageLoads += 1;
    this.sessionCents += FEE_CENTS;
    this.file.save();
    this.onChange(this.state);
  }

  async flush() {
    if (this.flushing) return this.flushing;
    const cents = this.file.data.pendingCents;
    if (!cents) return;
    this.flushing = (async () => {
      try {
        const loads = Math.max(1, Math.round(cents / FEE_CENTS));
        await this.banking.fee(cents, `Southbag Browser: ${loads} page load fee${loads === 1 ? '' : 's'} (open web surcharge)`);
        this.file.data.pendingCents -= cents;
        this.file.data.chargedCents += cents;
        this.lastError = null;
        this.track('browser_fees_charged', { cents, page_loads: loads });
      } catch (error) {
        this.lastError = error.message;
        this.track('browser_fees_charge_failed', { status: error.status ?? null, cents });
      } finally {
        this.file.save();
        this.flushing = null;
        this.onChange(this.state);
      }
    })();
    return this.flushing;
  }

  stop() {
    clearInterval(this.timer);
  }
}

module.exports = { Banking, BankingError, FeeMeter, BANKING_URL, FEE_CENTS };
