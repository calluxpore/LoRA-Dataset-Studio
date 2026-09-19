'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  Notification,
  systemPreferences,
  nativeTheme,
  clipboard,
} = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const JSZip = require('jszip');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** Active caption generations, keyed by queue item id, so they can be aborted. */
const activeGenerations = new Map();

/** Open export sessions (folder or zip), keyed by session id. */
const exportSessions = new Map();
let exportSessionCounter = 0;

// ---------------------------------------------------------------------------
// Theme (persisted in userData so it applies before the first paint)
// ---------------------------------------------------------------------------

const THEME_SOURCES = new Set(['system', 'light', 'dark']);
const BG_DARK = '#0f1115';
const BG_LIGHT = '#f4f5f8';

function prefsPath() {
  return path.join(app.getPath('userData'), 'preferences.json');
}

async function readPrefs() {
  try {
    return JSON.parse(await fs.readFile(prefsPath(), 'utf8'));
  } catch {
    return {};
  }
}

async function writePrefs(patch) {
  const prefs = { ...(await readPrefs()), ...patch };
  await fs.mkdir(path.dirname(prefsPath()), { recursive: true });
  await fs.writeFile(prefsPath(), JSON.stringify(prefs, null, 2), 'utf8');
}

function themeState() {
  return { source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors };
}

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT;
}

// themeSource drives prefers-color-scheme in the renderer and native dialogs/menus.
nativeTheme.on('updated', () => {
  if (!mainWindow) return;
  mainWindow.setBackgroundColor(windowBackground());
  mainWindow.webContents.send('theme-changed', themeState());
});

ipcMain.handle('get-theme', () => themeState());

ipcMain.handle('set-theme', async (_e, source) => {
  if (!THEME_SOURCES.has(source)) throw new Error(`Invalid theme: ${source}`);
  nativeTheme.themeSource = source;
  await writePrefs({ theme: source });
  return themeState();
});

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    frame: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: windowBackground(),
    show: false,
    title: 'LoRA Dataset Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const sendMaxState = () =>
    mainWindow?.webContents.send('window-state', { maximized: mainWindow.isMaximized() });
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);

  // Never let the renderer navigate away or spawn arbitrary windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.on('closed', () => {
    for (const ctrl of activeGenerations.values()) ctrl.abort();
    activeGenerations.clear();
    mainWindow = null;
  });
}

function setupPermissions() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'clipboard-sanitized-write', 'notifications']);

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const types = details.mediaTypes || [];
      // Only camera access is needed (no microphone).
      callback(types.every((t) => t === 'video'));
      return;
    }
    callback(allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.local.lora-dataset-studio');
  const { theme } = await readPrefs();
  nativeTheme.themeSource = THEME_SOURCES.has(theme) ? theme : 'system';
  setupPermissions();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Window controls
// ---------------------------------------------------------------------------

ipcMain.on('window-control', (_e, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
});

ipcMain.handle('window-is-maximized', () => !!mainWindow?.isMaximized());
ipcMain.handle('get-platform', () => process.platform);

// ---------------------------------------------------------------------------
// File system: ingestion
// ---------------------------------------------------------------------------

function isImagePath(p) {
  return IMAGE_EXTS.has(path.extname(p).toLowerCase());
}

async function walkDirectory(dir, out = [], depth = 0) {
  if (depth > 32) return out;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkDirectory(full, out, depth + 1);
    else if (entry.isFile() && isImagePath(full)) out.push(full);
  }
  return out;
}

/** Expand a mix of file and directory paths into a flat, de-duplicated list of image files. */
async function resolveImagePaths(paths) {
  const result = [];
  for (const p of paths) {
    try {
      const stat = await fs.stat(p);
      if (stat.isDirectory()) await walkDirectory(p, result);
      else if (stat.isFile() && isImagePath(p)) result.push(p);
    } catch {
      /* unreadable path: skip */
    }
  }
  return [...new Set(result)];
}

ipcMain.handle('select-files', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
  });
  if (res.canceled) return [];
  return resolveImagePaths(res.filePaths);
});

ipcMain.handle('select-directory', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select image folder',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { dir: null, files: [] };
  const dir = res.filePaths[0];
  return { dir, files: await walkDirectory(dir) };
});

ipcMain.handle('resolve-paths', async (_e, paths) => {
  if (!Array.isArray(paths)) return [];
  return resolveImagePaths(paths.filter((p) => typeof p === 'string'));
});

ipcMain.handle('read-image-file', async (_e, filePath) => {
  if (typeof filePath !== 'string' || !isImagePath(filePath)) {
    throw new Error('Unsupported file type');
  }
  const data = await fs.readFile(filePath);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
});

// ---------------------------------------------------------------------------
// Native viewer / shell helpers
// ---------------------------------------------------------------------------

ipcMain.handle('open-in-viewer', async (_e, { filePath, data, name }) => {
  let target = filePath;
  if (!target && data) {
    // In-memory items (e.g. webcam captures) are written to a temp file first.
    const safe = sanitizeFileName(name || 'capture') + '.png';
    target = path.join(os.tmpdir(), 'lora-dataset-studio', safe);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(data));
  }
  if (!target) return { ok: false, error: 'Nothing to open' };
  const err = await shell.openPath(target);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('open-path', async (_e, target) => {
  const err = await shell.openPath(target);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('show-in-folder', (_e, target) => {
  shell.showItemInFolder(target);
  return { ok: true };
});

ipcMain.handle('request-camera-access', async () => {
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('camera');
    if (status === 'granted') return true;
    return systemPreferences.askForMediaAccess('camera');
  }
  return true;
});

// ---------------------------------------------------------------------------
// Ollama proxy (runs in main: no CORS, no OLLAMA_ORIGINS needed)
// ---------------------------------------------------------------------------

function normalizeHost(host) {
  let h = (typeof host === 'string' && host.trim()) || DEFAULT_OLLAMA_HOST;
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  return h.replace(/\/+$/, '');
}

async function fetchWithTimeout(url, opts = {}, ms = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('ollama-status', async (_e, host) => {
  const base = normalizeHost(host);
  try {
    const res = await fetchWithTimeout(`${base}/api/tags`, {}, 3000);
    if (!res.ok) return { online: false, error: `HTTP ${res.status}`, models: [] };
    const json = await res.json();
    const models = await Promise.all(
      (json.models || []).map(async (m) => {
        let capabilities = Array.isArray(m.capabilities) ? m.capabilities : null;
        if (!capabilities) {
          // Older Ollama builds only expose capabilities through /api/show.
          try {
            const show = await fetchWithTimeout(
              `${base}/api/show`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: m.name }),
              },
              3000,
            );
            if (show.ok) capabilities = (await show.json()).capabilities || null;
          } catch {
            /* ignore */
          }
        }
        return {
          name: m.name,
          size: m.size,
          family: m.details?.family || '',
          parameterSize: m.details?.parameter_size || '',
          capabilities: capabilities || [],
        };
      }),
    );
    return { online: true, models };
  } catch (err) {
    return { online: false, error: err.name === 'AbortError' ? 'timeout' : err.message, models: [] };
  }
});

/**
 * Streams a caption from Ollama's /api/generate. Tokens are pushed to the
 * renderer as 'caption-token' events; the handler resolves with the final result.
 */
ipcMain.handle('generate-caption', async (event, payload) => {
  const { id, imageBase64, model, prompt, host, think, options, keepAlive } = payload || {};
  if (!id || !imageBase64 || !model) throw new Error('generate-caption: missing id, image or model');

  const base = normalizeHost(host);
  const sender = event.sender;
  const send = (channel, data) => {
    if (!sender.isDestroyed()) sender.send(channel, data);
  };

  activeGenerations.get(id)?.abort();
  const ctrl = new AbortController();
  activeGenerations.set(id, ctrl);

  const body = {
    model,
    prompt: prompt || 'Describe this image.',
    images: [imageBase64],
    stream: true,
    options: options || {},
  };
  if (typeof think === 'boolean') body.think = think;
  if (keepAlive) body.keep_alive = keepAlive;

  let text = '';
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try {
        msg = JSON.parse(errText).error || msg;
      } catch {
        if (errText) msg = errText;
      }
      throw new Error(msg);
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        if (msg.thinking) send('caption-thinking', { id, token: msg.thinking });
        if (msg.response) {
          text += msg.response;
          send('caption-token', { id, token: msg.response });
        }
        if (msg.done) {
          return {
            ok: true,
            id,
            text,
            stats: {
              evalCount: msg.eval_count,
              totalDurationMs: msg.total_duration ? Math.round(msg.total_duration / 1e6) : undefined,
            },
          };
        }
      }
    }
    return { ok: true, id, text };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, id, aborted: true, text };
    return { ok: false, id, error: err.message || String(err), text };
  } finally {
    if (activeGenerations.get(id) === ctrl) activeGenerations.delete(id);
  }
});

ipcMain.handle('abort-caption', (_e, id) => {
  if (id === '*') {
    for (const ctrl of activeGenerations.values()) ctrl.abort();
    activeGenerations.clear();
    return true;
  }
  const ctrl = activeGenerations.get(id);
  if (ctrl) ctrl.abort();
  return !!ctrl;
});

// ---------------------------------------------------------------------------
// Export: folder or zip, streamed item by item from the renderer
// ---------------------------------------------------------------------------

function sanitizeFileName(name) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  const result = cleaned || 'image';
  return reserved.test(result) ? `_${result}` : result.slice(0, 180);
}

function uniqueName(base, used) {
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) name = `${base}_${n++}`;
  used.add(name.toLowerCase());
  return name;
}

ipcMain.handle('export-begin', async (_e, { mode, format }) => {
  const ext = format === 'jpg' ? 'jpg' : 'png';
  let target;

  if (mode === 'zip') {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save dataset as ZIP',
      defaultPath: `dataset_${new Date().toISOString().slice(0, 10)}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    target = res.filePath;
  } else {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose export folder',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    target = res.filePaths[0];
    await fs.mkdir(target, { recursive: true });
  }

  const sessionId = `exp_${++exportSessionCounter}`;
  exportSessions.set(sessionId, {
    mode: mode === 'zip' ? 'zip' : 'folder',
    ext,
    target,
    zip: mode === 'zip' ? new JSZip() : null,
    used: new Set(),
    count: 0,
    firstFile: null,
  });
  return { canceled: false, sessionId, target };
});

ipcMain.handle('export-add-item', async (_e, { sessionId, name, data, caption }) => {
  const s = exportSessions.get(sessionId);
  if (!s) throw new Error('Unknown export session');

  const base = uniqueName(sanitizeFileName(name), s.used);
  const imageName = `${base}.${s.ext}`;
  const textName = `${base}.txt`;
  const imageBuf = Buffer.from(data);
  const text = typeof caption === 'string' ? caption : '';

  if (s.mode === 'zip') {
    s.zip.file(imageName, imageBuf);
    s.zip.file(textName, text);
  } else {
    await fs.writeFile(path.join(s.target, imageName), imageBuf);
    await fs.writeFile(path.join(s.target, textName), text, 'utf8');
    if (!s.firstFile) s.firstFile = path.join(s.target, imageName);
  }
  s.count++;
  return { ok: true, fileName: imageName };
});

ipcMain.handle('export-finish', async (_e, { sessionId }) => {
  const s = exportSessions.get(sessionId);
  if (!s) throw new Error('Unknown export session');
  exportSessions.delete(sessionId);

  if (s.mode === 'zip') {
    const buf = await s.zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });
    await fs.writeFile(s.target, buf);
  }

  if (Notification.isSupported()) {
    const n = new Notification({
      title: 'Dataset export complete',
      body: `${s.count} image/caption pair${s.count === 1 ? '' : 's'} written to ${s.target}`,
    });
    n.on('click', () => {
      if (s.mode === 'zip') shell.showItemInFolder(s.target);
      else shell.openPath(s.target);
    });
    n.show();
  }

  return { ok: true, target: s.target, mode: s.mode, count: s.count };
});

ipcMain.handle('export-cancel', (_e, { sessionId }) => {
  exportSessions.delete(sessionId);
  return true;
});

// Setup assistant: copy commands with the native clipboard (works even if the window isn't focused).
ipcMain.handle('copy-text', (_e, text) => {
  if (typeof text !== 'string') return false;
  clipboard.writeText(text);
  return true;
});

// Setup assistant links (e.g. ollama.com/download) open in the default browser.
ipcMain.handle('open-external', async (_e, url) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});
