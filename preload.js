'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Subscribe to a main-process channel; returns an unsubscribe function. */
function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Window
  windowControl: (action) => ipcRenderer.send('window-control', action),
  isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  onWindowState: (cb) => subscribe('window-state', cb),

  // Theme: 'system' | 'light' | 'dark'
  getTheme: () => ipcRenderer.invoke('get-theme'),
  setTheme: (source) => ipcRenderer.invoke('set-theme', source),
  onThemeChanged: (cb) => subscribe('theme-changed', cb),

  // Ingestion
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  resolvePaths: (paths) => ipcRenderer.invoke('resolve-paths', paths),
  readImageFile: (filePath) => ipcRenderer.invoke('read-image-file', filePath),
  /** Absolute path of a File dropped from Explorer/Finder (File.path was removed in Electron 32). */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  requestCameraAccess: () => ipcRenderer.invoke('request-camera-access'),

  // Shell
  openInViewer: (args) => ipcRenderer.invoke('open-in-viewer', args),
  openPath: (target) => ipcRenderer.invoke('open-path', target),
  showInFolder: (target) => ipcRenderer.invoke('show-in-folder', target),

  // Ollama
  ollamaStatus: (host) => ipcRenderer.invoke('ollama-status', host),
  generateCaption: (payload) => ipcRenderer.invoke('generate-caption', payload),
  abortCaption: (id) => ipcRenderer.invoke('abort-caption', id),
  onCaptionToken: (cb) => subscribe('caption-token', cb),
  onCaptionThinking: (cb) => subscribe('caption-thinking', cb),

  // Datasets
  datasetsInfo: () => ipcRenderer.invoke('datasets-info'),
  datasetsChooseRoot: () => ipcRenderer.invoke('datasets-choose-root'),
  datasetsResetRoot: () => ipcRenderer.invoke('datasets-reset-root'),
  datasetCreate: (name) => ipcRenderer.invoke('dataset-create', name),
  datasetLoad: (name) => ipcRenderer.invoke('dataset-load', name),
  datasetSave: (payload) => ipcRenderer.invoke('dataset-save', payload),
  datasetSaveSync: (payload) => ipcRenderer.sendSync('dataset-save-sync', payload),
  datasetImport: (payload) => ipcRenderer.invoke('dataset-import', payload),
  datasetWriteImage: (payload) => ipcRenderer.invoke('dataset-write-image', payload),
  datasetRemoveFiles: (payload) => ipcRenderer.invoke('dataset-remove-files', payload),
  datasetRename: (payload) => ipcRenderer.invoke('dataset-rename', payload),
  datasetDelete: (name) => ipcRenderer.invoke('dataset-delete', name),
  datasetOpenFolder: (name) => ipcRenderer.invoke('dataset-open-folder', name),

  // Setup assistant
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  // Export
  exportBegin: (opts) => ipcRenderer.invoke('export-begin', opts),
  exportAddItem: (item) => ipcRenderer.invoke('export-add-item', item),
  exportFinish: (opts) => ipcRenderer.invoke('export-finish', opts),
  exportCancel: (opts) => ipcRenderer.invoke('export-cancel', opts),
});
