// Setup assistant (renderer): guides the user through installing/starting Ollama
// and downloading the vision model, automating each step where possible.

import { iconSvg } from './icons.js';

const POLL_MS = 4000;
const MODEL_SIZE_HINT = 'about 1.6 GB';

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function modelMatches(want, name) {
  return name === want || name === `${want}:latest` || name.split(':')[0] === want;
}

/**
 * @param {object} opts
 * @param {object} opts.api            window.electronAPI
 * @param {Function} opts.toast
 * @param {() => string} opts.getHost
 * @param {string} opts.requiredModel
 * @param {() => boolean} opts.getShowOnLaunch
 * @param {(v: boolean) => void} opts.setShowOnLaunch
 * @param {() => Promise<void>} opts.onStatusChange  called after Ollama/model state changes
 */
export function createSetupAssistant(opts) {
  const { api, toast, getHost, requiredModel } = opts;
  const $ = (id) => document.getElementById(id);
  const el = {
    modal: $('setupModal'),
    close: $('setupCloseBtn'),
    done: $('setupDoneBtn'),
    recheck: $('setupRecheckBtn'),
    showOnLaunch: $('setupShowOnLaunch'),
    ollamaIcon: $('stepOllamaIcon'),
    ollamaDetail: $('stepOllamaDetail'),
    ollamaActions: $('stepOllamaActions'),
    ollamaManual: $('ollamaManual'),
    installProgress: $('installProgress'),
    installFill: $('installProgressFill'),
    installText: $('installProgressText'),
    modelIcon: $('stepModelIcon'),
    modelDetail: $('stepModelDetail'),
    modelActions: $('stepModelActions'),
    modelManual: $('modelManual'),
    modelName: $('setupModelName'),
    pullProgress: $('pullProgress'),
    pullFill: $('pullProgressFill'),
    pullText: $('pullProgressText'),
  };

  const s = {
    detect: null,
    models: [],
    modelReady: false,
    checking: false,
    starting: false,
    installing: false,
    installerLaunched: false,
    pulling: false,
    pullLayers: new Map(),
    pollTimer: null,
  };

  el.modelName.textContent = requiredModel;

  // ------------------------------------------------------------------ status

  async function refresh() {
    if (s.checking) return isReady();
    s.checking = true;
    try {
      const host = getHost();
      s.detect = await api.ollamaDetect(host);
      if (s.detect.reachable) {
        const status = await api.ollamaStatus(host);
        s.models = status.online ? status.models : [];
      } else {
        s.models = [];
      }
      s.modelReady = s.models.some((m) => modelMatches(requiredModel, m.name));
      if (s.detect.reachable) s.installerLaunched = false;
    } finally {
      s.checking = false;
    }
    render();
    return isReady();
  }

  function isReady() {
    return !!(s.detect?.reachable && s.modelReady);
  }

  // ------------------------------------------------------------------ rendering

  function setIcon(node, kind) {
    const icon = { ok: 'check', warn: 'alert', error: 'x', busy: 'loader', pending: 'info' }[kind];
    node.className = `step-status ${kind}`;
    node.innerHTML = iconSvg(icon, 18);
  }

  function button(label, icon, onClick, { primary = false, disabled = false } = {}) {
    const b = document.createElement('button');
    b.className = `btn ${primary ? 'btn-accent' : ''}`;
    b.innerHTML = `${iconSvg(icon)}<span>${escapeHtml(label)}</span>`;
    b.disabled = disabled;
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    const d = s.detect;
    const host = getHost();
    el.ollamaActions.innerHTML = '';
    el.modelActions.innerHTML = '';

    // Step 1: Ollama
    if (!d) {
      setIcon(el.ollamaIcon, 'busy');
      el.ollamaDetail.textContent = 'Checking…';
    } else if (d.reachable) {
      setIcon(el.ollamaIcon, 'ok');
      el.ollamaDetail.innerHTML = `Ollama${d.version ? ` <b>${escapeHtml(d.version)}</b>` : ''} is running at <code>${escapeHtml(host)}</code>.`;
    } else if (!d.local) {
      setIcon(el.ollamaIcon, 'error');
      el.ollamaDetail.innerHTML = `Can't reach <code>${escapeHtml(host)}</code>. Start Ollama on that machine, or change <b>Ollama host</b> in Caption Settings to <code>http://localhost:11434</code>.`;
    } else if (s.starting) {
      setIcon(el.ollamaIcon, 'busy');
      el.ollamaDetail.textContent = 'Starting Ollama… this can take a few seconds.';
    } else if (d.installed) {
      setIcon(el.ollamaIcon, 'warn');
      el.ollamaDetail.innerHTML = `Ollama is installed${d.exePath ? ` (<code>${escapeHtml(d.exePath)}</code>)` : ''} but not running.`;
      el.ollamaActions.append(button('Start Ollama', 'play', startOllama, { primary: true }));
    } else if (s.installing) {
      setIcon(el.ollamaIcon, 'busy');
      el.ollamaDetail.textContent = 'Downloading the official Ollama installer…';
      el.ollamaActions.append(button('Cancel', 'x', () => api.ollamaInstallCancel()));
    } else if (s.installerLaunched) {
      setIcon(el.ollamaIcon, 'busy');
      el.ollamaDetail.innerHTML =
        'The Ollama installer is open. <b>Finish the setup wizard</b>; this assistant detects Ollama automatically when it starts.';
      el.ollamaActions.append(button('Run installer again', 'download', installOllama));
    } else {
      setIcon(el.ollamaIcon, 'error');
      el.ollamaDetail.textContent = 'Ollama is not installed on this computer.';
      if (d.canAutoInstall) {
        el.ollamaActions.append(
          button('Download & Install Ollama', 'download', installOllama, { primary: true }),
          button('Open download page', 'external', () => api.openExternal(d.downloadPage)),
        );
      } else {
        el.ollamaActions.append(
          button('Open Ollama download page', 'external', () => api.openExternal(d.downloadPage), { primary: true }),
        );
      }
    }

    // Step 2: model
    if (!d?.reachable) {
      setIcon(el.modelIcon, 'pending');
      el.modelDetail.textContent = 'Available once Ollama is running.';
    } else if (s.modelReady) {
      setIcon(el.modelIcon, 'ok');
      const m = s.models.find((x) => modelMatches(requiredModel, x.name));
      el.modelDetail.innerHTML = `<code>${escapeHtml(m.name)}</code> is downloaded and ready${m.size ? ` (${formatBytes(m.size)})` : ''}.`;
    } else if (s.pulling) {
      setIcon(el.modelIcon, 'busy');
      el.modelDetail.textContent = `Downloading ${requiredModel}… you can keep using the app meanwhile.`;
      el.modelActions.append(button('Cancel download', 'x', () => api.ollamaPullCancel(requiredModel)));
    } else {
      setIcon(el.modelIcon, 'warn');
      el.modelDetail.innerHTML = `The vision model isn't downloaded yet (${MODEL_SIZE_HINT}).`;
      el.modelActions.append(button(`Download ${requiredModel}`, 'download', pullModel, { primary: true }));
    }

    el.installProgress.classList.toggle('hidden', !s.installing);
    el.pullProgress.classList.toggle('hidden', !s.pulling);
    el.done.querySelector('span').textContent = isReady() ? 'Start using the app' : 'Close';
    el.done.classList.toggle('btn-primary', isReady());
    el.done.classList.toggle('btn-accent', !isReady());
    renderManual();
  }

  function cmd(text) {
    return `<div class="cmd"><code>${escapeHtml(text)}</code><button class="icon-btn copy-btn" data-copy="${escapeHtml(text)}" title="Copy">${iconSvg('copy', 14)}</button></div>`;
  }

  function link(label, url) {
    return `<a href="#" class="ext-link" data-url="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
  }

  let manualPlatform = null;
  function renderManual() {
    const platform = s.detect?.platform || 'win32';
    if (manualPlatform === platform) return;
    manualPlatform = platform;
    const page = 'https://ollama.com/download';

    let install;
    if (platform === 'win32') {
      install = `
        <ol>
          <li>Download <b>OllamaSetup.exe</b> from ${link('ollama.com/download', page)} and run it.</li>
          <li>Ollama starts automatically and appears in the system tray. If it isn't running, open <b>Ollama</b> from the Start menu, or run:${cmd('ollama serve')}</li>
        </ol>
        <p class="muted">Or install from a terminal with winget:</p>${cmd('winget install Ollama.Ollama')}`;
    } else if (platform === 'darwin') {
      install = `
        <ol>
          <li>Download Ollama for macOS from ${link('ollama.com/download', page)}, move it to <b>Applications</b> and open it.</li>
          <li>Or use Homebrew, then start the server:${cmd('brew install ollama')}${cmd('ollama serve')}</li>
        </ol>`;
    } else {
      install = `
        <ol>
          <li>Install with the official script (see ${link('ollama.com/download', page)}):${cmd('curl -fsSL https://ollama.com/install.sh | sh')}</li>
          <li>Start the server if it isn't already running as a service:${cmd('ollama serve')}</li>
        </ol>`;
    }
    el.ollamaManual.innerHTML = `${install}<p class="muted">Then click <b>Re-check</b>.</p>`;
    el.modelManual.innerHTML = `
      <p>In a terminal, run:</p>${cmd(`ollama pull ${requiredModel}`)}
      <p class="muted">Verify it with <code>ollama list</code>, then click <b>Re-check</b>. Any other Ollama vision model also works: pick it from the model dropdown in the title bar.</p>`;
  }

  // ------------------------------------------------------------------ actions

  async function startOllama() {
    s.starting = true;
    render();
    const res = await api.ollamaStart(getHost());
    s.starting = false;
    if (res.ok) toast('Ollama is running.', { type: 'success', timeout: 2500 });
    else toast(`Could not start Ollama: ${res.error}`, { type: 'error', timeout: 8000 });
    await refresh();
    await opts.onStatusChange();
  }

  async function installOllama() {
    s.installing = true;
    el.installFill.style.width = '0%';
    el.installText.textContent = 'Connecting…';
    render();
    const res = await api.ollamaInstall();
    s.installing = false;
    if (res.ok && res.openedPage) {
      toast('Opened the Ollama download page in your browser.', { timeout: 4000 });
    } else if (res.ok) {
      s.installerLaunched = true;
      toast('Ollama installer launched. Finish the wizard to continue.', { type: 'success', timeout: 6000 });
    } else if (!res.aborted) {
      toast(`Installer download failed: ${res.error}. Use "Open download page" instead.`, { type: 'error', timeout: 9000 });
    }
    render();
    startPolling();
  }

  async function pullModel() {
    s.pulling = true;
    s.pullLayers.clear();
    el.pullFill.style.width = '0%';
    el.pullText.textContent = 'Contacting registry…';
    render();
    const res = await api.ollamaPull({ model: requiredModel, host: getHost() });
    s.pulling = false;
    if (res.ok) toast(`${requiredModel} downloaded. Ready to caption!`, { type: 'success', timeout: 5000 });
    else if (res.aborted) toast('Model download cancelled.', { type: 'warn' });
    else toast(`Model download failed: ${res.error}`, { type: 'error', timeout: 9000 });
    await refresh();
    await opts.onStatusChange();
  }

  function onInstallProgress({ received, total }) {
    const pct = total ? (received / total) * 100 : 0;
    el.installFill.style.width = `${pct.toFixed(1)}%`;
    el.installText.textContent = total
      ? `${formatBytes(received)} / ${formatBytes(total)} (${pct.toFixed(0)}%)`
      : formatBytes(received);
  }

  function onPullProgress(p) {
    if (p.model !== requiredModel) return;
    if (p.digest && p.total) s.pullLayers.set(p.digest, { completed: p.completed, total: p.total });
    let done = 0;
    let total = 0;
    for (const l of s.pullLayers.values()) {
      done += l.completed;
      total += l.total;
    }
    const pct = total ? (done / total) * 100 : 0;
    if (total) el.pullFill.style.width = `${pct.toFixed(1)}%`;
    if (p.status.startsWith('pulling') && total) {
      el.pullText.textContent = `Downloading ${formatBytes(done)} / ${formatBytes(total)} (${pct.toFixed(0)}%)`;
    } else if (p.status) {
      el.pullText.textContent = p.status.charAt(0).toUpperCase() + p.status.slice(1);
      if (p.status === 'success') el.pullFill.style.width = '100%';
    }
  }

  // ------------------------------------------------------------------ modal

  function startPolling() {
    stopPolling();
    s.pollTimer = setInterval(async () => {
      if (el.modal.classList.contains('hidden')) return stopPolling();
      if (s.starting || s.pulling || s.installing) return;
      const wasReachable = !!s.detect?.reachable;
      const wasReady = isReady();
      await refresh();
      if (s.detect?.reachable !== wasReachable || isReady() !== wasReady) await opts.onStatusChange();
    }, POLL_MS);
  }

  function stopPolling() {
    clearInterval(s.pollTimer);
    s.pollTimer = null;
  }

  async function open() {
    el.showOnLaunch.checked = opts.getShowOnLaunch();
    el.modal.classList.remove('hidden');
    // Don't show a stale result (e.g. a previous host) while re-checking.
    if (!s.starting && !s.installing && !s.pulling) {
      s.detect = null;
      s.modelReady = false;
    }
    render();
    await refresh();
    startPolling();
  }

  function close() {
    el.modal.classList.add('hidden');
    stopPolling();
  }

  function isOpen() {
    return !el.modal.classList.contains('hidden');
  }

  /** Called once at startup: opens the assistant if something is missing. */
  async function checkOnLaunch() {
    const ready = await refresh();
    if (!ready && opts.getShowOnLaunch()) await open();
    return ready;
  }

  // ------------------------------------------------------------------ wiring

  el.close.addEventListener('click', close);
  el.done.addEventListener('click', close);
  el.recheck.addEventListener('click', async () => {
    el.recheck.classList.add('spinning');
    await refresh();
    await opts.onStatusChange();
    el.recheck.classList.remove('spinning');
  });
  el.showOnLaunch.addEventListener('change', () => opts.setShowOnLaunch(el.showOnLaunch.checked));
  el.modal.addEventListener('mousedown', (e) => {
    if (e.target === el.modal) close();
  });
  el.modal.addEventListener('click', (e) => {
    const copy = e.target.closest('.copy-btn');
    if (copy) {
      navigator.clipboard.writeText(copy.dataset.copy).then(
        () => toast('Copied to clipboard', { timeout: 1500 }),
        () => toast('Could not copy', { type: 'error' }),
      );
      return;
    }
    const ext = e.target.closest('.ext-link');
    if (ext) {
      e.preventDefault();
      api.openExternal(ext.dataset.url);
    }
  });
  api.onSetupProgress(onInstallProgress);
  api.onPullProgress(onPullProgress);

  return { open, close, isOpen, refresh, checkOnLaunch, isReady };
}
