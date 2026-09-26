(() => {
  const panel = document.querySelector('[data-livechart-sync-status]');
  if (!panel || panel.dataset.running !== 'true') return;
  const progress = panel.querySelector('[data-sync-progress]');
  const meter = panel.querySelector('[data-sync-meter]');
  const error = panel.querySelector('[data-sync-error]');
  const reload = panel.querySelector('[data-sync-reload]');
  let edited = false;
  document.querySelectorAll('form').forEach((form) => {
    form.addEventListener('input', () => { edited = true; });
    form.addEventListener('change', () => { edited = true; });
  });
  reload.addEventListener('click', (event) => { event.preventDefault(); location.reload(); });

  const poll = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/livechart/sync-status', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Status unavailable');
      const job = await response.json();
      progress.textContent = job.progress || 'No sync is running';
      error.textContent = job.error || '';
      error.hidden = !job.error;
      meter.max = Math.max(1, job.total || 0);
      meter.value = job.checked || 0;
      meter.hidden = !job.running;
      document.querySelectorAll('[data-livechart-sync-button]').forEach((button) => { button.disabled = job.running; });
      if (!job.startedAt) {
        error.textContent = 'Sync status was reset. The server may have restarted.';
        error.hidden = false;
        reload.hidden = false;
        return;
      }
      if (!job.running) {
        // Do not discard edits made while the background sync was running.
        if (!edited) return location.reload();
        reload.hidden = false;
        return;
      }
    } catch {
      error.textContent = 'Status unavailable. Reconnecting...';
      error.hidden = false;
    } finally {
      clearTimeout(timeout);
    }
    setTimeout(poll, 3000);
  };
  setTimeout(poll, 1000);
})();
