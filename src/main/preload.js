const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const isPrivate = process.argv.includes('--southbag-private=1');

contextBridge.exposeInMainWorld('southbag', {
  platform: process.platform,
  isPrivate,

  auth: {
    state: () => ipcRenderer.invoke('auth:state'),
    login: () => ipcRenderer.invoke('auth:login'),
    cancel: () => ipcRenderer.invoke('auth:cancel'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    onChange: (callback) => subscribe('auth:changed', callback),
  },

  tabs: {
    command: (name, ...args) => ipcRenderer.send('tab:command', name, ...args),
    onState: (callback) => subscribe('tabs:state', callback),
    menu: (id) => ipcRenderer.send('tab:menu', id),
  },

  layout: {
    content: (rect) => ipcRenderer.send('layout:content', rect),
    overlay: (open) => ipcRenderer.invoke('layout:overlay', open),
  },

  find: {
    start: (text, options) => ipcRenderer.send('find:start', text, options),
    stop: () => ipcRenderer.send('find:stop'),
    onResult: (callback) => subscribe('find:result', callback),
  },

  omnibox: {
    suggest: (text) => ipcRenderer.invoke('omnibox:suggest', text),
  },

  bookmarks: {
    list: () => ipcRenderer.invoke('bookmarks:list'),
    toggleCurrent: () => ipcRenderer.invoke('bookmarks:toggle-current'),
    open: (id, disposition) => ipcRenderer.send('bookmarks:open', id, disposition),
    menu: (id) => ipcRenderer.send('bookmarks:menu', id),
    onChange: (callback) => subscribe('bookmarks:changed', callback),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChange: (callback) => subscribe('settings:changed', callback),
  },

  kevin: {
    chat: (messages) => ipcRenderer.invoke('kevin:chat', messages),
    summarise: () => ipcRenderer.invoke('kevin:summarise'),
  },

  defaultBrowser: {
    respond: (answer, dontAskAgain) => ipcRenderer.invoke('default-browser:respond', answer, dontAskAgain),
  },

  status: {
    onHover: (callback) => subscribe('status:hover', callback),
    onUpdate: (callback) => subscribe('status:update', callback),
    get: () => ipcRenderer.invoke('status:get'),
    dismissPromo: () => ipcRenderer.send('promo:dismiss'),
  },

  appMenu: () => ipcRenderer.send('app:menu'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  onMenu: (callback) => subscribe('menu:action', callback),
  onNag: (callback) => subscribe('default-browser:nag', callback),
  onFullscreen: (callback) => subscribe('window:fullscreen', callback),
  onPending: (callback) => subscribe('pending:urls', callback),
  onDownloadStarted: (callback) => subscribe('downloads:started', callback),

  palantir: {
    capture: (event, properties) => ipcRenderer.send('palantir:capture', event, properties),
  },
});
