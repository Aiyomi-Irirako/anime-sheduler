import { DateTime } from "luxon";
import { fetchLiveChartEpisodes } from "./livechart.js";
import {
  mergeLanguageTracks,
  normalizeLanguageTracks,
  normalizePreferredScheduleLanguage
} from "./languages.js";
import { getNextRelease, getNextLanguageRelease, isUnpostedFinalMainRelease, isUnpostedFinalLanguageRelease,
  shouldDeleteFinishedSeries } from "./schedule.js";
import { scheduleDateFields } from "./livechartCatalog.js";
import { normalizeDailyTime } from "./utils.js";

const WEEKDAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const controllers = new WeakMap();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isLiveChartLink(value) {
  return typeof value === "string" && value.includes("livechart.me/anime/");
}

function parseLiveTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp === Number.MAX_SAFE_INTEGER) return null;
  return timestamp;
}

export function prepareLiveLanguageTracks(liveTracks = [], settings = {}) {
  const zone = settings.timeZone || "Europe/Berlin";
  return (Array.isArray(liveTracks) ? liveTracks : []).map((track) => {
    const timestamp = parseLiveTimestamp(track.releaseTimestamp);
    if (timestamp === null) return Object.hasOwn(track, 'schedulePrecision') ? { ...track, ...scheduleDateFields({
      timestamp: Number.MAX_SAFE_INTEGER, partialDate: track.releaseDate
    }, zone) } : track;

    const releaseAt = DateTime.fromMillis(timestamp * 1000, { zone: "utc" }).setZone(zone);
    if (!releaseAt.isValid) return track;

    return {
      ...track,
      nextDate: track.nextDate || releaseAt.toISODate(),
      releaseTime: track.releaseTime || releaseAt.toFormat("HH:mm")
    };
  });
}

export function prepareLiveMainSchedule(live = {}, settings = {}) {
  if (live.mainEpisodeUnknown) return scheduleDateFields(null);
  const timestamp = parseLiveTimestamp(live.mainReleaseTimestamp);
  if (timestamp === null) return live.mainScheduleKnown ? scheduleDateFields({
    timestamp: Number.MAX_SAFE_INTEGER, partialDate: live.mainReleaseDate
  }, settings.timeZone || 'Europe/Berlin') : {};

  const zone = settings.timeZone || "Europe/Berlin";
  const releaseAt = DateTime.fromMillis(timestamp * 1000, { zone: "utc" }).setZone(zone);
  if (!releaseAt.isValid) return {};

  return {
    nextDate: releaseAt.toISODate(),
    releaseTime: releaseAt.toFormat("HH:mm"),
    releaseDay: WEEKDAY_KEYS[releaseAt.weekday - 1] || ""
  };
}

function valueChanged(left, right) {
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

function comparableLanguageTracks(tracks = []) {
  return normalizeLanguageTracks(tracks).map(({ source, updatedAt, ...track }) => track);
}

function hasChanged(series, patch) {
  const keys = [
    "service",
    "status",
    "enabled",
    "nextEpisode",
    "episodeBatchSize",
    "episodeCount",
    "dubNextEpisode",
    "dubbed",
    "imageUrl",
    "languageTracks",
    "releaseDay",
    "releaseTime",
    "nextDate"
  ];

  return keys.some((key) => {
    if (key === "languageTracks") {
      return valueChanged(comparableLanguageTracks(series[key]), comparableLanguageTracks(patch[key]));
    }
    return valueChanged(series[key], patch[key]);
  });
}

export async function syncOneSeriesFromLiveChart(store, series, options = {}) {
  if (series.scheduleMode === "manual") return { changed: false, live: {}, skipped: true };
  const settings = store.getSettings();
  const now = options.now || DateTime.now();
  const preferredScheduleLanguage = normalizePreferredScheduleLanguage(series.liveChartImportLanguage || settings.preferredScheduleLanguage);
  const fetched = await (options.fetchEpisodes || fetchLiveChartEpisodes)(series.scheduleLink, {
    preferredLanguageCodes: preferredScheduleLanguage ? [preferredScheduleLanguage] : [],
    timeZone: settings.timeZone,
    requirePreferredLanguage: series.liveChartLanguageStrict,
    pendingLanguageTracks: series.languageTracks || [],
    nowTimestamp: Math.floor(now.toSeconds())
  });
  // A user can switch to manual scheduling while this request is in flight.
  // Keep their newly saved schedule instead of writing the older snapshot back.
  const current = store.getSeries(series.id);
  if (current?.scheduleMode === "manual") return { changed: false, live: {}, skipped: true, updated: current };
  const episodeCount = Number.isFinite(fetched.episodeCount) ? fetched.episodeCount : series.episodeCount;
  const live = { ...fetched, unscheduledLanguageTracks: (fetched.unscheduledLanguageTracks || []).filter(incoming => {
    const track = (series.languageTracks || []).find(item => item.code === incoming.code);
    // "Released" may replace a finale just before its scheduled announcement.
    // A missing/expired schedule is not evidence that a paused dub has finished.
    return !(track && (fetched.finishedLanguageCodes || []).includes(track.code) &&
      isUnpostedFinalLanguageRelease({ ...series, episodeCount }, track,
        getNextLanguageRelease({ ...series, episodeCount }, track, settings, now), settings, now));
  }) };
  const overwriteSchedule = Boolean(options.overwriteSchedule);
  const liveMainSchedule = overwriteSchedule ? live.mainUnavailable
    ? { nextDate: '', releaseDay: '', releaseTime: '' } : prepareLiveMainSchedule(live, settings) : {};
  const liveLanguageTracks = prepareLiveLanguageTracks([...(live.languageTracks || []), ...(live.unscheduledLanguageTracks || [])]
    .filter((track) => !series.liveChartImportLanguage || track.code === series.liveChartImportLanguage), settings);
  const languageTracks = mergeLanguageTracks(
    series.languageTracks || [],
    liveLanguageTracks,
    series.liveChartImportLanguage ? [series.liveChartImportLanguage] : settings.enabledLanguageCodes || []
  );
  const pendingFinal = live.mainFinished && isUnpostedFinalMainRelease(
    { ...series, episodeCount },
    getNextRelease({ ...series, episodeCount }, settings, now),
    settings,
    now
  );
  const mainFinished = live.mainFinished && !pendingFinal;
  const nextEpisode = live.mainUnavailable || live.mainEpisodeUnknown ? null : Number.isFinite(live.nextEpisode) ? live.nextEpisode : mainFinished ? null : series.nextEpisode;
  const episodeBatchSize =
    overwriteSchedule && Number.isFinite(live.nextEpisode)
      ? live.episodeBatchSize
      : live.episodeBatchSize > 1
        ? live.episodeBatchSize
        : series.episodeBatchSize;
  const hasMainEpisode = Number.isFinite(nextEpisode);
  const hasLanguageEpisode = languageTracks.some((track) => track.enabled && Number.isFinite(track.nextEpisode));
  const completedAfterSync = (mainFinished || series.status === "finished") && !hasMainEpisode && !hasLanguageEpisode;
  const reactivated = series.status === "finished" && !series.enabled && (hasMainEpisode || hasLanguageEpisode);
  const patch = {
    ...series,
    service: overwriteSchedule && live.service ? live.service : series.service || live.service,
    status: mainFinished ? "finished" : reactivated && hasMainEpisode ? "airing" : series.status,
    enabled: completedAfterSync ? false : reactivated ? true : series.enabled,
    nextEpisode,
    episodeBatchSize,
    episodeCount,
    releaseDay: liveMainSchedule.releaseDay ?? series.releaseDay,
    releaseTime: liveMainSchedule.releaseTime ?? series.releaseTime,
    nextDate: mainFinished && overwriteSchedule ? "" : liveMainSchedule.nextDate ?? series.nextDate,
    imageUrl: overwriteSchedule && live.imageUrl ? live.imageUrl : series.imageUrl || live.imageUrl,
    languageTracks,
    lastLiveChartCheckedAt: now.toISO()
  };

  if (!hasChanged(series, patch)) {
    return { changed: false, live };
  }

  const updated = await store.upsertSeries(patch, {
    source: options.source || (overwriteSchedule ? "pre-post-livechart-sync" : "livechart-sync")
  });
  return { changed: true, live, updated };
}

export async function syncAllLiveChart(store, options = {}) {
  const delayMs = options.delayMs ?? 6500;
  const overwriteSchedule = options.overwriteSchedule ?? true;
  const settings = store.getSettings();
  const seriesList = store
    .listSeries()
    .filter((series) => series.scheduleMode !== "manual" && isLiveChartLink(series.scheduleLink) && (series.enabled || series.status === "finished"));

  const result = {
    checked: 0,
    updated: 0,
    deleted: 0,
    failed: 0,
    rateLimited: false,
    changes: [],
    deletions: [],
    errors: []
  };
  const failedIds = new Set();
  const report = (title = '') => options.onProgress?.({
    checked: result.checked, total: seriesList.length, updated: result.updated,
    deleted: result.deleted, failed: result.failed, currentTitle: title
  });
  report();

  for (const series of seriesList) {
    report(series.title);
    result.checked += 1;
    try {
      const current = store.getSeries(series.id);
      if (!current) continue;

      const before = {
        nextEpisode: current.nextEpisode,
        episodeBatchSize: current.episodeBatchSize,
        episodeCount: current.episodeCount,
        status: current.status,
        enabled: current.enabled,
        dubNextEpisode: current.dubNextEpisode,
        dubbed: current.dubbed,
        languageTracks: current.languageTracks || []
      };
      const synced = await syncOneSeriesFromLiveChart(store, current, {
        overwriteSchedule,
        source: options.source || "livechart-sync",
        now: options.now,
        fetchEpisodes: options.fetchEpisodes
      });

      if (synced.changed) {
        result.updated += 1;
        result.changes.push({
          id: current.id,
          title: current.title,
          before,
          after: {
            nextEpisode: synced.updated.nextEpisode,
            episodeBatchSize: synced.updated.episodeBatchSize,
            episodeCount: synced.updated.episodeCount,
            releaseDay: synced.updated.releaseDay,
            releaseTime: synced.updated.releaseTime,
            nextDate: synced.updated.nextDate,
            status: synced.updated.status,
            enabled: synced.updated.enabled,
            dubNextEpisode: synced.updated.dubNextEpisode,
            dubbed: synced.updated.dubbed,
            imageUrl: synced.updated.imageUrl,
            languageTracks: synced.updated.languageTracks || []
          }
        });
      }

    } catch (error) {
      failedIds.add(series.id);
      result.failed += 1;
      result.errors.push({
        id: series.id,
        title: series.title,
        message: error.message
      });
      if ([403, 429].includes(error.status)) {
        result.rateLimited = true;
        break;
      }
    } finally {
      report();
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  if (!result.rateLimited) {
    for (const series of [...store.listSeries()]) {
      if (failedIds.has(series.id)) continue;
      if (!shouldDeleteFinishedSeries(series, settings, options.now)) continue;

      await store.deleteSeries(series.id, { source: "livechart-cleanup" });
      result.deleted += 1;
      result.deletions.push({
        id: series.id,
        title: series.title,
        episodeCount: series.episodeCount,
        episodeCountUpdatedAt: series.episodeCountUpdatedAt
      });
      report();
    }
  }

  const summary = `${result.checked} checked, ${result.updated} updated, ${result.deleted} deleted, ${result.failed} failed${
    result.rateLimited ? ", rate-limited" : ""
  }`;
  await store.markLiveChartSync({ summary });
  return { ...result, summary };
}

export function createLiveChartSyncController(store, {
  syncAll = syncAllLiveChart, syncOne = syncOneSeriesFromLiveChart, now = () => DateTime.now()
} = {}) {
  let job = { running: false, seriesId: '', progress: '', error: '', checked: 0, total: 0,
    updated: 0, deleted: 0, failed: 0, startedAt: '', finishedAt: '' };
  let task = null;
  return {
    start({ seriesId = '', patch } = {}) {
      if (job.running) throw new Error('A LiveChart sync is already running.');
      const series = seriesId ? store.getSeries(seriesId) : null;
      if (seriesId && !series) throw new Error('Series not found.');
      job = { running: true, seriesId, progress: series ? `Syncing ${series.title}` : 'Starting LiveChart sync',
        error: '', checked: 0, total: series ? 1 : 0, updated: 0, deleted: 0, failed: 0,
        startedAt: now().toISO(), finishedAt: '' };
      // Reserve the shared job before awaiting saves or HTTP, then let the web request finish.
      task = Promise.resolve().then(async () => {
        if (seriesId) {
          const current = store.getSeries(seriesId);
          if (!current) throw new Error('Series not found.');
          const saved = patch ? await store.upsertSeries({ ...current, ...patch }) : current;
          const result = await syncOne(store, saved, { overwriteSchedule: true, source: 'livechart-sync', now: now() });
          job.checked = 1;
          job.updated = result.changed ? 1 : 0;
          job.progress = `${saved.title}: ${result.changed ? 'LiveChart updated' : 'No changes found'}`;
          return result;
        }
        const result = await syncAll(store, { onProgress: (progress) => {
          Object.assign(job, progress);
          job.progress = `Syncing ${progress.checked}/${progress.total}${progress.currentTitle ? `: ${progress.currentTitle}` : ''}`;
        } });
        job.progress = `LiveChart sync: ${result.summary}`;
        job.error = (result.errors || []).slice(0, 3).map((error) => `${error.title}: ${error.message}`).join(' | ');
        return result;
      }).catch((error) => {
        job.error = error.message;
        job.failed += 1;
        job.progress = 'LiveChart sync failed';
        return null;
      }).finally(() => {
        job.running = false;
        job.finishedAt = now().toISO();
      });
      return task;
    },
    wait: () => task,
    status: () => ({ ...job })
  };
}

export function getLiveChartSyncController(store) {
  if (!controllers.has(store)) controllers.set(store, createLiveChartSyncController(store));
  return controllers.get(store);
}

export function shouldRunDailyLiveChartSync(settings, base = DateTime.now()) {
  if (!settings.liveChartSyncEnabled) return false;

  const zone = settings.timeZone || "Europe/Berlin";
  const now = base.setZone(zone);
  const [hour, minute] = normalizeDailyTime(settings.liveChartSyncTime, settings.liveChartSyncHour, 5).split(":").map(Number);
  if (now.hour * 60 + now.minute < hour * 60 + minute) return false;

  if (!settings.lastLiveChartSyncAt) return true;

  const last = DateTime.fromISO(settings.lastLiveChartSyncAt, { zone });
  if (!last.isValid) return true;
  return last.toISODate() !== now.toISODate();
}

export function startLiveChartDailySync(store, { controller = getLiveChartSyncController(store), now = () => DateTime.now() } = {}) {

  const runIfDue = async () => {
    if (controller.status().running) return;
    if (!shouldRunDailyLiveChartSync(store.getSettings(), now())) return;

    try {
      const result = await controller.start();
      console.log(`LiveChart daily sync: ${result?.summary || controller.status().error}`);
    } catch (error) {
      console.error(`LiveChart daily sync failed: ${error.stack || error.message}`);
    }
  };

  const timer = setInterval(runIfDue, 60 * 1000);
  runIfDue();
  return timer;
}
