// LoRA Dataset Studio — renderer
// UI state, Cropper.js binding, ingestion, batch captioning sequencer, and export.

import { renderIcons, iconSvg, setIcon } from './icons.js';
import { createSetupAssistant, modelMatches } from './setup.js';

const api = window.electronAPI;
const Cropper = window.Cropper;

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'minicpm-v4.6';
const DEFAULT_PROMPT =
  'Write one detailed caption for this image to be used as training data for a text-to-image diffusion model. ' +
  'Describe the main subject, their appearance, clothing, pose and expression, the setting and background, ' +
  'lighting, colors, composition, camera angle, and the art style or medium. ' +
  'Use plain descriptive phrases separated by commas. Do not begin with "This image shows" or mention the image itself. ' +
  'Output only the caption.';
const SETTINGS_KEY = 'lds.settings.v1';
const STATUS_POLL_MS = 15000;
const THUMB_MAX = 420;

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function toInt(value, fallback, lo = -Infinity, hi = Infinity) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

function splitExt(fileName) {
  const i = fileName.lastIndexOf('.');
  if (i <= 0) return { stem: fileName, ext: '' };
  return { stem: fileName.slice(0, i), ext: fileName.slice(i + 1).toLowerCase() };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Simple promise concurrency limiter. */
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

const decodeLimit = createLimiter(3);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  items: [],
  byId: new Map(),
  selectedId: null, // primary item: shown in the crop workspace
  multi: new Set(), // multi-selection (Ctrl/Shift+click, Ctrl+A, drag box)
  anchorId: null, // anchor for Shift+click range selection
  nextId: 1,
  view: 'grid',
  filter: '',
  ollama: { online: false, checking: false, models: [], capabilities: new Map() },
  batch: { running: false, pauseRequested: false, currentId: null, attempted: new Set(), errors: 0 },
  webcam: { stream: null },
  dataset: null, // { name, dir } of the open dataset
  crop: { cropper: null, host: null, itemId: null },
  settings: loadSettings(),
};

function defaultSettings() {
  return {
    width: 512,
    height: 512,
    autoWidth: false,
    autoHeight: false,
    ratioW: 1,
    ratioH: 1,
    freeform: false,
    snap8: false,
    renamePrefix: 'subject_v1',
    renameStart: 1,
    renamePad: 3,
    prompt: DEFAULT_PROMPT,
    captionPrefix: '',
    temperature: 0.2,
    captionMaxDim: 896,
    singleLine: true,
    skipDone: true,
    host: 'http://localhost:11434',
    model: DEFAULT_MODEL,
    exportFormat: 'png',
    view: 'grid',
    collapsedPanels: [],
    lastDataset: null,
    showSetupOnLaunch: true,
  };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    /* ignore corrupted settings */
  }
  return defaultSettings();
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch {
      /* storage unavailable */
    }
  }, 250);
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const el = {};
function cacheDom() {
  const ids = [
    'ollamaDot', 'ollamaLabel', 'modelSelect', 'refreshModelsBtn', 'startBatchBtn', 'pauseBatchBtn',
    'exportFormat', 'exportFolderBtn', 'exportZipBtn', 'offlineBanner', 'bannerMsg', 'bannerSetupBtn', 'openSetupBtn', 'retryOllamaBtn',
    'selectFilesBtn', 'selectDirBtn', 'webcamToggleBtn', 'webcamPanel', 'webcamVideo', 'webcamFlash',
    'webcamDevice', 'captureBtn', 'dropzone', 'outWidth', 'outHeight', 'autoWidth', 'autoHeight',
    'ratioW', 'ratioH', 'snap8', 'ratioPresets', 'cropWorkspace', 'cropEmpty', 'sidebarCropStage',
    'sidebarCropImg', 'expandCropBtn', 'cropInfo', 'applyCropBtn', 'batchCropBtn', 'resetCropBtn',
    'renamePrefix', 'renameStart', 'renamePad', 'renamePreview', 'applyRenameBtn', 'captionPrompt', 'captionPresets', 'presetHint',
    'captionPrefix', 'captionTemp', 'captionMaxDim', 'captionSingleLine', 'captionSkipDone', 'ollamaHost',
    'statTotal', 'statDone', 'statProc', 'statErr', 'batchProgressFill', 'queueFilter', 'viewToggle',
    'clearQueueBtn', 'queueScroll', 'queueEmpty', 'queue', 'cropModal', 'cropModalName', 'closeCropModalBtn',
    'modalCropImg', 'modalCropInfo', 'modalPrevBtn', 'modalNextBtn', 'modalResetBtn', 'modalApplyBtn',
    'dropOverlay', 'toasts', 'cardTemplate', 'maxIcon', 'windowControls',
    'datasetNameInput', 'datasetSubmitBtn', 'datasetCancelBtn', 'datasetList', 'datasetOpenFolderBtn', 'datasetRenameBtn',
    'datasetDeleteBtn', 'datasetSaveState', 'openSettingsBtn', 'settingsModal', 'settingsCloseBtn', 'settingsDoneBtn',
    'settingsRootPath', 'settingsChangeRootBtn', 'settingsOpenRootBtn', 'settingsResetRootBtn', 'dropTargetModal',
    'dropTargetTitle', 'dropTargetSummary', 'dropTargetOptions', 'dropTargetList', 'dropNewName', 'dropTargetAddBtn',
    'dropTargetCancelBtn', 'dropTargetCloseBtn',
    'selectionBar', 'selCount', 'selCropBtn', 'selApplyCropBtn', 'selCaptionBtn', 'selDeleteBtn', 'selClearBtn',
  ];
  for (const id of ids) el[id] = document.getElementById(id);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, { type = 'info', timeout = 4500, action } = {}) {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  const msg = document.createElement('div');
  msg.className = 'toast-msg';
  msg.textContent = message;
  node.appendChild(msg);

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-small btn-accent';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      close();
    });
    node.appendChild(btn);
  }
  const x = document.createElement('button');
  x.className = 'icon-btn';
  x.innerHTML = iconSvg('x', 14);
  x.addEventListener('click', () => close());
  node.appendChild(x);

  el.toasts.appendChild(node);
  let timer = timeout ? setTimeout(close, timeout) : null;

  function close() {
    clearTimeout(timer);
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  }
  return {
    update(text, opts = {}) {
      msg.textContent = text;
      if (opts.type) node.className = `toast ${opts.type}`;
      if (opts.timeout) {
        clearTimeout(timer);
        timer = setTimeout(close, opts.timeout);
      }
    },
    close,
  };
}

// ---------------------------------------------------------------------------
// Output geometry
// ---------------------------------------------------------------------------

/** Aspect ratio the crop box is locked to (NaN = free). */
function cropAspect() {
  const s = state.settings;
  if (!s.freeform) return s.ratioW / s.ratioH;
  // Freeform with both dimensions fixed still needs to match W:H to avoid distortion.
  if (!s.autoWidth && !s.autoHeight) return s.width / s.height;
  return NaN;
}

function snap(v) {
  return state.settings.snap8 ? Math.max(8, Math.round(v / 8) * 8) : Math.max(1, Math.round(v));
}

/**
 * Given a crop rect (natural px), compute the output size from the current
 * resize settings, trimming the crop (centered) if its aspect differs from the
 * target so the image is never stretched.
 */
function finalizeCrop(rect, item) {
  const s = state.settings;
  let { x, y, width: cw, height: ch } = rect;
  cw = clamp(Math.round(cw), 1, item.naturalW);
  ch = clamp(Math.round(ch), 1, item.naturalH);
  x = clamp(Math.round(x), 0, item.naturalW - cw);
  y = clamp(Math.round(y), 0, item.naturalH - ch);

  let outW;
  let outH;
  if (s.autoWidth && s.autoHeight) {
    outW = snap(cw);
    outH = snap(ch);
  } else if (s.autoWidth) {
    outH = snap(s.height);
    outW = snap((s.height * cw) / ch);
  } else if (s.autoHeight) {
    outW = snap(s.width);
    outH = snap((s.width * ch) / cw);
  } else {
    outW = snap(s.width);
    outH = snap(s.height);
  }

  const target = outW / outH;
  const current = cw / ch;
  if (Math.abs(current - target) / target > 0.002) {
    if (current > target) {
      const nw = Math.max(1, Math.round(ch * target));
      x += Math.round((cw - nw) / 2);
      cw = nw;
    } else {
      const nh = Math.max(1, Math.round(cw / target));
      y += Math.round((ch - nh) / 2);
      ch = nh;
    }
  }
  return { crop: { x, y, width: cw, height: ch }, outW, outH };
}

function centerCropRect(item, aspect) {
  const W = item.naturalW;
  const H = item.naturalH;
  if (!Number.isFinite(aspect)) return { x: 0, y: 0, width: W, height: H };
  if (W / H > aspect) {
    const w = Math.round(H * aspect);
    return { x: Math.round((W - w) / 2), y: 0, width: w, height: H };
  }
  const h = Math.round(W / aspect);
  return { x: 0, y: Math.round((H - h) / 2), width: W, height: h };
}

function itemRegion(item) {
  return item.crop || { x: 0, y: 0, width: item.naturalW, height: item.naturalH };
}

/**
 * Render an item's cropped + resized output to a canvas. maxDim optionally
 * caps the longest side (used for thumbnails and for the captioning payload).
 */
async function renderItem(item, { maxDim = 0, background = null } = {}) {
  const region = itemRegion(item);
  let w = item.outW;
  let h = item.outH;
  if (maxDim && Math.max(w, h) > maxDim) {
    const k = maxDim / Math.max(w, h);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }

  const full = await createImageBitmap(item.blob);
  let resized;
  try {
    resized = await createImageBitmap(full, region.x, region.y, region.width, region.height, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    });
  } finally {
    full.close();
  }

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(resized, 0, 0);
  resized.close();
  return canvas;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encoding failed'))), type, quality),
  );
}

async function refreshThumb(item) {
  const canvas = await decodeLimit(() => renderItem(item, { maxDim: THUMB_MAX }));
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.85);
  if (!state.byId.has(item.id)) return;
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  item.thumbUrl = URL.createObjectURL(blob);
  if (item.refs) item.refs.thumb.src = item.thumbUrl;
}

// ---------------------------------------------------------------------------
// Queue items & cards
// ---------------------------------------------------------------------------

/**
 * Add an image to the queue.
 * @param {Blob} blob
 * @param {object} opts
 * @param {string|null} opts.sourcePath  absolute path of the file on disk (the dataset copy)
 * @param {string} opts.fileName         display / original file name
 * @param {string|null} opts.file        path relative to the dataset folder, e.g. "images/a.png"
 * @param {string|null} opts.origin      where the image was imported from (used to skip duplicates)
 * @param {object|null} opts.restore     saved state when reopening a dataset
 */
async function addItemFromBlob(blob, { sourcePath = null, fileName, sourceFormat, file = null, origin = null, restore = null }) {
  let bmp;
  try {
    bmp = await decodeLimit(() => createImageBitmap(blob));
  } catch {
    throw new Error(`Could not decode ${fileName}`);
  }
  const { stem, ext } = splitExt(fileName);
  const item = {
    id: `it${state.nextId++}`,
    sourcePath,
    originalName: fileName,
    name: stem,
    sourceFormat: (sourceFormat || ext || 'png').replace('jpeg', 'jpg'),
    blob,
    url: URL.createObjectURL(blob),
    naturalW: bmp.width,
    naturalH: bmp.height,
    crop: null,
    outW: bmp.width,
    outH: bmp.height,
    caption: '',
    status: 'queued',
    error: '',
    thumbUrl: null,
    genId: null,
    genSeq: 0,
    refs: null,
    file,
    origin,
  };
  bmp.close();

  if (restore) {
    item.originalName = restore.originalName || item.originalName;
    item.name = restore.name || item.name;
    item.caption = restore.caption || '';
    item.status = ['done', 'error'].includes(restore.status) ? restore.status : 'queued';
    if (restore.crop && restore.outW && restore.outH) {
      item.crop = restore.crop;
      item.outW = restore.outW;
      item.outH = restore.outH;
    }
  }

  state.items.push(item);
  state.byId.set(item.id, item);
  createCard(item);
  refreshThumb(item).catch(() => {});
  return item;
}

function createCard(item) {
  const node = el.cardTemplate.content.firstElementChild.cloneNode(true);
  renderIcons(node);
  node.dataset.id = item.id;

  const refs = {
    root: node,
    thumb: $('.thumb-img', node),
    status: $('.status-pill', node),
    cropBadge: $('.crop-badge', node),
    name: $('.card-name', node),
    dims: $('.card-dims', node),
    caption: $('.caption', node),
    count: $('.char-count', node),
    regen: $('.act-regen', node),
    view: $('.act-view', node),
    del: $('.act-delete', node),
  };
  item.refs = refs;
  if (item.url) refs.thumb.src = item.url; // shows full image until the cropped thumbnail is ready

  $('.card-thumb', node).addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return; // modifier clicks only change the selection
    selectItem(item.id);
    openCropModal();
  });
  node.addEventListener('mousedown', (e) => onCardMouseDown(e, item));
  node.addEventListener('keydown', (e) => {
    if (e.target !== node) return;
    if (e.key === 'Enter') {
      selectItem(item.id);
      openCropModal();
    } else if (e.key === 'Delete') {
      deleteSelectionOr(item.id);
    }
  });

  refs.caption.addEventListener('input', () => {
    item.caption = refs.caption.value;
    updateCharCount(item);
    scheduleStepUpdate();
    scheduleDatasetSave();
  });
  refs.caption.addEventListener('focus', () => selectItem(item.id, { scroll: false }));

  refs.regen.addEventListener('click', (e) => {
    e.stopPropagation();
    regenerateItem(item.id);
  });
  refs.view.addEventListener('click', (e) => {
    e.stopPropagation();
    openInViewer(item);
  });
  refs.del.addEventListener('click', (e) => {
    e.stopPropagation();
    removeItem(item.id);
  });

  updateCard(item);
  el.queue.appendChild(node);
  applyFilterTo(item);
}

function updateCard(item) {
  const r = item.refs;
  if (!r) return;
  const ext = state.settings.exportFormat;
  r.name.textContent = `${item.name}.${ext}`;
  r.name.title = item.sourcePath ? `${item.sourcePath}\n→ ${item.name}.${ext}` : `${item.name}.${ext}`;
  const fmt = item.sourceFormat.toUpperCase();
  r.dims.textContent = `${item.outW}×${item.outH} · ${fmt === ext.toUpperCase() ? fmt : `${fmt}→${ext.toUpperCase()}`}`;
  r.cropBadge.classList.toggle('hidden', !item.crop);
  if (r.caption.value !== item.caption && document.activeElement !== r.caption) {
    r.caption.value = item.caption;
  }
  setStatus(item, item.status, item.error);
  r.view.disabled = false;
}

const STATUS_LABELS = { queued: 'Queued', processing: 'Processing...', done: 'Done', error: 'Error' };

function setStatus(item, status, error = '') {
  item.status = status;
  item.error = error;
  const r = item.refs;
  if (r) {
    r.status.textContent = STATUS_LABELS[status];
    r.status.className = `pill status-pill ${status}`;
    r.status.title = error || '';
    r.root.classList.remove('status-queued', 'status-processing', 'status-done', 'status-error');
    r.root.classList.add(`status-${status}`);
    r.caption.classList.toggle('streaming', status === 'processing');
    r.regen.innerHTML = iconSvg(status === 'processing' ? 'stop' : 'sparkles');
    r.regen.title = status === 'processing' ? 'Stop generation' : 'Regenerate caption';
    updateCharCount(item);
  }
  updateStats();
}

function updateCharCount(item) {
  const r = item.refs;
  if (!r) return;
  if (item.status === 'error' && item.error) {
    r.count.textContent = item.error;
    r.count.title = item.error;
    r.count.classList.add('error');
    return;
  }
  r.count.classList.remove('error');
  r.count.title = '';
  const words = item.caption.trim() ? item.caption.trim().split(/\s+/).length : 0;
  r.count.textContent = `${item.caption.length} chars · ${words} words`;
}

function updateStats() {
  let done = 0;
  let proc = 0;
  let err = 0;
  for (const it of state.items) {
    if (it.status === 'done') done++;
    else if (it.status === 'processing') proc++;
    else if (it.status === 'error') err++;
  }
  const total = state.items.length;
  el.statTotal.textContent = total;
  el.statDone.textContent = done;
  el.statProc.textContent = proc;
  el.statErr.textContent = err;
  el.batchProgressFill.style.width = total ? `${(done / total) * 100}%` : '0%';
  el.queueEmpty.classList.toggle('hidden', total > 0);
  updateRenamePreview();
  scheduleStepUpdate();
  scheduleDatasetSave();
}

// ---------------------------------------------------------------------------
// Workflow steps: sidebar panels highlight while their step is still to do
// ---------------------------------------------------------------------------

const STEP_ORDER = ['dataset', 'ingest', 'crop', 'rename', 'caption'];
let stepUpdateQueued = false;

/** Queue progress in one pass, derived from the items so it stays correct as they change. */
function computeProgress() {
  // Renamed = follows the current template (prefix + zero-padded number). Gaps left by
  // deleted images still count; a changed prefix/padding or a newly added image does not.
  const prefix = state.settings.renamePrefix.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${prefix ? `${prefix}_` : ''}\\d{${state.settings.renamePad},}$`);
  const p = { total: state.items.length, cropped: 0, renamed: 0, captioned: 0, ready: 0, processing: 0, failed: 0 };
  for (const it of state.items) {
    const cropped = !!it.crop;
    const renamed = pattern.test(it.name);
    const captioned = it.status !== 'processing' && !!it.caption.trim();
    p.cropped += cropped;
    p.renamed += renamed;
    p.captioned += captioned;
    p.ready += cropped && renamed && captioned;
    if (it.status === 'processing') p.processing++;
    else if (it.status === 'error') p.failed++;
  }
  p.selected = state.multi.size;
  return p;
}

function computeSteps(p = computeProgress()) {
  const n = p.total;
  return {
    dataset: { done: !!state.dataset, count: 0, total: 0, what: '' },
    ingest: { done: n > 0, count: n, total: n, what: 'images added' },
    crop: { done: n > 0 && p.cropped === n, count: p.cropped, total: n, what: 'cropped' },
    rename: { done: n > 0 && p.renamed === n, count: p.renamed, total: n, what: 'renamed' },
    caption: { done: n > 0 && p.captioned === n, count: p.captioned, total: n, what: 'captioned' },
  };
}

/** Bottom status bar: a plain-language summary of the dataset. */
function updateStatusBar(p) {
  const bar = document.getElementById('statusStats');
  if (!bar) return;
  if (!state.dataset) {
    bar.innerHTML = `<span class="sb-item sb-empty">${iconSvg('database', 13)}No dataset open. Create one in step 1 to get started</span>`;
    return;
  }
  const datasetItem = `<span class="sb-item accent" title="Current dataset">${iconSvg('database', 13)}<span><b>${escapeHtml(state.dataset.name)}</b></span></span>`;
  if (!p.total) {
    bar.innerHTML = `${datasetItem}<span class="sb-sep"></span><span class="sb-item sb-empty">${iconSvg('images', 13)}No images yet. Add some in step 2</span>`;
    return;
  }
  const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;
  const progress = (icon, count, verb) =>
    ({ icon, cls: count === p.total ? 'complete' : '', html: `<b>${count}</b> of ${p.total} ${verb}`, title: `${count} of ${p.total} images ${verb}` });

  const items = [
    { icon: 'images', html: `<b>${p.total}</b> ${plural(p.total, 'image')}`, title: 'Images in the queue' },
    progress('crop', p.cropped, 'cropped'),
    progress('tag', p.renamed, 'renamed'),
    progress('message', p.captioned, 'captioned'),
  ];
  if (p.processing) items.push({ icon: 'sparkles', cls: 'busy', html: `<b>${p.processing}</b> captioning…`, title: 'Captions being generated' });
  if (p.failed) items.push({ icon: 'alert', cls: 'warn', html: `<b>${p.failed}</b> failed`, title: 'Captions that failed. Use ✦ on the card to retry' });
  items.push({
    icon: 'folderOut',
    cls: p.ready === p.total ? 'complete' : '',
    html: p.ready === p.total ? 'All ready to export' : `<b>${p.ready}</b> ready to export`,
    title: 'Images that are cropped, renamed and captioned',
  });
  if (p.selected > 1) items.push({ icon: 'check', cls: 'accent', html: `<b>${p.selected}</b> selected`, title: 'Selected images' });

  const rendered = items.map(
    (it) => `<span class="sb-item ${it.cls || ''}" title="${escapeHtml(it.title)}">${iconSvg(it.icon, 13)}<span>${it.html}</span></span>`,
  );
  bar.innerHTML = [datasetItem, ...rendered].join('<span class="sb-sep"></span>');
}

function scheduleStepUpdate() {
  if (stepUpdateQueued) return;
  stepUpdateQueued = true;
  requestAnimationFrame(() => {
    stepUpdateQueued = false;
    updateStepStates();
  });
}

function updateStepStates() {
  const progress = computeProgress();
  updateStatusBar(progress);
  const steps = computeSteps(progress);
  STEP_ORDER.forEach((key, i) => {
    const panel = document.querySelector(`.sidebar .panel[data-panel="${key}"]`);
    if (!panel) return;
    const s = steps[key];
    panel.classList.toggle('step-done', s.done);
    panel.classList.toggle('step-pending', !s.done);

    const badge = panel.querySelector('.step-badge');
    const label = panel.querySelector('.step-state');
    const header = panel.querySelector('.panel-header');
    if (s.done) {
      badge.innerHTML = iconSvg('check', 12);
      label.textContent = key === 'dataset' ? state.dataset.name : 'Done';
    } else {
      badge.textContent = String(i + 1);
      label.textContent = key === 'dataset' ? 'Start here' : key === 'ingest' ? '' : s.total ? `${s.count}/${s.total}` : '';
    }
    header.title =
      key === 'dataset'
        ? s.done
          ? `Dataset: ${state.dataset.name}`
          : 'Create or open a dataset to start'
        : key === 'ingest'
        ? s.done
          ? `${s.total} image${s.total === 1 ? '' : 's'} in the queue`
          : 'Add images to start'
        : s.total
          ? `${s.count} of ${s.total} images ${s.what}`
          : 'Add images first';
  });
}

function applyFilterTo(item) {
  const q = state.filter;
  const match =
    !q || item.name.toLowerCase().includes(q) || item.caption.toLowerCase().includes(q) ||
    item.originalName.toLowerCase().includes(q);
  item.refs?.root.classList.toggle('hidden', !match);
}

function selectItem(id, { scroll = true } = {}) {
  if (!state.byId.has(id)) return;
  if (state.selectedId === id && state.crop.itemId === id) return;
  const prev = state.byId.get(state.selectedId);
  prev?.refs?.root.classList.remove('selected');
  state.selectedId = id;
  const item = state.byId.get(id);
  item.refs.root.classList.add('selected');
  if (scroll) item.refs.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const host = el.cropModal.classList.contains('hidden') ? 'sidebar' : 'modal';
  mountCropper(host, item);
  el.applyCropBtn.disabled = false;
  el.resetCropBtn.disabled = false;
}

function removeItem(id) {
  removeItems([id]);
}

/** Remove several items at once (the crop workspace is re-mounted only once). */
function removeItems(ids) {
  const doomed = new Set(ids.filter((id) => state.byId.has(id)));
  if (!doomed.size) return;
  const primaryIdx = state.items.findIndex((it) => it.id === state.selectedId);

  const files = [...doomed].map((id) => state.byId.get(id).file).filter(Boolean);
  if (state.dataset && files.length) {
    api.datasetRemoveFiles({ name: state.dataset.name, files }).catch((err) => toast(`Could not remove files: ${err.message}`, { type: 'error' }));
  }

  for (const id of doomed) {
    const item = state.byId.get(id);
    if (item.status === 'processing' && item.genId) api.abortCaption(item.genId);
    state.byId.delete(id);
    item.refs?.root.remove();
    if (item.url) URL.revokeObjectURL(item.url);
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    state.multi.delete(id);
    if (state.anchorId === id) state.anchorId = null;
  }
  state.items = state.items.filter((it) => !doomed.has(it.id));

  if (doomed.has(state.selectedId)) {
    state.selectedId = null;
    const next = state.items[Math.min(primaryIdx, state.items.length - 1)];
    if (next) selectItem(next.id, { scroll: false });
    else {
      unmountCropper();
      closeCropModal();
    }
  }
  updateSelectionUI();
  updateStats();
}

function clearQueue() {
  if (!state.items.length) return;
  const where = state.dataset ? `from "${state.dataset.name}"` : 'from the queue';
  if (!confirm(`Remove all ${state.items.length} images ${where}? Their copies move to the Recycle Bin.`)) return;
  const files = state.items.map((it) => it.file).filter(Boolean);
  if (state.dataset && files.length) api.datasetRemoveFiles({ name: state.dataset.name, files });
  resetQueueView();
  scheduleDatasetSave();
}

/** Empty the queue on screen (used when clearing, switching or deleting datasets). */
function resetQueueView() {
  pauseBatch();
  api.abortCaption('*');
  for (const item of state.items) {
    if (item.url) URL.revokeObjectURL(item.url);
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  }
  state.items = [];
  state.byId.clear();
  state.selectedId = null;
  state.multi.clear();
  state.anchorId = null;
  el.queue.innerHTML = '';
  updateSelectionUI();
  unmountCropper();
  closeCropModal();
  updateStats();
}

async function openInViewer(item) {
  let res;
  if (item.sourcePath) {
    res = await api.openInViewer({ filePath: item.sourcePath });
  } else {
    const data = new Uint8Array(await item.blob.arrayBuffer());
    res = await api.openInViewer({ data, name: item.name });
  }
  if (!res?.ok) toast(`Could not open viewer: ${res?.error || 'unknown error'}`, { type: 'error' });
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

async function ingestPaths(paths) {
  if (!requireDataset()) return;
  const existing = new Set(state.items.map((i) => i.origin).filter(Boolean));
  const fresh = paths.filter((p) => !existing.has(p));
  const skipped = paths.length - fresh.length;
  if (!fresh.length) {
    if (skipped) toast(`All ${skipped} image(s) are already in the queue.`, { type: 'warn' });
    return;
  }

  const t = fresh.length > 8 ? toast(`Copying ${fresh.length} images into "${state.dataset.name}"…`, { timeout: 0 }) : null;
  // Copy the originals into the dataset folder first; the queue then works on the copies.
  const copies = await api.datasetImport({ name: state.dataset.name, paths: fresh });
  let loaded = 0;
  let failed = 0;
  const firstIndex = state.items.length;
  const limit = createLimiter(4);

  // Load concurrently but insert in the original (sorted) order.
  const results = await Promise.all(
    copies.map((copy) =>
      limit(async () => {
        if (!copy) return null;
        try {
          const bytes = await api.readImageFile(copy.path);
          const ext = splitExt(basename(copy.path)).ext;
          const blob = new Blob([bytes], { type: MIME_BY_EXT[ext] || 'application/octet-stream' });
          return { copy, blob, ext };
        } catch {
          return null;
        } finally {
          loaded++;
          t?.update(`Loading ${loaded} / ${fresh.length} images…`);
        }
      }),
    ),
  );

  for (const r of results) {
    if (!r) {
      failed++;
      continue;
    }
    try {
      await addItemFromBlob(r.blob, {
        sourcePath: r.copy.path,
        fileName: basename(r.copy.source),
        sourceFormat: r.ext,
        file: r.copy.file,
        origin: r.copy.source,
      });
    } catch {
      failed++;
    }
  }

  const added = fresh.length - failed;
  const parts = [`Added ${added} image${added === 1 ? '' : 's'}`];
  if (skipped) parts.push(`${skipped} duplicate${skipped === 1 ? '' : 's'} skipped`);
  if (failed) parts.push(`${failed} failed to load`);
  if (t) t.update(parts.join(' · '), { type: failed ? 'warn' : 'success', timeout: 3500 });
  else toast(parts.join(' · '), { type: failed ? 'warn' : 'success', timeout: 3000 });

  if (!state.selectedId && state.items[firstIndex]) selectItem(state.items[firstIndex].id);
}

async function selectFiles() {
  const paths = await api.selectFiles();
  if (!paths.length) return;
  // With a dataset open, picked files go straight into it; otherwise ask where they belong.
  if (state.dataset) await ingestPaths(paths);
  else openDropTarget({ paths, loose: [] });
}

async function selectDirectory() {
  const { dir, files } = await api.selectDirectory();
  if (!dir) return;
  if (!files.length) {
    toast(`No supported images found in ${dir}`, { type: 'warn' });
    return;
  }
  if (state.dataset) await ingestPaths(files);
  else openDropTarget({ paths: files, loose: [] });
}

/** Add images collected from a drop or file picker to the open dataset. */
async function addIncomingImages({ paths, loose }) {
  if (paths.length) await ingestPaths(paths);
  for (const f of loose) {
    try {
      const item = await addBlobToDataset(f, f.name || `dropped_${timestamp()}.png`);
      if (!state.selectedId) selectItem(item.id);
    } catch (err) {
      toast(err.message, { type: 'error' });
    }
  }
}

function setupDragAndDrop() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) {
      el.dropOverlay.classList.remove('hidden');
      el.dropzone.classList.add('active');
    }
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) resetDrag();
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    resetDrag();
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;

    const paths = [];
    const loose = [];
    for (const f of files) {
      const p = api.getPathForFile(f);
      if (p) paths.push(p);
      else if (f.type.startsWith('image/')) loose.push(f);
    }
    const resolved = paths.length ? await api.resolvePaths(paths) : [];
    if (!resolved.length && !loose.length) {
      toast('No supported images found in the dropped items.', { type: 'warn' });
      return;
    }
    // Always ask which dataset the dropped images belong to.
    openDropTarget({ paths: resolved, loose });
  });

  function resetDrag() {
    depth = 0;
    el.dropOverlay.classList.add('hidden');
    el.dropzone.classList.remove('active');
  }
}

// ---------------------------------------------------------------------------
// Webcam
// ---------------------------------------------------------------------------

async function startWebcam(deviceId) {
  const granted = await api.requestCameraAccess();
  if (!granted) {
    toast('Camera access was denied by the operating system.', { type: 'error' });
    return;
  }
  stopWebcamStream();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    state.webcam.stream = stream;
    el.webcamVideo.srcObject = stream;
    el.webcamPanel.classList.remove('hidden');
    setWebcamButton(true);

    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const activeId = stream.getVideoTracks()[0]?.getSettings().deviceId;
    el.webcamDevice.innerHTML = '';
    devices.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Camera ${i + 1}`;
      if (d.deviceId === activeId) opt.selected = true;
      el.webcamDevice.appendChild(opt);
    });
    el.webcamDevice.classList.toggle('hidden', devices.length < 2);
  } catch (err) {
    toast(`Could not start webcam: ${err.message || err.name}`, { type: 'error' });
    stopWebcam();
  }
}

function stopWebcamStream() {
  state.webcam.stream?.getTracks().forEach((t) => t.stop());
  state.webcam.stream = null;
  el.webcamVideo.srcObject = null;
}

function stopWebcam() {
  stopWebcamStream();
  el.webcamPanel.classList.add('hidden');
  setWebcamButton(false);
}

function setWebcamButton(on) {
  el.webcamToggleBtn.innerHTML = `${iconSvg(on ? 'cameraOff' : 'camera')}<span>${on ? 'Disable Webcam' : 'Enable Webcam'}</span>`;
}

async function captureSnapshot() {
  if (!requireDataset()) return;
  const v = el.webcamVideo;
  if (!state.webcam.stream || !v.videoWidth) {
    toast('Webcam is not ready yet.', { type: 'warn' });
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  canvas.getContext('2d').drawImage(v, 0, 0);
  const blob = await canvasToBlob(canvas, 'image/png');

  el.webcamFlash.classList.remove('flash');
  void el.webcamFlash.offsetWidth;
  el.webcamFlash.classList.add('flash');

  const item = await addBlobToDataset(blob, `webcam_${timestamp()}.png`, 'png');
  selectItem(item.id);
}

// ---------------------------------------------------------------------------
// Cropper.js
// ---------------------------------------------------------------------------

function unmountCropper() {
  state.crop.cropper?.destroy();
  state.crop = { cropper: null, host: null, itemId: null };
  el.sidebarCropStage.classList.add('hidden');
  el.cropEmpty.classList.remove('hidden');
  el.expandCropBtn.classList.add('hidden');
  el.cropInfo.textContent = '—';
  el.applyCropBtn.disabled = true;
  el.resetCropBtn.disabled = true;
}

function mountCropper(host, item) {
  state.crop.cropper?.destroy();
  const img = host === 'modal' ? el.modalCropImg : el.sidebarCropImg;

  if (host === 'sidebar') {
    el.cropEmpty.classList.add('hidden');
    el.sidebarCropStage.classList.remove('hidden');
    el.expandCropBtn.classList.remove('hidden');
  } else {
    el.cropModalName.textContent = `${item.name}.${state.settings.exportFormat}`;
  }

  img.src = item.url;
  const cropper = new Cropper(img, {
    viewMode: 1,
    dragMode: 'move',
    aspectRatio: cropAspect(),
    autoCropArea: 1,
    checkOrientation: false, // Chromium already applies EXIF orientation
    background: false,
    responsive: true,
    restore: false,
    zoomOnWheel: true,
    wheelZoomRatio: 0.08,
    toggleDragModeOnDblclick: true,
    ready() {
      if (state.crop.cropper !== cropper) return;
      if (item.crop) cropper.setData(item.crop);
      updateCropInfo();
    },
    crop() {
      if (state.crop.cropper === cropper) updateCropInfo();
    },
  });
  state.crop = { cropper, host, itemId: item.id };
}

function currentCropItem() {
  return state.byId.get(state.crop.itemId);
}

function updateCropInfo() {
  const item = currentCropItem();
  const cropper = state.crop.cropper;
  if (!item || !cropper) return;
  const d = cropper.getData(true);
  const { outW, outH } = finalizeCrop(d, item);
  const text = `crop ${d.width}×${d.height} @ ${d.x},${d.y}  →  ${outW}×${outH}`;
  if (state.crop.host === 'modal') el.modalCropInfo.textContent = `${item.naturalW}×${item.naturalH} source · ${text}`;
  else el.cropInfo.textContent = text;
}

async function applyCropToCurrent() {
  const item = currentCropItem();
  const cropper = state.crop.cropper;
  if (!item || !cropper) return;
  const { crop, outW, outH } = finalizeCrop(cropper.getData(true), item);
  item.crop = crop;
  item.outW = outW;
  item.outH = outH;
  updateCard(item);
  await refreshThumb(item);
  toast(`Crop applied to ${item.name} → ${outW}×${outH}`, { type: 'success', timeout: 1800 });
}

async function resetCurrentCrop() {
  const item = currentCropItem();
  if (!item) return;
  item.crop = null;
  item.outW = item.naturalW;
  item.outH = item.naturalH;
  state.crop.cropper?.reset();
  updateCard(item);
  await refreshThumb(item);
}

/** Items targeted by bulk actions: the multi-selection if it has 2+ items, otherwise everything. */
function bulkTargets() {
  if (state.multi.size > 1) return state.items.filter((it) => state.multi.has(it.id));
  return state.items;
}

/** Apply computed crops to items, then refresh their thumbnails. */
async function applyCrops(items, rectFor, verb) {
  for (const item of items) {
    const { crop, outW, outH } = finalizeCrop(rectFor(item), item);
    item.crop = crop;
    item.outW = outW;
    item.outH = outH;
    updateCard(item);
  }
  const current = currentCropItem();
  if (current?.crop && state.crop.cropper && items.includes(current)) state.crop.cropper.setData(current.crop);

  const t = toast(`Rendering ${items.length} cropped thumbnails…`, { timeout: 0 });
  await Promise.all(items.map((it) => refreshThumb(it).catch(() => {})));
  const sizes = new Set(items.map((it) => `${it.outW}×${it.outH}`));
  const sizeLabel = sizes.size === 1 ? [...sizes][0] : `${sizes.size} sizes`;
  t.update(`${verb} ${items.length} image${items.length === 1 ? '' : 's'} → ${sizeLabel}`, {
    type: 'success',
    timeout: 3000,
  });
}

/** Center-crop the selection (or the whole queue) to the ratio/resolution in the sidebar. */
async function batchCenterCrop() {
  const items = bulkTargets();
  if (!items.length) {
    toast('Queue is empty.', { type: 'warn' });
    return;
  }
  const aspect = cropAspect();
  await applyCrops(items, (item) => centerCropRect(item, aspect), 'Center-cropped');
}

/**
 * "Apply Crop" from the sidebar. With a multi-selection, the current crop box is
 * mapped onto every selected image: same relative position and zoom, adapted to
 * each image's dimensions, and the output size comes from the sidebar settings.
 */
async function applyCropToSelection() {
  if (state.multi.size <= 1) return applyCropToCurrent();
  const src = currentCropItem();
  const cropper = state.crop.cropper;
  if (!src || !cropper) {
    toast('Select an image to position the crop box first.', { type: 'warn' });
    return;
  }
  const d = cropper.getData(true);
  const aspect = d.width / d.height;
  const base = centerCropRect(src, aspect);
  const zoom = Math.min(1, d.width / base.width);
  const cx = (d.x + d.width / 2) / src.naturalW;
  const cy = (d.y + d.height / 2) / src.naturalH;

  const items = state.items.filter((it) => state.multi.has(it.id));
  await applyCrops(
    items,
    (item) => {
      const b = centerCropRect(item, aspect);
      const w = Math.max(1, b.width * zoom);
      const h = Math.max(1, b.height * zoom);
      return {
        x: clamp(cx * item.naturalW - w / 2, 0, item.naturalW - w),
        y: clamp(cy * item.naturalH - h / 2, 0, item.naturalH - h),
        width: w,
        height: h,
      };
    },
    'Cropped',
  );
}

// ---------------------------------------------------------------------------
// Multi-selection: Ctrl/Shift+click, Ctrl+A, drag-to-select box
// ---------------------------------------------------------------------------

let renderedMulti = new Set();

function setMulti(ids) {
  state.multi = ids instanceof Set ? ids : new Set(ids);
  updateSelectionUI();
}

function isVisible(item) {
  return item.refs && !item.refs.root.classList.contains('hidden');
}

function selectAllVisible() {
  const visible = state.items.filter(isVisible);
  if (!visible.length) return;
  setMulti(visible.map((it) => it.id));
  if (!state.multi.has(state.selectedId)) selectItem(visible[0].id, { scroll: false });
}

function clearSelection() {
  if (!state.multi.size) return;
  setMulti(new Set());
}

function rangeSelect(fromId, toId, additive) {
  const visible = state.items.filter(isVisible);
  const a = visible.findIndex((it) => it.id === fromId);
  const b = visible.findIndex((it) => it.id === toId);
  if (a < 0 || b < 0) return setMulti([toId]);
  const range = visible.slice(Math.min(a, b), Math.max(a, b) + 1).map((it) => it.id);
  setMulti(additive ? [...state.multi, ...range] : range);
}

function onCardMouseDown(e, item) {
  if (e.button !== 0 || e.target.closest('.card-actions')) return;
  const mod = e.ctrlKey || e.metaKey;

  if (e.shiftKey && state.anchorId && state.byId.has(state.anchorId)) {
    e.preventDefault();
    rangeSelect(state.anchorId, item.id, mod);
    selectItem(item.id, { scroll: false });
    return;
  }
  if (mod) {
    e.preventDefault();
    const next = new Set(state.multi);
    // The first Ctrl+click keeps the current item selected too.
    if (!next.size && state.selectedId) next.add(state.selectedId);
    if (next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
    setMulti(next);
    state.anchorId = item.id;
    if (next.has(item.id)) selectItem(item.id, { scroll: false });
    return;
  }
  // Editing a caption inside an existing multi-selection keeps the selection.
  if (e.target.closest('textarea') && state.multi.has(item.id) && state.multi.size > 1) {
    selectItem(item.id, { scroll: false });
    return;
  }
  setMulti([item.id]);
  state.anchorId = item.id;
  if (!e.target.closest('.card-thumb')) selectItem(item.id, { scroll: false });
}

function deleteSelectionOr(id) {
  if (state.multi.size > 1 && (!id || state.multi.has(id))) {
    const n = state.multi.size;
    if (!confirm(`Remove ${n} selected items from the queue?`)) return;
    removeItems([...state.multi]);
    toast(`Removed ${n} items`, { type: 'success', timeout: 2000 });
  } else if (id) {
    removeItem(id);
  }
}

function captionSelection() {
  if (state.multi.size < 1) return;
  startBatch({ ids: new Set(state.multi) });
}

function updateSelectionUI() {
  const next = state.multi;
  for (const id of renderedMulti) {
    if (!next.has(id)) state.byId.get(id)?.refs?.root.classList.remove('multi-selected');
  }
  for (const id of next) {
    if (!renderedMulti.has(id)) state.byId.get(id)?.refs?.root.classList.add('multi-selected');
  }
  renderedMulti = new Set(next);

  const n = next.size;
  el.selectionBar.classList.toggle('hidden', n < 2);
  el.selCount.textContent = n;
  scheduleStepUpdate(); // status bar shows the selection count
  el.applyCropBtn.querySelector('span').textContent = n > 1 ? `Apply Crop Box to ${n} Selected` : 'Apply Crop to Current';
  el.batchCropBtn.querySelector('span').textContent =
    n > 1 ? `Center-Crop ${n} Selected to Ratio` : 'Batch Center-Crop All to Ratio';
  el.batchCropBtn.classList.toggle('btn-accent', n > 1);
}

function setupMarquee() {
  const scroller = el.queueScroll;
  let drag = null;

  scroller.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.card')) return;
    const r = scroller.getBoundingClientRect();
    if (e.clientX - r.left >= scroller.clientWidth) return; // clicked the scrollbar
    e.preventDefault();
    document.activeElement?.blur?.();
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    drag = {
      startX: e.clientX - r.left + scroller.scrollLeft,
      startY: e.clientY - r.top + scroller.scrollTop,
      curX: e.clientX,
      curY: e.clientY,
      base: additive ? new Set(state.multi) : new Set(),
      additive,
      moved: false,
      box: null,
      raf: 0,
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    drag.curX = e.clientX;
    drag.curY = e.clientY;
    if (!drag.moved) {
      const r = scroller.getBoundingClientRect();
      const dx = e.clientX - r.left + scroller.scrollLeft - drag.startX;
      const dy = e.clientY - r.top + scroller.scrollTop - drag.startY;
      if (Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      drag.box = document.createElement('div');
      drag.box.className = 'marquee';
      scroller.appendChild(drag.box);
      drag.raf = requestAnimationFrame(autoScroll);
    }
    update();
  }

  function update() {
    const r = scroller.getBoundingClientRect();
    const cx = clamp(drag.curX, r.left, r.left + scroller.clientWidth) - r.left + scroller.scrollLeft;
    const cy = clamp(drag.curY, r.top, r.top + scroller.clientHeight) - r.top + scroller.scrollTop;
    const x1 = Math.min(drag.startX, cx);
    const y1 = Math.min(drag.startY, cy);
    const x2 = Math.max(drag.startX, cx);
    const y2 = Math.max(drag.startY, cy);
    Object.assign(drag.box.style, { left: `${x1}px`, top: `${y1}px`, width: `${x2 - x1}px`, height: `${y2 - y1}px` });

    const hits = new Set(drag.base);
    for (const item of state.items) {
      if (!isVisible(item)) continue;
      const c = item.refs.root.getBoundingClientRect();
      const left = c.left - r.left + scroller.scrollLeft;
      const top = c.top - r.top + scroller.scrollTop;
      if (left < x2 && left + c.width > x1 && top < y2 && top + c.height > y1) hits.add(item.id);
    }
    setMulti(hits);
  }

  function autoScroll() {
    if (!drag) return;
    const r = scroller.getBoundingClientRect();
    const edge = 48;
    let dy = 0;
    if (drag.curY < r.top + edge) dy = -Math.min(28, (r.top + edge - drag.curY) / 2);
    else if (drag.curY > r.bottom - edge) dy = Math.min(28, (drag.curY - (r.bottom - edge)) / 2);
    if (dy) {
      const before = scroller.scrollTop;
      scroller.scrollTop += dy;
      if (scroller.scrollTop !== before) update();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    cancelAnimationFrame(drag.raf);
    drag.box?.remove();
    if (!drag.moved) {
      if (!drag.additive) clearSelection(); // plain click on empty space
    } else if (state.multi.size && !state.multi.has(state.selectedId)) {
      const first = state.items.find((it) => state.multi.has(it.id));
      if (first) selectItem(first.id, { scroll: false });
    }
    drag = null;
  }
}

function openCropModal() {
  const item = state.byId.get(state.selectedId);
  if (!item) return;
  el.cropModal.classList.remove('hidden');
  el.sidebarCropStage.classList.add('hidden');
  el.cropEmpty.classList.remove('hidden');
  requestAnimationFrame(() => mountCropper('modal', item));
}

function closeCropModal() {
  if (el.cropModal.classList.contains('hidden')) return;
  el.cropModal.classList.add('hidden');
  const item = state.byId.get(state.selectedId);
  if (item) mountCropper('sidebar', item);
  else unmountCropper();
}

function stepModal(delta) {
  const visible = state.items.filter((i) => !i.refs?.root.classList.contains('hidden'));
  const idx = visible.findIndex((i) => i.id === state.selectedId);
  const next = visible[idx + delta];
  if (next) selectItem(next.id);
}

// ---------------------------------------------------------------------------
// Resize / crop settings form
// ---------------------------------------------------------------------------

function syncResizeForm() {
  const s = state.settings;
  el.outWidth.value = s.width;
  el.outHeight.value = s.height;
  el.autoWidth.checked = s.autoWidth;
  el.autoHeight.checked = s.autoHeight;
  el.outWidth.disabled = s.autoWidth;
  el.outHeight.disabled = s.autoHeight;
  el.ratioW.value = s.ratioW;
  el.ratioH.value = s.ratioH;
  el.ratioW.disabled = s.freeform;
  el.ratioH.disabled = s.freeform;
  el.snap8.checked = s.snap8;

  const key = s.freeform ? 'free' : `${s.ratioW}:${s.ratioH}`;
  $$('.chip', el.ratioPresets).forEach((c) => c.classList.toggle('active', c.dataset.ratio === key));
}

/** Keep width/height consistent with the locked ratio. */
function linkDimensions(changed) {
  const s = state.settings;
  if (s.freeform) return;
  const r = s.ratioW / s.ratioH;
  if (changed === 'height') {
    if (!s.autoWidth && !s.autoHeight) s.width = Math.round(s.height * r);
  } else if (!s.autoHeight && !s.autoWidth) {
    s.height = Math.round(s.width / r);
  }
}

function onResizeSettingsChanged() {
  syncResizeForm();
  saveSettings();
  state.crop.cropper?.setAspectRatio(cropAspect());
  updateCropInfo();
}

function setupResizeControls() {
  el.outWidth.addEventListener('change', () => {
    state.settings.width = toInt(el.outWidth.value, 512, 8, 8192);
    linkDimensions('width');
    onResizeSettingsChanged();
  });
  el.outHeight.addEventListener('change', () => {
    state.settings.height = toInt(el.outHeight.value, 512, 8, 8192);
    linkDimensions('height');
    onResizeSettingsChanged();
  });
  el.autoWidth.addEventListener('change', () => {
    state.settings.autoWidth = el.autoWidth.checked;
    onResizeSettingsChanged();
  });
  el.autoHeight.addEventListener('change', () => {
    state.settings.autoHeight = el.autoHeight.checked;
    onResizeSettingsChanged();
  });
  const ratioChanged = () => {
    state.settings.ratioW = toInt(el.ratioW.value, 1, 1, 100);
    state.settings.ratioH = toInt(el.ratioH.value, 1, 1, 100);
    state.settings.freeform = false;
    linkDimensions('width');
    onResizeSettingsChanged();
  };
  el.ratioW.addEventListener('change', ratioChanged);
  el.ratioH.addEventListener('change', ratioChanged);
  el.snap8.addEventListener('change', () => {
    state.settings.snap8 = el.snap8.checked;
    onResizeSettingsChanged();
  });

  el.ratioPresets.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const s = state.settings;
    if (chip.dataset.ratio === 'free') {
      s.freeform = true;
    } else {
      const [w, h] = chip.dataset.ratio.split(':').map(Number);
      s.ratioW = w;
      s.ratioH = h;
      s.freeform = false;
      linkDimensions('width');
    }
    onResizeSettingsChanged();
  });

  el.applyCropBtn.addEventListener('click', applyCropToSelection);
  el.resetCropBtn.addEventListener('click', resetCurrentCrop);
  el.batchCropBtn.addEventListener('click', batchCenterCrop);
  el.expandCropBtn.addEventListener('click', openCropModal);

  el.closeCropModalBtn.addEventListener('click', closeCropModal);
  el.cropModal.addEventListener('mousedown', (e) => {
    if (e.target === el.cropModal) closeCropModal();
  });
  el.modalApplyBtn.addEventListener('click', applyCropToCurrent);
  el.modalResetBtn.addEventListener('click', resetCurrentCrop);
  el.modalPrevBtn.addEventListener('click', () => stepModal(-1));
  el.modalNextBtn.addEventListener('click', () => stepModal(1));
}

// ---------------------------------------------------------------------------
// Batch rename
// ---------------------------------------------------------------------------

function renameAt(index) {
  const s = state.settings;
  const n = String(s.renameStart + index).padStart(s.renamePad, '0');
  const prefix = s.renamePrefix.trim();
  return prefix ? `${prefix}_${n}` : n;
}

function updateRenamePreview() {
  const ext = state.settings.exportFormat;
  const count = Math.max(state.items.length, 2);
  const names = [renameAt(0), renameAt(1)];
  let html = names.map((n) => `<span class="preview-pill">${escapeHtml(n)}.${ext}</span>`).join('');
  if (count > 2) {
    html += `<span class="preview-pill more">…</span><span class="preview-pill">${escapeHtml(renameAt(count - 1))}.${ext}</span>`;
  }
  el.renamePreview.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function applyBatchRename() {
  if (!state.items.length) {
    toast('Queue is empty.', { type: 'warn' });
    return;
  }
  state.items.forEach((item, i) => {
    item.name = renameAt(i);
    updateCard(item);
  });
  if (state.crop.host === 'modal') {
    const it = currentCropItem();
    if (it) el.cropModalName.textContent = `${it.name}.${state.settings.exportFormat}`;
  }
  toast(`Renamed ${state.items.length} items (${renameAt(0)} … ${renameAt(state.items.length - 1)})`, {
    type: 'success',
  });
}

function setupRenameControls() {
  const s = state.settings;
  el.renamePrefix.value = s.renamePrefix;
  el.renameStart.value = s.renameStart;
  el.renamePad.value = s.renamePad;

  const onChange = () => {
    s.renamePrefix = el.renamePrefix.value.replace(/[<>:"/\\|?*]/g, '');
    s.renameStart = toInt(el.renameStart.value, 1, 0, 1e9);
    s.renamePad = toInt(el.renamePad.value, 3, 1, 8);
    saveSettings();
    updateRenamePreview();
    scheduleStepUpdate(); // a changed template means items no longer match it
  };
  el.renamePrefix.addEventListener('input', onChange);
  el.renameStart.addEventListener('input', onChange);
  el.renamePad.addEventListener('input', onChange);
  el.applyRenameBtn.addEventListener('click', applyBatchRename);
}

// ---------------------------------------------------------------------------
// Caption settings
// ---------------------------------------------------------------------------

/**
 * Caption presets. Each one describes what varies between images and leaves out
 * what the LoRA should learn, so that concept gets absorbed into the trigger word.
 * Lower temperatures keep captions consistent across a dataset; a larger send size
 * helps the model see small details (clothing, accessories, surroundings).
 */
const CAPTION_PRESETS = {
  character: {
    label: 'Character',
    temperature: 0.2,
    captionMaxDim: 1024,
    singleLine: true,
    hint: "Describes clothing, pose, setting and framing, but not the person's face or body, so the trigger word learns who they are.",
    prompt:
      'Describe this image as one comma-separated caption for AI training. Include the clothing, pose, expression, action, ' +
      'camera angle, framing (close-up, half body, full body), background and lighting. Do not describe the person\'s face, ' +
      'hair, eye color, skin or body type. Do not name the person. Write short phrases separated by commas, without labels ' +
      'like "Action:" or "Pose:". Output only the caption, under 60 words.',
  },
  style: {
    label: 'Style',
    temperature: 0.3,
    captionMaxDim: 896,
    singleLine: true,
    hint: 'Describes only the content, not the art style, so the trigger word learns the style.',
    prompt:
      'Describe only the content of this image as one comma-separated caption for AI training: the subjects, what they are ' +
      'doing, objects, setting, composition and camera angle. Do not mention the art style, medium, colors, brushwork, ' +
      'lighting mood or the words "painting", "illustration" or "artwork". Output only the caption, under 50 words.',
  },
  object: {
    label: 'Object',
    temperature: 0.15,
    captionMaxDim: 1024,
    singleLine: true,
    hint: 'Describes the scene around the object, not the object itself, so the trigger word learns what it looks like.',
    prompt:
      'Describe this image as one comma-separated caption for AI training. Include the setting, surface, background, other ' +
      'objects, lighting, camera angle and how the main object is placed. Refer to the main object only as "the object" and ' +
      'do not describe its shape, color, material or branding. Output only the caption, under 50 words.',
  },
  general: {
    label: 'General',
    temperature: 0.25,
    captionMaxDim: 1024,
    singleLine: true,
    hint: 'Describes everything in detail. Best for general fine-tunes and natural-language models like Flux or SD3.',
    prompt:
      'Write one detailed caption for this image for training a text-to-image model. Describe the main subject, clothing, ' +
      'pose, action, setting, background, lighting, colors, composition, camera angle and art style or medium. Write plain ' +
      'descriptive phrases separated by commas. Do not start with "This image shows" and do not mention the image itself. ' +
      'Output only the caption, under 80 words.',
  },
};

/** Which preset the current prompt matches (edited prompts count as custom). */
function activePresetKey() {
  const prompt = state.settings.prompt.trim();
  return Object.keys(CAPTION_PRESETS).find((k) => CAPTION_PRESETS[k].prompt === prompt) || null;
}

function renderPresetState() {
  const key = activePresetKey();
  $$('.chip', el.captionPresets).forEach((c) => {
    const on = c.dataset.preset === key;
    c.classList.toggle('active', on);
    c.setAttribute('aria-pressed', String(on));
  });
  if (key) {
    const p = CAPTION_PRESETS[key];
    el.presetHint.textContent = `${p.hint} Temperature ${p.temperature} · send size ${p.captionMaxDim} px.`;
  } else {
    el.presetHint.textContent = 'Custom prompt. Pick a preset above to fill in a recommended prompt and settings.';
  }
}

function applyCaptionPreset(key) {
  const p = CAPTION_PRESETS[key];
  if (!p) return;
  const s = state.settings;
  s.prompt = p.prompt;
  s.temperature = p.temperature;
  s.captionMaxDim = p.captionMaxDim;
  s.singleLine = p.singleLine;
  el.captionPrompt.value = s.prompt;
  el.captionTemp.value = s.temperature;
  el.captionMaxDim.value = s.captionMaxDim;
  el.captionSingleLine.checked = s.singleLine;
  saveSettings();
  renderPresetState();

  // Briefly highlight the fields that changed.
  for (const field of [el.captionPrompt, el.captionTemp, el.captionMaxDim]) {
    field.classList.remove('flash-update');
    void field.offsetWidth;
    field.classList.add('flash-update');
  }
  toast(`${p.label} preset applied: temperature ${p.temperature}, send size ${p.captionMaxDim} px`, {
    type: 'success',
    timeout: 2500,
  });
}

function setupCaptionSettings() {
  const s = state.settings;
  el.captionPrompt.value = s.prompt;
  el.captionPrefix.value = s.captionPrefix;
  el.captionTemp.value = s.temperature;
  el.captionMaxDim.value = s.captionMaxDim;
  el.captionSingleLine.checked = s.singleLine;
  el.captionSkipDone.checked = s.skipDone;
  el.ollamaHost.value = s.host;

  el.captionPrompt.addEventListener('input', () => {
    s.prompt = el.captionPrompt.value;
    saveSettings();
    renderPresetState();
  });
  el.captionPresets.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-preset]');
    if (chip) applyCaptionPreset(chip.dataset.preset);
  });
  renderPresetState();
  el.captionPrefix.addEventListener('input', () => {
    s.captionPrefix = el.captionPrefix.value;
    saveSettings();
  });
  el.captionTemp.addEventListener('change', () => {
    const t = Number(el.captionTemp.value);
    s.temperature = Number.isFinite(t) ? clamp(t, 0, 2) : 0.2;
    el.captionTemp.value = s.temperature;
    saveSettings();
  });
  el.captionMaxDim.addEventListener('change', () => {
    s.captionMaxDim = toInt(el.captionMaxDim.value, 896, 224, 2048);
    el.captionMaxDim.value = s.captionMaxDim;
    saveSettings();
  });
  el.captionSingleLine.addEventListener('change', () => {
    s.singleLine = el.captionSingleLine.checked;
    saveSettings();
  });
  el.captionSkipDone.addEventListener('change', () => {
    s.skipDone = el.captionSkipDone.checked;
    saveSettings();
  });
  el.ollamaHost.addEventListener('change', () => {
    s.host = el.ollamaHost.value.trim() || 'http://localhost:11434';
    el.ollamaHost.value = s.host;
    saveSettings();
    checkOllama();
  });
}

// ---------------------------------------------------------------------------
// Ollama status & models
// ---------------------------------------------------------------------------

async function checkOllama({ silent = true } = {}) {
  if (state.ollama.checking) return;
  state.ollama.checking = true;
  el.refreshModelsBtn.classList.add('spinning');
  if (!state.ollama.online) {
    el.ollamaDot.className = 'status-dot checking';
    el.ollamaLabel.textContent = 'Checking Ollama…';
  }

  const res = await api.ollamaStatus(state.settings.host);
  state.ollama.checking = false;
  el.refreshModelsBtn.classList.remove('spinning');
  state.ollama.online = res.online;

  if (!res.online) {
    el.ollamaDot.className = 'status-dot offline';
    el.ollamaLabel.textContent = 'Ollama Offline';
    el.ollamaLabel.title = res.error || '';
    showBanner(
      `<strong>Ollama Offline</strong> — can't reach <code>${escapeHtml(state.settings.host)}</code>. ` +
        'Ollama must be installed and running to generate captions.',
    );
    if (!silent) toast(`Ollama unreachable at ${state.settings.host} (${res.error})`, { type: 'error' });
    return;
  }

  el.ollamaDot.className = 'status-dot online';
  el.ollamaLabel.title = state.settings.host;
  state.ollama.models = res.models;
  state.ollama.capabilities = new Map(res.models.map((m) => [m.name, m.capabilities]));
  const selectedInstalled = populateModels(res.models);
  if (selectedInstalled) hideBanner();
  else {
    showBanner(
      `<strong>Model not downloaded</strong> — <code>${escapeHtml(state.settings.model)}</code> isn't installed in Ollama yet. ` +
        'Open the Setup Assistant for the steps, or pick another vision model.',
    );
  }
  if (!silent) toast(`Ollama online · ${res.models.length} model(s) installed`, { type: 'success', timeout: 2000 });
}

function showBanner(html) {
  el.bannerMsg.innerHTML = html;
  el.offlineBanner.classList.remove('hidden');
}

function hideBanner() {
  el.offlineBanner.classList.add('hidden');
}

function populateModels(models) {
  const hasCapInfo = models.some((m) => m.capabilities.length);
  const vision = hasCapInfo ? models.filter((m) => m.capabilities.includes('vision')) : models;
  const names = vision.map((m) => m.name);

  el.ollamaLabel.textContent = hasCapInfo
    ? `Ollama · ${vision.length} vision model${vision.length === 1 ? '' : 's'}`
    : `Ollama · ${models.length} model${models.length === 1 ? '' : 's'}`;

  const matches = modelMatches;
  const saved = state.settings.model;
  let selected = names.find((n) => n === saved) || names.find((n) => matches(saved, n));
  if (!selected) selected = names.find((n) => matches(DEFAULT_MODEL, n));
  if (!selected) selected = names[0];

  const frag = document.createDocumentFragment();
  for (const m of vision) {
    const opt = document.createElement('option');
    opt.value = m.name;
    opt.textContent = m.parameterSize ? `${m.name}  (${m.parameterSize})` : m.name;
    frag.appendChild(opt);
  }
  if (!names.some((n) => matches(DEFAULT_MODEL, n))) {
    const opt = document.createElement('option');
    opt.value = DEFAULT_MODEL;
    opt.textContent = `${DEFAULT_MODEL} (not installed)`;
    frag.appendChild(opt);
    if (!selected) selected = DEFAULT_MODEL;
  }
  el.modelSelect.innerHTML = '';
  el.modelSelect.appendChild(frag);
  el.modelSelect.value = selected;
  state.settings.model = selected;
  saveSettings();
  return names.includes(selected);
}

// ---------------------------------------------------------------------------
// Captioning
// ---------------------------------------------------------------------------

function cleanCaption(text) {
  let t = text.replace(/<\/?think>/g, '');
  if (state.settings.singleLine) t = t.replace(/\s*\n+\s*/g, ' ').replace(/[ \t]{2,}/g, ' ');
  t = t.trim();
  if (/^["'“].*["'”]$/s.test(t)) t = t.slice(1, -1).trim();
  return t;
}

function captionPrefixText() {
  const p = state.settings.captionPrefix.trim();
  if (!p) return '';
  return /[,.;:]$/.test(p) ? `${p} ` : `${p}, `;
}

/** Stream a caption for a single item. Resolves with the result object from main. */
async function captionItem(item) {
  const model = state.settings.model || el.modelSelect.value;
  const genId = `${item.id}:${++item.genSeq}`;
  item.genId = genId;

  const prefix = captionPrefixText();
  item.caption = prefix;
  item.refs.caption.value = prefix;
  item.refs.caption.placeholder = 'Waiting for model…';
  setStatus(item, 'processing');

  let imageBase64;
  try {
    const canvas = await decodeLimit(() =>
      renderItem(item, { maxDim: state.settings.captionMaxDim, background: '#ffffff' }),
    );
    imageBase64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  } catch (err) {
    item.genId = null;
    setStatus(item, 'error', `Image render failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
  if (item.genId !== genId || !state.byId.has(item.id)) return { ok: false, aborted: true };

  const caps = state.ollama.capabilities.get(model) || [];
  const res = await api.generateCaption({
    id: genId,
    imageBase64,
    model,
    prompt: state.settings.prompt || DEFAULT_PROMPT,
    host: state.settings.host,
    // Reasoning models: skip the thinking phase so captions stream immediately.
    think: caps.includes('thinking') ? false : undefined,
    options: { temperature: state.settings.temperature },
    keepAlive: '10m',
  });

  if (item.genId !== genId || !state.byId.has(item.id)) return res; // superseded or removed
  item.genId = null;
  item.refs.caption.placeholder = 'Caption will stream here… (editable)';
  item.refs.caption.classList.remove('thinking');

  if (res.ok) {
    item.caption = cleanCaption(item.refs.caption.value);
    item.refs.caption.value = item.caption;
    setStatus(item, item.caption ? 'done' : 'error', item.caption ? '' : 'Model returned an empty caption');
  } else if (res.aborted) {
    item.caption = item.refs.caption.value;
    setStatus(item, 'queued');
  } else {
    item.caption = item.refs.caption.value;
    setStatus(item, 'error', res.error || 'Unknown error');
  }
  applyFilterTo(item);
  return res;
}

function onCaptionToken({ id, token }) {
  const [itemId] = id.split(':');
  const item = state.byId.get(itemId);
  if (!item || item.genId !== id) return;
  const ta = item.refs.caption;
  if (ta.classList.contains('thinking')) {
    ta.classList.remove('thinking');
    ta.value = captionPrefixText();
  }
  const atBottom = ta.scrollTop + ta.clientHeight >= ta.scrollHeight - 4;
  // Strip leading whitespace on the first model token so the prefix joins cleanly.
  ta.value += ta.value === captionPrefixText() ? token.replace(/^\s+/, '') : token;
  item.caption = ta.value;
  if (atBottom) ta.scrollTop = ta.scrollHeight;
  updateCharCount(item);
}

function onCaptionThinking({ id }) {
  const [itemId] = id.split(':');
  const item = state.byId.get(itemId);
  if (!item || item.genId !== id) return;
  item.refs.caption.placeholder = 'Model is thinking…';
}

async function regenerateItem(id) {
  const item = state.byId.get(id);
  if (!item) return;
  if (item.status === 'processing') {
    if (item.genId) await api.abortCaption(item.genId);
    return;
  }
  if (!(await ensureCaptionReady())) return;
  const res = await captionItem(item);
  if (res && !res.ok && !res.aborted) toast(`${item.name}: ${res.error}`, { type: 'error' });
}

function nextBatchItem() {
  const b = state.batch;
  return state.items.find((it) => {
    if (b.attempted.has(it.id) || it.status === 'processing') return false;
    if (b.scope) return b.scope.has(it.id); // explicit selection: (re)caption regardless of status
    if (it.status === 'done' && state.settings.skipDone) return false;
    return true;
  });
}

/** @param {{ ids?: Set<string> }} [opts]  ids limits the batch to those items (e.g. the selection). */
async function startBatch(opts = {}) {
  const b = state.batch;
  if (b.running) {
    if (opts.ids) toast('A batch is already running. Pause it first.', { type: 'warn' });
    return;
  }
  if (!state.items.length) {
    toast('Add some images first.', { type: 'warn' });
    return;
  }
  await checkOllama();
  if (!(await ensureCaptionReady())) return;

  b.scope = opts.ids instanceof Set ? opts.ids : null;
  b.running = true;
  b.pauseRequested = false;
  b.attempted = new Set();
  b.errors = 0;
  updateBatchButtons();

  const started = performance.now();
  let processed = 0;
  let item;
  while (!b.pauseRequested && (item = nextBatchItem())) {
    b.attempted.add(item.id);
    b.currentId = item.id;
    const res = await captionItem(item);
    b.currentId = null;
    if (res.ok) processed++;
    else if (!res.aborted) {
      b.errors++;
      // Connection-level failures will fail for every item: stop early.
      if (/fetch failed|ECONNREFUSED|not found|pull/i.test(res.error || '')) {
        toast(`Batch stopped: ${res.error}`, { type: 'error', timeout: 8000 });
        checkOllama();
        break;
      }
    }
  }

  const paused = b.pauseRequested;
  b.running = false;
  b.pauseRequested = false;
  updateBatchButtons();

  const secs = ((performance.now() - started) / 1000).toFixed(1);
  if (paused) toast(`Batch paused · ${processed} captioned`, { type: 'warn' });
  else if (processed || b.errors) {
    toast(`Batch finished · ${processed} captioned${b.errors ? ` · ${b.errors} error(s)` : ''} in ${secs}s`, {
      type: b.errors ? 'warn' : 'success',
      timeout: 6000,
    });
  } else toast('Nothing to caption — every item is already done.', { type: 'info' });
}

function pauseBatch() {
  const b = state.batch;
  if (!b.running) return;
  b.pauseRequested = true;
  const item = state.byId.get(b.currentId);
  if (item?.genId) api.abortCaption(item.genId);
  updateBatchButtons();
}

function updateBatchButtons() {
  const b = state.batch;
  el.startBatchBtn.disabled = b.running;
  el.startBatchBtn.classList.toggle('running', b.running);
  el.startBatchBtn.querySelector('span').textContent = b.running ? 'Captioning…' : 'Start Batch Captioning';
  el.pauseBatchBtn.disabled = !b.running || b.pauseRequested;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Export every queue item as an image + .txt pair to a folder or a ZIP. */
async function exportDataset({ mode }) {
  if (!state.items.length) {
    toast('Nothing to export — the queue is empty.', { type: 'warn' });
    return;
  }
  const format = state.settings.exportFormat;
  const session = await api.exportBegin({ mode, format, defaultDir: state.dataset?.dir, baseName: state.dataset?.name });
  if (session.canceled) return;

  const total = state.items.length;
  const emptyCaptions = state.items.filter((i) => !i.caption.trim()).length;
  const t = toast(`Exporting 0 / ${total}…`, { timeout: 0 });
  el.exportFolderBtn.disabled = true;
  el.exportZipBtn.disabled = true;

  try {
    let n = 0;
    for (const item of [...state.items]) {
      const canvas = await renderItem(item, { background: format === 'jpg' ? '#ffffff' : null });
      const blob = await canvasToBlob(canvas, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.95);
      const data = new Uint8Array(await blob.arrayBuffer());
      await api.exportAddItem({ sessionId: session.sessionId, name: item.name, data, caption: item.caption.trim() });
      t.update(`Exporting ${++n} / ${total}…`);
    }
    t.update(mode === 'zip' ? `Writing ZIP…` : `Finishing…`);
    const res = await api.exportFinish({ sessionId: session.sessionId });
    t.close();
    toast(
      `Exported ${res.count} pair${res.count === 1 ? '' : 's'} to ${res.target}` +
        (emptyCaptions ? ` · ${emptyCaptions} with empty captions` : ''),
      {
        type: emptyCaptions ? 'warn' : 'success',
        timeout: 10000,
        action: {
          label: 'Open Folder',
          onClick: () => (res.mode === 'zip' ? api.showInFolder(res.target) : api.openPath(res.target)),
        },
      },
    );
  } catch (err) {
    api.exportCancel({ sessionId: session.sessionId });
    t.update(`Export failed: ${err.message}`, { type: 'error', timeout: 8000 });
  } finally {
    el.exportFolderBtn.disabled = false;
    el.exportZipBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Datasets: named folders that hold the images and the saved project state
// ---------------------------------------------------------------------------

const DATASET_SAVE_DELAY_MS = 700;
const datasetUI = { mode: 'create', list: [], root: '', saveTimer: null, busy: false };

/** Strip Electron's "Error invoking remote method ..." prefix from IPC errors. */
function ipcMessage(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} day${d === 1 ? '' : 's'} ago` : new Date(iso).toLocaleDateString();
}

/**
 * What gets written to dataset.json: everything needed to restore the queue, plus any
 * entries whose image couldn't be read this session (kept as-is so nothing is lost).
 */
function serializeDataset() {
  const loaded = state.items
    .filter((it) => it.file)
    .map((it) => ({
      file: it.file,
      originalName: it.originalName,
      origin: it.origin || null,
      name: it.name,
      sourceFormat: it.sourceFormat,
      naturalW: it.naturalW,
      naturalH: it.naturalH,
      crop: it.crop,
      outW: it.outW,
      outH: it.outH,
      caption: it.caption,
      status: it.status === 'processing' ? 'queued' : it.status,
    }));
  return [...loaded, ...(state.dataset?.unreadable || [])];
}

function setSaveState(kind, text) {
  el.datasetSaveState.className = `dataset-save ${kind}`;
  el.datasetSaveState.textContent = text;
}

function scheduleDatasetSave() {
  if (!state.dataset || datasetUI.busy) return;
  clearTimeout(datasetUI.saveTimer);
  setSaveState('saving', 'Saving…');
  datasetUI.saveTimer = setTimeout(saveDatasetNow, DATASET_SAVE_DELAY_MS);
}

async function saveDatasetNow() {
  clearTimeout(datasetUI.saveTimer);
  datasetUI.saveTimer = null;
  if (!state.dataset) return;
  const { name } = state.dataset;
  try {
    const res = await api.datasetSave({ name, items: serializeDataset() });
    if (!res.ok) throw new Error(res.error);
    if (state.dataset?.name !== name) return;
    const n = state.items.length;
    setSaveState('saved', `All changes saved · ${n} image${n === 1 ? '' : 's'}`);
    const row = datasetUI.list.find((d) => d.name === name);
    if (row) Object.assign(row, { count: n, updatedAt: res.updatedAt });
    renderDatasetList();
  } catch (err) {
    setSaveState('error', `Not saved: ${ipcMessage(err)}`);
  }
}

// Flush a pending save synchronously when the window closes, so no edit is lost.
window.addEventListener('beforeunload', () => {
  if (!state.dataset || !datasetUI.saveTimer) return;
  clearTimeout(datasetUI.saveTimer);
  api.datasetSaveSync({ name: state.dataset.name, items: serializeDataset() });
});

/** Adding images needs an open dataset; otherwise point the user at step 1. */
function requireDataset() {
  if (state.dataset) return true;
  toast('Create or open a dataset first (step 1).', { type: 'warn' });
  focusDatasetPanel();
  return false;
}

function focusDatasetPanel() {
  const panel = document.querySelector('.sidebar .panel[data-panel="dataset"]');
  if (panel.classList.contains('collapsed')) panel.querySelector('.panel-header').click();
  panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  panel.classList.remove('attention');
  void panel.offsetWidth;
  panel.classList.add('attention');
  el.datasetNameInput.focus();
}

/** Save in-memory image bytes (webcam, browser drags) into the dataset, then queue them. */
async function addBlobToDataset(blob, fileName, sourceFormat) {
  const data = new Uint8Array(await blob.arrayBuffer());
  const saved = await api.datasetWriteImage({ name: state.dataset.name, fileName, data });
  return addItemFromBlob(blob, { sourcePath: saved.path, fileName, sourceFormat, file: saved.file });
}

async function refreshDatasetList() {
  try {
    const info = await api.datasetsInfo();
    datasetUI.list = info.datasets;
    datasetUI.root = info.root;
  } catch (err) {
    toast(`Could not read datasets: ${ipcMessage(err)}`, { type: 'error' });
  }
  renderDatasetPanel();
}

function renderDatasetList() {
  const current = state.dataset?.name;
  el.datasetList.innerHTML = datasetUI.list
    .map((d) => {
      const active = d.name === current;
      const count = active ? state.items.length : d.count;
      const meta = `${count} image${count === 1 ? '' : 's'}${d.updatedAt ? ` · ${timeAgo(d.updatedAt)}` : ''}${d.managed ? '' : ' · not opened yet'}`;
      return `<button class="dataset-row${active ? ' active' : ''}" role="option" aria-selected="${active}" data-name="${escapeHtml(d.name)}" title="${active ? 'Currently open' : `Open ${escapeHtml(d.name)}`}">
        ${iconSvg('database', 15)}
        <span class="dataset-row-main">
          <span class="dataset-row-name">${escapeHtml(d.name)}</span>
          <span class="dataset-row-meta">${meta}</span>
        </span>
        ${active ? '<span class="dataset-row-open">OPEN</span>' : ''}
      </button>`;
    })
    .join('');
}

function renderDatasetPanel() {
  renderDatasetList();
  const open = !!state.dataset;
  el.datasetOpenFolderBtn.disabled = !open;
  el.datasetRenameBtn.disabled = !open;
  el.datasetDeleteBtn.disabled = !open;
  el.settingsRootPath.textContent = datasetUI.root;
  if (!open) setSaveState('', 'No dataset open.');
}

function setDatasetFormMode(mode) {
  datasetUI.mode = mode;
  const renaming = mode === 'rename';
  el.datasetNameInput.closest('.dataset-form').classList.toggle('renaming', renaming);
  el.datasetNameInput.value = renaming ? state.dataset.name : '';
  el.datasetNameInput.placeholder = renaming ? 'New name for this dataset' : 'New dataset name, e.g. Anime';
  el.datasetSubmitBtn.innerHTML = `${iconSvg(renaming ? 'pencil' : 'plus')}<span>${renaming ? 'Rename' : 'Create'}</span>`;
  el.datasetCancelBtn.classList.toggle('hidden', !renaming);
  if (renaming) {
    el.datasetNameInput.focus();
    el.datasetNameInput.select();
  }
}

async function openDataset(name) {
  if (state.dataset?.name === name) return;
  if (datasetUI.saveTimer) await saveDatasetNow();
  datasetUI.busy = true; // no autosaves while the queue is swapped out
  resetQueueView();
  const t = toast(`Opening ${name}…`, { timeout: 0 });
  try {
    const res = await api.datasetLoad(name);
    state.dataset = { name: res.name, dir: res.dir, unreadable: [] };
    state.settings.lastDataset = res.name;
    saveSettings();
    renderDatasetPanel();

    const limit = createLimiter(4);
    const blobs = await Promise.all(
      res.items.map((it) =>
        limit(async () => {
          try {
            const bytes = await api.readImageFile(it.path);
            return new Blob([bytes], { type: MIME_BY_EXT[splitExt(it.path).ext] || 'application/octet-stream' });
          } catch {
            return null;
          }
        }),
      ),
    );
    // Files that exist but can't be read or decoded stay in dataset.json untouched.
    const keepUnreadable = (it) => {
      const { path: _abs, ...entry } = it;
      state.dataset.unreadable.push(entry);
    };
    for (let i = 0; i < res.items.length; i++) {
      const it = res.items[i];
      if (!blobs[i]) {
        keepUnreadable(it);
        continue;
      }
      try {
        await addItemFromBlob(blobs[i], {
          sourcePath: it.path,
          fileName: it.originalName || basename(it.path),
          sourceFormat: it.sourceFormat,
          file: it.file,
          origin: it.origin,
          restore: it,
        });
      } catch {
        keepUnreadable(it);
      }
    }
    if (state.items[0]) selectItem(state.items[0].id, { scroll: false });
    const n = state.items.length;
    const unreadable = state.dataset.unreadable.length;
    const parts = [`Opened ${res.name} · ${n} image${n === 1 ? '' : 's'}`];
    if (res.imported) parts.push('imported from the folder');
    if (unreadable) parts.push(`${unreadable} image${unreadable === 1 ? '' : 's'} couldn't be read (kept in the folder, not removed)`);
    if (res.missing) parts.push(`${res.missing} missing file${res.missing === 1 ? '' : 's'} removed from the list`);
    t.update(parts.join(' · '), { type: unreadable || res.missing ? 'warn' : 'success', timeout: unreadable ? 7000 : 3500 });
    datasetUI.busy = false;
    if (res.missing) scheduleDatasetSave(); // only entries whose files are really gone are dropped
    else setSaveState('saved', `All changes saved · ${n} image${n === 1 ? '' : 's'}`);
  } catch (err) {
    state.dataset = null;
    t.update(`Could not open dataset: ${ipcMessage(err)}`, { type: 'error', timeout: 6000 });
  } finally {
    datasetUI.busy = false;
    renderDatasetPanel();
    updateStats();
  }
}

async function createDataset(name, { quiet = false } = {}) {
  const res = await api.datasetCreate(name);
  el.datasetNameInput.value = '';
  await refreshDatasetList();
  await openDataset(res.name);
  if (!quiet) toast(`Dataset ${res.name} created. Now add images in step 2.`, { type: 'success', timeout: 3500 });
}

async function renameDataset(to) {
  const from = state.dataset.name;
  if (state.batch.running) pauseBatch();
  await saveDatasetNow();
  datasetUI.busy = true;
  try {
    const res = await api.datasetRename({ from, to });
    state.dataset = { ...state.dataset, name: res.name, dir: res.dir };
    state.settings.lastDataset = res.name;
    saveSettings();
    const sep = res.dir.includes('\\') ? '\\' : '/';
    for (const it of state.items) if (it.file) it.sourcePath = `${res.dir}${sep}${it.file.split('/').join(sep)}`;
    setDatasetFormMode('create');
    toast(`Renamed ${from} to ${res.name}`, { type: 'success', timeout: 2500 });
  } finally {
    datasetUI.busy = false;
  }
  await refreshDatasetList();
  scheduleStepUpdate();
}

async function deleteDataset() {
  if (!state.dataset) return;
  const { name } = state.dataset;
  const n = state.items.length;
  const msg = `Delete dataset "${name}" and its ${n} image${n === 1 ? '' : 's'}?\n\nThe folder moves to the Recycle Bin, so it can still be restored.`;
  if (!confirm(msg)) return;
  clearTimeout(datasetUI.saveTimer);
  datasetUI.saveTimer = null;
  datasetUI.busy = true;
  resetQueueView();
  try {
    await api.datasetDelete(name);
    toast(`Moved ${name} to the Recycle Bin`, { type: 'success' });
  } catch (err) {
    toast(`Could not delete: ${ipcMessage(err)}`, { type: 'error' });
  }
  state.dataset = null;
  state.settings.lastDataset = null;
  saveSettings();
  datasetUI.busy = false;
  setDatasetFormMode('create');
  await refreshDatasetList();
  updateStats();
}

/** Change where datasets are stored (Settings). `pick` asks main for the new root. */
async function applyDatasetRoot(pick) {
  if (datasetUI.saveTimer) await saveDatasetNow();
  let res;
  try {
    res = await pick();
  } catch (err) {
    toast(`Could not change the folder: ${ipcMessage(err)}`, { type: 'error' });
    return;
  }
  if (res.canceled) return;
  if (res.root !== datasetUI.root) {
    // The open dataset lives in the old location, so close it.
    datasetUI.busy = true;
    resetQueueView();
    state.dataset = null;
    state.settings.lastDataset = null;
    saveSettings();
    datasetUI.busy = false;
    toast(`Datasets are now stored in ${res.root}`, { type: 'success', timeout: 4000 });
  }
  await refreshDatasetList();
  updateStats();
}

// ------------------------------ Settings window ------------------------------

function openSettings() {
  el.settingsRootPath.textContent = datasetUI.root;
  el.settingsModal.classList.remove('hidden');
  el.settingsDoneBtn.focus();
}

function closeSettings() {
  el.settingsModal.classList.add('hidden');
}

// ------------------------------ Drop target chooser ------------------------------

let pendingIncoming = null;

/** Ask which dataset newly dropped or picked images belong to. */
function openDropTarget(pending) {
  pendingIncoming = pending;
  const n = pending.paths.length + pending.loose.length;
  el.dropTargetTitle.textContent = `ADD ${n} IMAGE${n === 1 ? '' : 'S'} TO…`;
  el.dropTargetSummary.textContent = datasetUI.list.length
    ? `Choose which dataset ${n === 1 ? 'this image belongs' : `these ${n} images belong`} to, or create a new one.`
    : `Name a new dataset for ${n === 1 ? 'this image' : `these ${n} images`}.`;

  const current = state.dataset?.name;
  el.dropTargetList.innerHTML = datasetUI.list
    .map((d) => {
      const count = d.name === current ? state.items.length : d.count;
      return `<label class="target-option">
        <input type="radio" name="dropTarget" value="${escapeHtml(d.name)}" />
        ${iconSvg('database', 15)}
        <span class="target-main">
          <span class="target-name">${escapeHtml(d.name)}</span>
          <span class="target-meta">${count} image${count === 1 ? '' : 's'}${d.updatedAt ? ` · ${timeAgo(d.updatedAt)}` : ''}</span>
        </span>
        ${d.name === current ? '<span class="target-tag">OPEN</span>' : ''}
      </label>`;
    })
    .join('');

  el.dropNewName.value = '';
  selectDropTarget(current || '');
  el.dropTargetModal.classList.remove('hidden');
  if (current) el.dropTargetAddBtn.focus();
  else el.dropNewName.focus();
}

/** '' selects "New dataset"; otherwise the dataset with that name. */
function selectDropTarget(value) {
  for (const radio of el.dropTargetModal.querySelectorAll('input[name="dropTarget"]')) {
    radio.checked = radio.value === value;
    radio.closest('.target-option').classList.toggle('selected', radio.checked);
  }
}

function closeDropTarget() {
  el.dropTargetModal.classList.add('hidden');
  pendingIncoming = null;
}

async function confirmDropTarget() {
  const pending = pendingIncoming;
  if (!pending) return;
  const target = el.dropTargetModal.querySelector('input[name="dropTarget"]:checked')?.value ?? '';
  el.dropTargetAddBtn.disabled = true;
  try {
    if (!target) {
      const name = el.dropNewName.value.trim();
      if (!name) {
        el.dropNewName.classList.remove('shake');
        void el.dropNewName.offsetWidth;
        el.dropNewName.classList.add('shake');
        el.dropNewName.focus();
        return;
      }
      await createDataset(name, { quiet: true }); // throws (and keeps the dialog open) on a bad or duplicate name
    } else if (target !== state.dataset?.name) {
      await openDataset(target);
      if (state.dataset?.name !== target) return; // could not open it
    }
    closeDropTarget();
    await addIncomingImages(pending);
  } catch (err) {
    toast(ipcMessage(err), { type: 'error', timeout: 5000 });
  } finally {
    el.dropTargetAddBtn.disabled = false;
  }
}

async function submitDatasetForm() {
  const value = el.datasetNameInput.value.trim();
  if (!value) {
    el.datasetNameInput.focus();
    return;
  }
  el.datasetSubmitBtn.disabled = true;
  try {
    if (datasetUI.mode === 'rename') await renameDataset(value);
    else await createDataset(value);
  } catch (err) {
    toast(ipcMessage(err), { type: 'error', timeout: 5000 });
  } finally {
    el.datasetSubmitBtn.disabled = false;
  }
}

async function setupDatasets() {
  el.datasetSubmitBtn.addEventListener('click', submitDatasetForm);
  el.datasetCancelBtn.addEventListener('click', () => setDatasetFormMode('create'));
  el.datasetNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitDatasetForm();
    else if (e.key === 'Escape' && datasetUI.mode === 'rename') setDatasetFormMode('create');
  });
  el.datasetList.addEventListener('click', (e) => {
    const row = e.target.closest('.dataset-row');
    if (row) openDataset(row.dataset.name);
  });
  el.datasetOpenFolderBtn.addEventListener('click', () => state.dataset && api.datasetOpenFolder(state.dataset.name));
  el.datasetRenameBtn.addEventListener('click', () => state.dataset && setDatasetFormMode('rename'));
  el.datasetDeleteBtn.addEventListener('click', deleteDataset);

  // Settings window
  el.openSettingsBtn.addEventListener('click', openSettings);
  el.settingsCloseBtn.addEventListener('click', closeSettings);
  el.settingsDoneBtn.addEventListener('click', closeSettings);
  el.settingsModal.addEventListener('mousedown', (e) => e.target === el.settingsModal && closeSettings());
  el.settingsChangeRootBtn.addEventListener('click', () => applyDatasetRoot(api.datasetsChooseRoot));
  el.settingsResetRootBtn.addEventListener('click', () => applyDatasetRoot(api.datasetsResetRoot));
  el.settingsOpenRootBtn.addEventListener('click', () => api.datasetOpenFolder(null));

  // Drop target chooser
  el.dropTargetOptions.addEventListener('change', (e) => {
    if (e.target.name === 'dropTarget') selectDropTarget(e.target.value);
  });
  el.dropNewName.addEventListener('focus', () => selectDropTarget(''));
  el.dropNewName.addEventListener('input', () => selectDropTarget(''));
  el.dropNewName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmDropTarget();
  });
  el.dropTargetAddBtn.addEventListener('click', confirmDropTarget);
  el.dropTargetCancelBtn.addEventListener('click', closeDropTarget);
  el.dropTargetCloseBtn.addEventListener('click', closeDropTarget);
  el.dropTargetModal.addEventListener('mousedown', (e) => e.target === el.dropTargetModal && closeDropTarget());

  await refreshDatasetList();
  const last = state.settings.lastDataset;
  if (last && datasetUI.list.some((d) => d.name === last)) {
    await openDataset(last);
  } else {
    // Nothing open yet: make sure step 1 is visible.
    const panel = document.querySelector('.sidebar .panel[data-panel="dataset"]');
    if (panel.classList.contains('collapsed')) panel.querySelector('.panel-header').click();
    scheduleStepUpdate();
  }
}

// ---------------------------------------------------------------------------
// Window chrome & global wiring
// ---------------------------------------------------------------------------

/** System / Light / Dark switch. The preference lives in the main process (nativeTheme). */
async function setupTheme() {
  const sw = document.getElementById('themeSwitch');
  const render = ({ source, dark }) => {
    $$('.theme-btn', sw).forEach((b) => {
      const on = b.dataset.theme === source;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };

  sw.addEventListener('click', async (e) => {
    const btn = e.target.closest('.theme-btn');
    if (!btn) return;
    document.body.classList.add('theme-animating');
    render(await api.setTheme(btn.dataset.theme));
    setTimeout(() => document.body.classList.remove('theme-animating'), 250);
  });
  api.onThemeChanged(render);
  render(await api.getTheme());
}

/** Collapsible sidebar panels; collapsed state is persisted in settings. */
function setupPanels() {
  const collapsed = new Set(state.settings.collapsedPanels);

  const apply = (panel, isCollapsed) => {
    panel.classList.toggle('collapsed', isCollapsed);
    $('.panel-header', panel).setAttribute('aria-expanded', String(!isCollapsed));
  };

  $$('.sidebar .panel[data-panel]').forEach((panel) => {
    const key = panel.dataset.panel;
    apply(panel, collapsed.has(key));

    $('.panel-header', panel).addEventListener('click', () => {
      const isCollapsed = !panel.classList.contains('collapsed');
      apply(panel, isCollapsed);
      if (isCollapsed) collapsed.add(key);
      else collapsed.delete(key);
      state.settings.collapsedPanels = [...collapsed];
      saveSettings();

      // Cropper measures its container on mount, so rebuild it once the panel is visible again.
      if (key === 'crop' && !isCollapsed && state.crop.host === 'sidebar') {
        const item = currentCropItem();
        if (item) mountCropper('sidebar', item);
      }
    });
  });
}

async function setupWindowChrome() {
  const platform = await api.getPlatform();
  document.body.classList.add(`platform-${platform}`);

  el.windowControls.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-wc]');
    if (btn) api.windowControl(btn.dataset.wc);
  });
  $('.titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.no-drag')) api.windowControl('maximize');
  });

  const setMax = (maximized) => {
    const icon = document.getElementById('maxIcon');
    setIcon(icon, maximized ? 'restore' : 'maximize');
    icon.closest('button').title = maximized ? 'Restore' : 'Maximize';
  };
  api.onWindowState(({ maximized }) => setMax(maximized));
  setMax(await api.isMaximized());
}

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    const target = e.target instanceof Element ? e.target : document.body;
    const typing = target.closest('input, textarea, select');
    const modalOpen = !el.cropModal.classList.contains('hidden');

    if (!el.dropTargetModal.classList.contains('hidden')) {
      if (e.key === 'Escape') closeDropTarget();
      return;
    }
    if (!el.settingsModal.classList.contains('hidden')) {
      if (e.key === 'Escape') closeSettings();
      return;
    }
    if (setup?.isOpen()) {
      if (e.key === 'Escape') setup.close();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      startBatch();
      return;
    }
    if (modalOpen) {
      if (e.key === 'Escape') closeCropModal();
      else if (!typing && e.key === 'ArrowLeft') stepModal(-1);
      else if (!typing && e.key === 'ArrowRight') stepModal(1);
      else if (!typing && e.key === 'Enter') applyCropToCurrent();
      return;
    }
    if (typing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAllVisible();
    } else if (e.key === 'Escape') {
      clearSelection();
    } else if (e.key === 'Delete' && !target.closest('.card')) {
      deleteSelectionOr(state.selectedId);
    }
  });
}

function setupToolbar() {
  el.startBatchBtn.addEventListener('click', startBatch);
  el.pauseBatchBtn.addEventListener('click', pauseBatch);
  el.exportFolderBtn.addEventListener('click', () => exportDataset({ mode: 'folder' }));
  el.exportZipBtn.addEventListener('click', () => exportDataset({ mode: 'zip' }));
  el.refreshModelsBtn.addEventListener('click', () => checkOllama({ silent: false }));
  el.retryOllamaBtn.addEventListener('click', () => checkOllama({ silent: false }));

  el.modelSelect.addEventListener('change', () => {
    state.settings.model = el.modelSelect.value;
    saveSettings();
  });

  el.exportFormat.value = state.settings.exportFormat;
  el.exportFormat.addEventListener('change', () => {
    state.settings.exportFormat = el.exportFormat.value;
    saveSettings();
    state.items.forEach(updateCard);
    updateRenamePreview();
  });

  el.selectFilesBtn.addEventListener('click', selectFiles);
  el.selectDirBtn.addEventListener('click', selectDirectory);
  el.webcamToggleBtn.addEventListener('click', () => (state.webcam.stream ? stopWebcam() : startWebcam()));
  el.webcamDevice.addEventListener('change', () => startWebcam(el.webcamDevice.value));
  el.captureBtn.addEventListener('click', captureSnapshot);

  el.queueFilter.addEventListener('input', () => {
    state.filter = el.queueFilter.value.trim().toLowerCase();
    state.items.forEach(applyFilterTo);
  });

  const setView = (view) => {
    state.settings.view = view;
    el.queue.className = `queue ${view}`;
    $$('.seg-btn', el.viewToggle).forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    saveSettings();
  };
  el.viewToggle.addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (b) setView(b.dataset.view);
  });
  setView(state.settings.view === 'list' ? 'list' : 'grid');

  el.clearQueueBtn.addEventListener('click', clearQueue);

  el.selCropBtn.addEventListener('click', batchCenterCrop);
  el.selApplyCropBtn.addEventListener('click', applyCropToSelection);
  el.selCaptionBtn.addEventListener('click', captionSelection);
  el.selDeleteBtn.addEventListener('click', () => deleteSelectionOr(null));
  el.selClearBtn.addEventListener('click', clearSelection);
  setupMarquee();
}

async function init() {
  renderIcons();
  cacheDom();

  api.onCaptionToken(onCaptionToken);
  api.onCaptionThinking(onCaptionThinking);

  await setupWindowChrome();
  await setupTheme();
  setupPanels();
  setupToolbar();
  syncResizeForm();
  setupResizeControls();
  setupRenameControls();
  setupCaptionSettings();
  setupDragAndDrop();
  setupKeyboard();
  updateBatchButtons();
  updateStats();

  setup = createSetupAssistant({
    api,
    toast,
    getHost: () => state.settings.host,
    requiredModel: DEFAULT_MODEL,
    getShowOnLaunch: () => state.settings.showSetupOnLaunch !== false,
    setShowOnLaunch: (v) => {
      state.settings.showSetupOnLaunch = v;
      saveSettings();
    },
    onStatusChange: () => checkOllama(),
  });
  el.openSetupBtn.addEventListener('click', () => setup.open());
  el.bannerSetupBtn.addEventListener('click', () => setup.open());

  await setupDatasets();
  await checkOllama();
  await setup.checkOnLaunch();
  setInterval(() => {
    if (!state.batch.running) checkOllama();
  }, STATUS_POLL_MS);
}

/** Setup assistant instance (created in init). */
let setup = null;

/** Make sure Ollama and the selected model are usable; otherwise open the Setup Assistant. */
async function ensureCaptionReady() {
  if (!state.ollama.online) await checkOllama();
  if (!state.ollama.online) {
    toast('Ollama is not running. Opening the Setup Assistant…', { type: 'warn' });
    setup.open();
    return false;
  }
  const installed = state.ollama.models.some((m) => m.name === state.settings.model);
  if (!installed) {
    toast(`${state.settings.model} is not downloaded yet. Opening the Setup Assistant…`, { type: 'warn' });
    setup.open();
    return false;
  }
  return true;
}

init().catch((err) => {
  console.error(err);
  toast(`Startup error: ${err.message}`, { type: 'error', timeout: 0 });
});
