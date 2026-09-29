(() => {
  const form = document.getElementById('series-form');
  if (!form) return;
  const field = (name) => form.elements.namedItem(name);
  const link = field('scheduleLink');
  const title = field('title');
  const button = form.querySelector('[data-livechart-import]');
  const status = form.querySelector('[data-livechart-import-status]');
  const titleStatus = document.getElementById('series-title-status');
  const revisions = new Map();
  let sequence = 0, automaticTitle = '', titleTimer, controller;
  const valueOf = (input) => input.type === 'checkbox' ? input.checked : input.value;
  const rememberEdit = (event) => {
    if (event.target.name) revisions.set(event.target.name, (revisions.get(event.target.name) || 0) + 1);
  };
  form.addEventListener('input', rememberEdit);
  form.addEventListener('change', rememberEdit);
  const snapshot = () => new Map(Array.from(form.elements)
    .filter((input) => input.name)
    .map((input) => [input.name, { value: valueOf(input), revision: revisions.get(input.name) || 0 }]));
  const unchanged = (name, before) => {
    const input = field(name), previous = before.get(name);
    return input && previous && valueOf(input) === previous.value && (revisions.get(name) || 0) === previous.revision;
  };
  const setField = (name, value, before) => {
    if (before && !unchanged(name, before)) return false;
    const input = field(name);
    if (!input) return false;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value == null ? '' : String(value);
    revisions.set(name, (revisions.get(name) || 0) + 1);
    return true;
  };
  const animeId = () => {
    try {
      const url = new URL(link.value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password ||
          !['livechart.me', 'www.livechart.me'].includes(url.hostname)) return '';
      return url.pathname.match(/^\/anime\/(\d+)(?:\/|$)/)?.[1]?.replace(/^0+/, '') || '';
    } catch { return ''; }
  };
  const showDuplicate = (target, data) => {
    target.textContent = 'Series already exists: ';
    const existing = document.createElement('a');
    existing.href = '/series/' + encodeURIComponent(data.existingSeriesId);
    existing.textContent = data.title || 'Open existing series';
    target.append(existing);
  };
  const updateTitleRequired = () => { title.required = !animeId(); };

  // Retain the lightweight title lookup for new entries. A full import is explicit.
  const lookupTitle = async () => {
    if (form.dataset.seriesId || !animeId() || (title.value.trim() && title.value !== automaticTitle)) return;
    const current = ++sequence, originalLink = link.value, before = snapshot();
    titleStatus.textContent = 'Loading title...';
    try {
      const response = await fetch('/api/livechart/title', { method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduleLink: originalLink }) });
      const data = await response.json();
      if (current !== sequence || link.value !== originalLink) return;
      if (data.existingSeriesId) return showDuplicate(titleStatus, data);
      if (!response.ok) throw new Error(data.error || 'Could not load the title.');
      if (setField('title', data.title, before)) automaticTitle = data.title;
      titleStatus.textContent = '';
    } catch (error) {
      if (current === sequence) titleStatus.textContent = error.message;
    }
  };
  link.addEventListener('input', () => {
    clearTimeout(titleTimer);
    sequence += 1;
    controller?.abort();
    button.disabled = false;
    status.textContent = '';
    if (automaticTitle && title.value === automaticTitle) title.value = '';
    automaticTitle = '';
    if (titleStatus) titleStatus.textContent = '';
    updateTitleRequired();
    if (!form.dataset.seriesId) titleTimer = setTimeout(lookupTitle, 700);
  });

  button.addEventListener('click', async () => {
    clearTimeout(titleTimer);
    sequence += 1;
    controller?.abort();
    if (!animeId()) { status.textContent = 'Enter a valid LiveChart anime link.'; return; }
    const current = sequence, originalLink = link.value, before = snapshot();
    const keepTitle = title.value.trim() && title.value !== automaticTitle;
    controller = new AbortController();
    const requestController = controller;
    const timeout = setTimeout(() => requestController.abort(), 120000);
    button.disabled = true;
    status.textContent = 'Loading series from LiveChart...';
    if (titleStatus) titleStatus.textContent = '';
    try {
      const response = await fetch('/api/livechart/series-preview', { method: 'POST', cache: 'no-store', signal: requestController.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduleLink: originalLink, seriesId: form.dataset.seriesId || undefined }) });
      const data = await response.json();
      if (current !== sequence || link.value !== originalLink) return;
      if (data.existingSeriesId) return showDuplicate(status, data);
      if (!response.ok) throw new Error(data.error || 'Could not load the series from LiveChart.');
      const draft = data.draft;
      if (!draft || typeof draft !== 'object') throw new Error('LiveChart returned no series draft.');
      const fields = ['service', 'preferredService', 'status', 'premiereDate', 'releaseDay', 'releaseTime',
        'nextDate', 'nextEpisode', 'episodeBatchSize', 'episodeCount', 'imageUrl', 'enabled', 'weekly',
        'scheduleMode', 'liveChartImportLanguage', 'malId', 'rawRelease', 'scheduleLink'];
      for (const name of fields) {
        if (Object.hasOwn(draft, name)) setField(name, draft[name], before);
      }
      if (Object.hasOwn(draft, 'liveChartLanguageStrict')) {
        setField('liveChartLanguageStrict', draft.liveChartLanguageStrict ? '1' : '0', before);
      }
      if (!keepTitle && Object.hasOwn(draft, 'title') && setField('title', draft.title, before)) automaticTitle = draft.title;
      for (const track of Array.isArray(draft.languageTracks) ? draft.languageTracks : []) {
        const key = String(track.code || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
        const fields = { enabled: 'Enabled', available: 'Available', nextEpisode: 'Episode', episodeBatchSize: 'BatchSize',
          releaseDay: 'ReleaseDay', releaseTime: 'ReleaseTime', nextDate: 'NextDate', weekly: 'Weekly' };
        for (const [property, suffix] of Object.entries(fields)) {
          if (!Object.hasOwn(track, property)) continue;
          const value = ['available', 'weekly'].includes(property) ? (track[property] ? '1' : '0') : track[property];
          setField(`language${suffix}_${key}`, value, before);
        }
      }
      form.dispatchEvent(new Event('input', { bubbles: true }));
      updateTitleRequired();
      status.textContent = draft.scheduleMode === 'manual'
        ? 'No upcoming German release on LiveChart; enter date/service manually. Existing schedule fields were kept. Review and save when ready.'
        : 'LiveChart draft loaded. Review the dates, services and language versions, then save when ready.';
    } catch (error) {
      if (current === sequence) status.textContent = error.name === 'AbortError'
        ? 'LiveChart took too long. Please try again.' : error.message;
    } finally {
      clearTimeout(timeout);
      if (current === sequence) button.disabled = false;
    }
  });

  form.querySelectorAll('[data-release-preset]').forEach((preset) => preset.addEventListener('click', () => {
    const target = form.querySelector('[data-release-preset-status]');
    const complete = preset.dataset.releasePreset === 'complete';
    const count = Number(field('episodeCount').value);
    if (complete && (!Number.isInteger(count) || count < 1)) {
      target.textContent = 'Enter the total episode count before choosing Complete series.';
      return;
    }
    if (complete || !field('nextEpisode').value.trim()) setField('nextEpisode', 1);
    setField('episodeBatchSize', complete ? count : 1);
    setField('weekly', !complete);
    setField('enabled', true);
    if (field('status').value === 'finished') setField('status', 'planned');
    form.dispatchEvent(new Event('input', { bubbles: true }));
    target.textContent = complete ? `Main release set to all ${count} episodes. Enter the release date and time.`
      : 'Main release set to one episode per week. Enter the next episode, date and time.';
  }));
  updateTitleRequired();
})();
