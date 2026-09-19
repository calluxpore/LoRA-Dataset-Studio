'use strict';

// Datasets (main process): each dataset is a folder in the library root.
//
//   <root>/<Dataset name>/
//     images/        copies of every image added (the user's originals are never touched)
//     dataset.json   order, names, crops, captions and statuses
//
// A folder without dataset.json (e.g. an Ostris-style folder of images with same-name
// .txt captions) is opened by importing its images and captions.

const { ipcMain, dialog, shell, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');

const META_FILE = 'dataset.json';
const IMAGES_DIR = 'images';
const FORMAT_VERSION = 1;
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * @param {object} deps
 * @param {() => Promise<object>} deps.readPrefs
 * @param {(patch: object) => Promise<void>} deps.writePrefs
 * @param {() => Electron.BrowserWindow | null} deps.getWindow
 */
function registerDatasets({ readPrefs, writePrefs, getWindow }) {
  const defaultRoot = () => path.join(app.getPath('documents'), 'LoRA Dataset Studio', 'Datasets');

  async function getRoot() {
    const { datasetsRoot } = await readPrefs();
    return datasetsRoot || defaultRoot();
  }

  /** Validate a user-entered dataset name and make it safe as a folder name. */
  function cleanName(raw) {
    const name = String(raw ?? '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 80);
    if (!name || name === '.' || name === '..') throw new Error('Please enter a dataset name.');
    if (RESERVED.test(name)) throw new Error(`"${name}" is a reserved name on Windows.`);
    return name;
  }

  /** Absolute folder for a dataset, guaranteed to stay inside the library root. */
  async function dirFor(name) {
    const root = await getRoot();
    const dir = path.join(root, cleanName(name));
    const rel = path.relative(root, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Invalid dataset name.');
    return dir;
  }

  const exists = (p) => fs.access(p).then(() => true, () => false);
  const isImage = (file) => IMAGE_EXTS.has(path.extname(file).toLowerCase());

  async function readMeta(dir) {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeMeta(dir, meta) {
    const file = path.join(dir, META_FILE);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf8');
    await fs.rename(tmp, file); // atomic replace, so a crash never leaves half a file
  }

  /** Build items for a folder that has no dataset.json yet (images + same-name .txt captions). */
  async function importLooseFolder(dir) {
    const items = [];
    for (const sub of ['', IMAGES_DIR]) {
      const base = path.join(dir, sub);
      let entries = [];
      try {
        entries = await fs.readdir(base, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const e of entries) {
        if (!e.isFile() || !isImage(e.name)) continue;
        const stem = e.name.slice(0, -path.extname(e.name).length);
        let caption = '';
        try {
          caption = (await fs.readFile(path.join(base, `${stem}.txt`), 'utf8')).trim();
        } catch {
          /* no caption file */
        }
        items.push({
          file: sub ? `${sub}/${e.name}` : e.name,
          originalName: e.name,
          name: stem,
          caption,
          status: caption ? 'done' : 'queued',
        });
      }
    }
    return items;
  }

  async function listDatasets() {
    const root = await getRoot();
    await fs.mkdir(root, { recursive: true });
    const entries = await fs.readdir(root, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      const meta = await readMeta(dir);
      let count = meta?.items?.length;
      let updatedAt = meta?.updatedAt;
      if (count == null) {
        // Not created by this app yet: count images so it still shows up usefully.
        count = (await importLooseFolder(dir)).length;
        updatedAt = (await fs.stat(dir)).mtime.toISOString();
      }
      out.push({ name: e.name, count, updatedAt, managed: !!meta });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { root, datasets: out };
  }

  async function uniqueFile(dir, fileName) {
    const ext = path.extname(fileName).toLowerCase() || '.png';
    const stem =
      path
        .basename(fileName, path.extname(fileName))
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .trim()
        .slice(0, 120) || 'image';
    let candidate = `${stem}${ext}`;
    for (let n = 2; await exists(path.join(dir, candidate)); n++) candidate = `${stem}_${n}${ext}`;
    return candidate;
  }

  ipcMain.handle('datasets-info', () => listDatasets());

  ipcMain.handle('datasets-choose-root', async () => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose where datasets are stored',
      defaultPath: await getRoot(),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    await writePrefs({ datasetsRoot: res.filePaths[0] });
    return { canceled: false, ...(await listDatasets()) };
  });

  ipcMain.handle('datasets-reset-root', async () => {
    await writePrefs({ datasetsRoot: null });
    return listDatasets();
  });

  ipcMain.handle('dataset-create', async (_e, rawName) => {
    const name = cleanName(rawName);
    const dir = await dirFor(name);
    if (await exists(dir)) throw new Error(`A dataset named "${name}" already exists.`);
    await fs.mkdir(path.join(dir, IMAGES_DIR), { recursive: true });
    const now = new Date().toISOString();
    await writeMeta(dir, { version: FORMAT_VERSION, name, createdAt: now, updatedAt: now, items: [] });
    return { name, dir };
  });

  ipcMain.handle('dataset-load', async (_e, rawName) => {
    const dir = await dirFor(rawName);
    if (!(await exists(dir))) throw new Error(`Dataset "${rawName}" was not found.`);
    let meta = await readMeta(dir);
    let imported = false;
    if (!meta) {
      const now = new Date().toISOString();
      meta = { version: FORMAT_VERSION, name: path.basename(dir), createdAt: now, updatedAt: now, items: await importLooseFolder(dir) };
      await writeMeta(dir, meta);
      imported = true;
    }
    const items = [];
    let missing = 0;
    for (const it of meta.items || []) {
      const abs = path.join(dir, it.file || '');
      if (!it.file || !fsSync.existsSync(abs)) {
        missing++;
        continue;
      }
      items.push({ ...it, path: abs });
    }
    return { name: path.basename(dir), dir, items, missing, imported };
  });

  ipcMain.handle('dataset-save', async (_e, { name, items }) => {
    const dir = await dirFor(name);
    if (!(await exists(dir))) return { ok: false, error: 'Dataset folder no longer exists.' };
    const prev = (await readMeta(dir)) || {};
    const now = new Date().toISOString();
    await writeMeta(dir, { version: FORMAT_VERSION, name, createdAt: prev.createdAt || now, updatedAt: now, items });
    return { ok: true, updatedAt: now };
  });

  // Synchronous save used while the window is closing, so no edits are lost.
  ipcMain.on('dataset-save-sync', (e, { name, items }) => {
    try {
      // Read the root synchronously: this runs inside the renderer's beforeunload.
      const prefsPath = path.join(app.getPath('userData'), 'preferences.json');
      let datasetsRoot;
      try {
        datasetsRoot = JSON.parse(fsSync.readFileSync(prefsPath, 'utf8')).datasetsRoot;
      } catch {
        /* default root */
      }
      const dir = path.join(datasetsRoot || defaultRoot(), cleanName(name));
      if (!fsSync.existsSync(dir)) {
        e.returnValue = false;
        return;
      }
      const file = path.join(dir, META_FILE);
      let prev = {};
      try {
        prev = JSON.parse(fsSync.readFileSync(file, 'utf8'));
      } catch {
        /* first save */
      }
      const now = new Date().toISOString();
      const meta = { version: FORMAT_VERSION, name, createdAt: prev.createdAt || now, updatedAt: now, items };
      fsSync.writeFileSync(`${file}.tmp`, JSON.stringify(meta, null, 2), 'utf8');
      fsSync.renameSync(`${file}.tmp`, file);
      e.returnValue = true;
    } catch {
      e.returnValue = false;
    }
  });

  /** Copy image files into the dataset's images/ folder. */
  ipcMain.handle('dataset-import', async (_e, { name, paths }) => {
    const dir = await dirFor(name);
    const imagesDir = path.join(dir, IMAGES_DIR);
    await fs.mkdir(imagesDir, { recursive: true });
    const out = [];
    for (const src of paths || []) {
      try {
        if (typeof src !== 'string' || !isImage(src)) throw new Error('unsupported');
        const fileName = await uniqueFile(imagesDir, path.basename(src));
        const dest = path.join(imagesDir, fileName);
        await fs.copyFile(src, dest);
        out.push({ source: src, file: `${IMAGES_DIR}/${fileName}`, path: dest });
      } catch {
        out.push(null);
      }
    }
    return out;
  });

  /** Write in-memory image bytes (webcam captures, images dragged from a browser). */
  ipcMain.handle('dataset-write-image', async (_e, { name, fileName, data }) => {
    const dir = await dirFor(name);
    const imagesDir = path.join(dir, IMAGES_DIR);
    await fs.mkdir(imagesDir, { recursive: true });
    const safe = await uniqueFile(imagesDir, isImage(fileName || '') ? fileName : `${fileName || 'image'}.png`);
    const dest = path.join(imagesDir, safe);
    await fs.writeFile(dest, Buffer.from(data));
    return { file: `${IMAGES_DIR}/${safe}`, path: dest };
  });

  /** Remove image copies from a dataset. They go to the Recycle Bin, so they can be restored. */
  ipcMain.handle('dataset-remove-files', async (_e, { name, files }) => {
    const dir = await dirFor(name);
    let removed = 0;
    for (const rel of files || []) {
      const abs = path.join(dir, rel);
      if (path.relative(dir, abs).startsWith('..')) continue;
      try {
        await shell.trashItem(abs);
        removed++;
      } catch {
        /* already gone */
      }
      // Drop a stale same-name caption file if the folder was imported with one.
      const txt = abs.slice(0, -path.extname(abs).length) + '.txt';
      if (fsSync.existsSync(txt)) await shell.trashItem(txt).catch(() => {});
    }
    return { removed };
  });

  ipcMain.handle('dataset-rename', async (_e, { from, to }) => {
    const oldDir = await dirFor(from);
    const name = cleanName(to);
    const newDir = await dirFor(name);
    if (oldDir === newDir) return { name, dir: newDir };
    if (await exists(newDir)) throw new Error(`A dataset named "${name}" already exists.`);
    await fs.rename(oldDir, newDir);
    const meta = await readMeta(newDir);
    if (meta) await writeMeta(newDir, { ...meta, name, updatedAt: new Date().toISOString() });
    return { name, dir: newDir };
  });

  /** Delete a dataset by moving its folder to the Recycle Bin. */
  ipcMain.handle('dataset-delete', async (_e, rawName) => {
    const dir = await dirFor(rawName);
    await shell.trashItem(dir);
    return { ok: true };
  });

  ipcMain.handle('dataset-open-folder', async (_e, rawName) => {
    const dir = rawName ? await dirFor(rawName) : await getRoot();
    await fs.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });
}

module.exports = { registerDatasets };
