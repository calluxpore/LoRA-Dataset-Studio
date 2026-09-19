// Setup assistant (renderer): shows install steps for Ollama and the vision model,
// and whether each requirement is currently met. Information only; it runs nothing.

const POLL_MS = 4000;

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
 * @param {() => Promise<void>} opts.onStatusChange  called after a re-check
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
    checkOllama: $('checkOllama'),
    checkModel: $('checkModel'),
  };

  let online = false;
  let modelReady = false;
  let checking = false;
  let pollTimer = null;

  async function refresh() {
    if (checking) return isReady();
    checking = true;
    try {
      const status = await api.ollamaStatus(getHost());
      online = status.online;
      modelReady = online && status.models.some((m) => modelMatches(requiredModel, m.name));
    } finally {
      checking = false;
    }
    render();
    return isReady();
  }

  function isReady() {
    return online && modelReady;
  }

  function setCheck(node, ok, label) {
    node.classList.toggle('ok', ok);
    node.classList.toggle('missing', !ok);
    node.querySelector('.label').textContent = label;
  }

  function render() {
    setCheck(el.checkOllama, online, online ? 'Ollama running' : 'Ollama not running');
    setCheck(
      el.checkModel,
      modelReady,
      modelReady ? `${requiredModel} downloaded` : online ? `${requiredModel} not downloaded` : `${requiredModel}: waiting for Ollama`,
    );
    el.done.querySelector('span').textContent = isReady() ? 'Start using the app' : 'Close';
    el.done.classList.toggle('btn-primary', isReady());
    el.done.classList.toggle('btn-accent', !isReady());
  }

  // Re-check periodically while open, so finishing a step in the terminal is picked up.
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      if (el.modal.classList.contains('hidden')) return stopPolling();
      const wasReady = isReady();
      await refresh();
      if (isReady() !== wasReady) await opts.onStatusChange();
    }, POLL_MS);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function open() {
    el.showOnLaunch.checked = opts.getShowOnLaunch();
    el.modal.classList.remove('hidden');
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

  el.close.addEventListener('click', close);
  el.done.addEventListener('click', close);
  el.recheck.addEventListener('click', async () => {
    el.recheck.classList.add('spinning');
    await refresh();
    await opts.onStatusChange();
    el.recheck.classList.remove('spinning');
    toast(isReady() ? 'All set. Ready to caption!' : 'Not ready yet. Follow the steps above.', {
      type: isReady() ? 'success' : 'warn',
      timeout: 2500,
    });
  });
  el.showOnLaunch.addEventListener('change', () => opts.setShowOnLaunch(el.showOnLaunch.checked));
  el.modal.addEventListener('mousedown', (e) => {
    if (e.target === el.modal) close();
  });
  el.modal.addEventListener('click', (e) => {
    const copy = e.target.closest('.copy-btn');
    if (copy) {
      api.copyText(copy.dataset.copy).then(
        (ok) => toast(ok ? `Copied: ${copy.dataset.copy}` : 'Could not copy', { type: ok ? 'info' : 'error', timeout: 1800 }),
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

  return { open, close, isOpen, refresh, checkOnLaunch, isReady };
}
