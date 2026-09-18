'use strict';

// Setup assistant (main process): detect, start and install Ollama, and pull models.

const { ipcMain, shell } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const OLLAMA_DOWNLOAD_PAGE = 'https://ollama.com/download';
const OLLAMA_WINDOWS_INSTALLER = 'https://ollama.com/download/OllamaSetup.exe';

/**
 * @param {object} deps
 * @param {() => Electron.BrowserWindow | null} deps.getWindow
 * @param {(host: string) => string} deps.normalizeHost
 * @param {(url: string, opts?: object, ms?: number) => Promise<Response>} deps.fetchWithTimeout
 */
function registerOllamaSetup({ getWindow, normalizeHost, fetchWithTimeout }) {
  let installAbort = null;
  const activePulls = new Map();

  const send = (channel, data) => {
    const win = getWindow();
    if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, data);
  };

  function isLocalHost(host) {
    try {
      const { hostname } = new URL(normalizeHost(host));
      return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(hostname);
    } catch {
      return true;
    }
  }

  function candidates() {
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
      const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
      return [path.join(local, 'Programs', 'Ollama', 'ollama.exe'), path.join(programFiles, 'Ollama', 'ollama.exe')];
    }
    if (process.platform === 'darwin') {
      return [
        '/Applications/Ollama.app/Contents/Resources/ollama',
        path.join(os.homedir(), 'Applications/Ollama.app/Contents/Resources/ollama'),
        '/opt/homebrew/bin/ollama',
        '/usr/local/bin/ollama',
      ];
    }
    return ['/usr/local/bin/ollama', '/usr/bin/ollama', '/snap/bin/ollama', path.join(os.homedir(), '.local/bin/ollama')];
  }

  function whichOllama() {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, ['ollama'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const first = String(stdout)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean);
        resolve(first || null);
      });
    });
  }

  async function findExecutable() {
    for (const c of candidates()) {
      if (fsSync.existsSync(c)) return c;
    }
    return whichOllama();
  }

  async function reachable(host) {
    try {
      const res = await fetchWithTimeout(`${normalizeHost(host)}/api/version`, {}, 2500);
      if (!res.ok) return { reachable: false };
      const json = await res.json().catch(() => ({}));
      return { reachable: true, version: json.version || '' };
    } catch {
      return { reachable: false };
    }
  }

  ipcMain.handle('ollama-detect', async (_e, host) => {
    const [reach, exePath] = await Promise.all([reachable(host), findExecutable()]);
    return {
      platform: process.platform,
      local: isLocalHost(host),
      reachable: reach.reachable,
      version: reach.version || '',
      installed: !!exePath || reach.reachable,
      exePath: exePath || '',
      canAutoInstall: process.platform === 'win32',
      downloadPage: OLLAMA_DOWNLOAD_PAGE,
    };
  });

  ipcMain.handle('ollama-start', async (_e, host) => {
    const exe = await findExecutable();
    if (!exe) return { ok: false, error: 'Ollama is not installed.' };

    const detached = { detached: true, stdio: 'ignore', windowsHide: true };
    try {
      if (process.platform === 'win32') {
        // Prefer the tray app: it runs the server and keeps it alive in the background.
        const trayApp = path.join(path.dirname(exe), 'ollama app.exe');
        if (fsSync.existsSync(trayApp)) spawn(trayApp, [], detached).unref();
        else spawn(exe, ['serve'], detached).unref();
      } else if (process.platform === 'darwin' && exe.includes('Ollama.app')) {
        spawn('open', ['-a', 'Ollama'], detached).unref();
      } else {
        spawn(exe, ['serve'], detached).unref();
      }
    } catch (err) {
      return { ok: false, error: err.message };
    }

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if ((await reachable(host)).reachable) return { ok: true };
      await new Promise((r) => setTimeout(r, 750));
    }
    return { ok: false, error: 'Ollama was launched but did not respond within 30 seconds.' };
  });

  // Windows: download the official OllamaSetup.exe and launch it. The installer
  // shows its own wizard, so the user reviews and confirms the install there.
  // Other platforms: open the official download page.
  ipcMain.handle('ollama-install', async () => {
    if (process.platform !== 'win32') {
      await shell.openExternal(OLLAMA_DOWNLOAD_PAGE);
      return { ok: true, openedPage: true };
    }
    if (installAbort) return { ok: false, error: 'A download is already in progress.' };

    const target = path.join(os.tmpdir(), 'lora-dataset-studio', 'OllamaSetup.exe');
    installAbort = new AbortController();
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const res = await fetch(OLLAMA_WINDOWS_INSTALLER, { signal: installAbort.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);

      const total = Number(res.headers.get('content-length')) || 0;
      let received = 0;
      let lastSent = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastSent > 150) {
          lastSent = now;
          send('setup-progress', { phase: 'download', received, total });
        }
      });
      await pipeline(body, fsSync.createWriteStream(target));
      send('setup-progress', { phase: 'download', received, total: total || received });

      const err = await shell.openPath(target);
      if (err) throw new Error(`Could not launch the installer: ${err}`);
      return { ok: true, installerPath: target };
    } catch (err) {
      await fs.rm(target, { force: true }).catch(() => {});
      if (err.name === 'AbortError') return { ok: false, aborted: true };
      return { ok: false, error: err.message || String(err) };
    } finally {
      installAbort = null;
    }
  });

  ipcMain.handle('ollama-install-cancel', () => {
    installAbort?.abort();
    return true;
  });

  /** Pull a model through Ollama's /api/pull, streaming progress to the renderer. */
  ipcMain.handle('ollama-pull', async (_e, { model, host }) => {
    if (!model || typeof model !== 'string') throw new Error('ollama-pull: missing model');
    if (activePulls.has(model)) return { ok: false, error: 'This model is already downloading.' };

    const ctrl = new AbortController();
    activePulls.set(model, ctrl);
    try {
      const res = await fetch(`${normalizeHost(host)}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        let msg = `HTTP ${res.status}`;
        try {
          msg = JSON.parse(text).error || msg;
        } catch {
          if (text) msg = text;
        }
        throw new Error(msg);
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let lastStatus = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.error) throw new Error(msg.error);
          lastStatus = msg.status || lastStatus;
          send('pull-progress', {
            model,
            status: msg.status || '',
            digest: msg.digest || '',
            completed: msg.completed || 0,
            total: msg.total || 0,
          });
        }
      }
      if (lastStatus !== 'success') throw new Error(`Download ended unexpectedly (${lastStatus || 'no status'})`);
      return { ok: true };
    } catch (err) {
      if (err.name === 'AbortError') return { ok: false, aborted: true };
      return { ok: false, error: err.message || String(err) };
    } finally {
      activePulls.delete(model);
    }
  });

  ipcMain.handle('ollama-pull-cancel', (_e, model) => {
    activePulls.get(model)?.abort();
    return true;
  });

  ipcMain.handle('open-external', async (_e, url) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });
}

module.exports = { registerOllamaSetup };
