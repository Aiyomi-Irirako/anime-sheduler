import { DateTime } from 'luxon';
import { fetchLiveChartHtml, liveChartId } from './livechartHttp.js';
import { parseSeasonCatalog, hasUpcomingGermanRelease, buildDiscoveredSeries } from './livechartCatalog.js';
import { normalizeDailyTime } from './utils.js';

const SEASONS = ['winter', 'spring', 'summer', 'fall'];
const controllers = new WeakMap();

export function normalizeDiscoverySeason(value) {
  return /^(winter|spring|summer|fall)-20\d{2}$/.test(value || '') ? value : 'auto';
}

export function discoverySeasons(settings, now = DateTime.now()) {
  const selected = normalizeDiscoverySeason(settings.liveChartDiscoverySeason);
  if (selected !== 'auto') return [selected];
  const date = now.setZone(settings.timeZone || 'Europe/Berlin');
  return [date, date.plus({ months: 3 })].map((value) => `${SEASONS[Math.floor((value.month - 1) / 3)]}-${value.year}`);
}

export function normalizeDiscoveryState(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const clean = (input) => typeof input === 'string' ? input.slice(0, 500) : '';
  // Only the latest run is retained, not a candidate list or a daily history.
  return {
    lastAttemptAt: clean(value.lastAttemptAt), lastSuccessAt: clean(value.lastSuccessAt),
    summary: clean(value.summary), error: clean(value.error)
  };
}

export function shouldRunDiscovery(settings, state, now = DateTime.now()) {
  if (!settings.liveChartDiscoveryEnabled) return false;
  const local = now.setZone(settings.timeZone || 'Europe/Berlin');
  const [hour, minute] = normalizeDailyTime(settings.liveChartDiscoveryTime, settings.liveChartDiscoveryHour, 6).split(':').map(Number);
  if (local.hour * 60 + local.minute < hour * 60 + minute) return false;
  const last = DateTime.fromISO(state.lastAttemptAt || '').setZone(local.zoneName);
  return !last.isValid || last.toISODate() !== local.toISODate();
}

export function hasExistingSeries(series, candidate) {
  return series.some((item) => liveChartId(item.scheduleLink) === candidate.id ||
    (candidate.malId && String(item.malId || '') === candidate.malId) ||
    (!liveChartId(item.scheduleLink) && !item.malId &&
      String(item.title || '').trim().toLowerCase() === candidate.title.trim().toLowerCase()));
}

export function createDiscoveryController(store, { fetchHtml = fetchLiveChartHtml, now = () => DateTime.now() } = {}) {
  let job = { running: false, progress: '', error: '' };
  let task = null;
  const check = async () => {
    const settings = { ...store.getSettings() };
    const last = DateTime.fromISO(store.getDiscovery().lastAttemptAt || '');
    if (last.isValid && now().diff(last, 'hours').hours < 1) {
      throw new Error('The next new-series check is available one hour after the previous attempt.');
    }
    await store.updateDiscovery({ lastAttemptAt: now().toISO(), error: '' });
    const result = { checked: 0, added: 0, skipped: 0, failed: 0 };
    const errors = [];
    const summary = () => `${result.checked} missing titles checked, ${result.added} added, ${result.skipped} without upcoming German releases, ${result.failed} failed.`;
    try {
      const catalog = new Map();
      for (const season of discoverySeasons(settings, now())) {
        job.progress = `Reading ${season}`;
        const html = await fetchHtml(`https://www.livechart.me/${season}/all`);
        for (const item of parseSeasonCatalog(html, season)) catalog.set(item.id, item);
      }
      if (catalog.size > 600) throw new Error('More than 600 season titles found; refusing an unexpectedly large scan.');
      const missing = [...catalog.values()].filter((item) => !hasExistingSeries(store.listSeries(), item));
      for (const [index, candidate] of missing.entries()) {
        if (hasExistingSeries(store.listSeries(), candidate)) continue;
        job.progress = `${index + 1}/${missing.length}: ${candidate.title}`;
        result.checked += 1;
        try {
          const html = await fetchHtml(candidate.scheduleLink);
          if (!hasUpcomingGermanRelease(html, settings, now())) {
            result.skipped += 1;
            continue;
          }
          const details = await fetchHtml(`https://www.livechart.me/anime/${candidate.id}`, { ttlMs: 24 * 3600000 });
          const series = buildDiscoveredSeries(candidate, html, details, {
            ...settings, preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de']
          }, now());
          // CSV/manual imports can complete while HTTP requests are in flight.
          if (hasExistingSeries(store.listSeries(), candidate)) continue;
          await store.upsertSeries({ ...series, liveChartImportLanguage: 'de' }, { source: 'livechart-import' });
          result.added += 1;
        } catch (error) {
          result.failed += 1;
          if ([403, 429].includes(error.status)) throw error;
          if (errors.length < 3) errors.push(`${candidate.title}: ${error.message}`);
        }
      }
      await store.updateDiscovery({ lastSuccessAt: now().toISO(), summary: summary(), error: errors.join(' | ') });
      job.progress = summary();
      job.error = errors.join(' | ');
      return result;
    } catch (error) {
      await store.updateDiscovery({ summary: summary(), error: error.message });
      throw error;
    }
  };
  return {
    start() {
      if (job.running) throw new Error('A new-series check is already running.');
      job = { running: true, progress: 'Checking for new German releases', error: '' };
      task = (async () => {
        try { return await check(); }
        catch (error) { job.error = error.message; return null; }
        finally { job.running = false; }
      })();
      return task;
    },
    wait: () => task,
    status: () => ({ ...job })
  };
}

export function getDiscoveryController(store) {
  if (!controllers.has(store)) controllers.set(store, createDiscoveryController(store));
  return controllers.get(store);
}

export function startDailyDiscovery(store) {
  const controller = getDiscoveryController(store);
  const run = () => {
    if (!controller.status().running && shouldRunDiscovery(store.getSettings(), store.getDiscovery())) {
      controller.start().then(() => {
        const status = controller.status();
        console.log(`LiveChart new-series check: ${status.error || status.progress}`);
      }).catch((error) => console.error(`LiveChart new-series check: ${error.message}`));
    }
  };
  const timer = setInterval(run, 60000);
  run();
  return timer;
}
