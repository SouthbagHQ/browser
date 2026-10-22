/**
 * Small JSON files in the user-data dir: settings, bookmarks, history, rewards and fees.
 * Writes are debounced so a busy browsing session doesn't hammer the disk.
 */

const fs = require('node:fs');
const path = require('node:path');

const WRITE_DELAY_MS = 500;

class JsonFile {
  constructor(dir, name, defaults) {
    this.file = path.join(dir, name);
    this.defaults = defaults;
    this.timer = undefined;
    this.data = this.load();
  }

  load() {
    const fallback = structuredClone(this.defaults);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(fallback)) return Array.isArray(saved) ? saved : fallback;
      return saved && typeof saved === 'object' ? { ...fallback, ...saved } : fallback;
    } catch {
      return fallback;
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
    } catch (error) {
      console.error(`Could not save ${this.file}:`, error.message);
    }
  }
}

const SEARCH_ENGINES = {
  duckduckgo: { name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  google: { name: 'Google', template: 'https://www.google.com/search?q=%s' },
  bing: { name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', template: 'https://search.brave.com/search?q=%s' },
  startpage: { name: 'Startpage', template: 'https://www.startpage.com/do/search?q=%s' },
  ecosia: { name: 'Ecosia', template: 'https://www.ecosia.org/search?q=%s' },
  kagi: { name: 'Kagi', template: 'https://kagi.com/search?q=%s' },
};

const DEFAULT_SETTINGS = {
  searchEngine: 'duckduckgo',
  customSearch: '',
  adBlock: true,
  browsingFees: true,
  askDefaultBrowser: true,
  showBookmarksBar: true,
  dark: false,
  askDownloadLocation: false,
};

const HISTORY_LIMIT = 5000;

class Store {
  constructor(dir) {
    this.settings = new JsonFile(dir, 'settings.json', DEFAULT_SETTINGS);
    this.bookmarks = new JsonFile(dir, 'bookmarks.json', []);
    this.history = new JsonFile(dir, 'history.json', []);
    this.rewards = new JsonFile(dir, 'rewards.json', { points: 0, secondsOnSouthbag: 0, redemptions: 0 });
    this.fees = new JsonFile(dir, 'fees.json', { lifetimeCents: 0, chargedCents: 0, pendingCents: 0, pageLoads: 0 });
  }

  get(key) {
    return this.settings.data[key];
  }

  set(patch) {
    const next = { ...this.settings.data };
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue;
      if (key === 'searchEngine' && !(value in SEARCH_ENGINES) && value !== 'custom') continue;
      if (key === 'customSearch' && value && !/^https?:\/\/.+%s/.test(value)) continue;
      next[key] = value;
    }
    this.settings.data = next;
    this.settings.save();
    return next;
  }

  searchUrl(query) {
    const { searchEngine, customSearch } = this.settings.data;
    const template =
      searchEngine === 'custom' && customSearch ? customSearch : (SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES.duckduckgo).template;
    return template.replace('%s', encodeURIComponent(query));
  }

  addHistory(url, title) {
    const list = this.history.data;
    const last = list[list.length - 1];
    if (last && last.url === url) {
      last.title = title || last.title;
      last.visitedAt = Date.now();
    } else {
      list.push({ url, title: title || url, visitedAt: Date.now() });
      if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
    }
    this.history.save();
  }

  updateHistoryTitle(url, title) {
    const list = this.history.data;
    for (let i = list.length - 1; i >= Math.max(0, list.length - 20); i -= 1) {
      if (list[i].url === url) {
        list[i].title = title;
        this.history.save();
        return;
      }
    }
  }

  flush() {
    for (const file of [this.settings, this.bookmarks, this.history, this.rewards, this.fees]) {
      if (file.timer) file.flush();
    }
  }
}

module.exports = { Store, JsonFile, SEARCH_ENGINES, DEFAULT_SETTINGS };
