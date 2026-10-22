/**
 * Preload for every tab. Ordinary web pages get nothing at all: the API below only exists on
 * Southbag's own southbag:// pages, and main.js checks the sender's URL again on every call.
 */
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'southbag:') {
  const call = (method, ...args) => ipcRenderer.invoke('internal', method, ...args);
  const listeners = new Map();
  ipcRenderer.on('internal:event', (_event, name, payload) => {
    for (const callback of listeners.get(name) || []) callback(payload);
  });
  const on = (name, callback) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return () => listeners.get(name).delete(callback);
  };

  contextBridge.exposeInMainWorld('southbag', {
    call,
    on,
    capture: (event, properties) => ipcRenderer.send('internal:capture', event, properties),
  });
}
