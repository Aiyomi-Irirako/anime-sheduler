import { DateTime } from "luxon";
import { fetchLiveChartEpisodes } from "./livechart.js";
import {
  mergeLanguageTracks,
  normalizeLanguageTracks,
  normalizePreferredScheduleLanguage
} from "./languages.js";
import { shouldDeleteFinishedSeries } from "./schedule.js";

const WEEKDAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

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
    if (timestamp === null) return track;

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
  const timestamp = parseLiveTimestamp(live.mainReleaseTimestamp);
  if (timestamp === null) return {};

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
  const settings = store.getSettings();
  const preferredScheduleLanguage = normalizePreferredScheduleLanguage(settings.preferredScheduleLanguage);
  const live = await fetchLiveChartEpisodes(series.scheduleLink, {
    preferredLanguageCodes: preferredScheduleLanguage ? [preferredScheduleLanguage] : []
  });
  const overwriteSchedule = Boolean(options.overwriteSchedule);
  const liveMainSchedule = overwriteSchedule ? prepareLiveMainSchedule(live, settings) : {};
  const liveLanguageTracks = prepareLiveLanguageTracks(live.languageTracks || [], settings);
  const languageTracks = mergeLanguageTracks(
    series.languageTracks || [],
    liveLanguageTracks,
    settings.enabledLanguageCodes || []
  );
  const nextEpisode = Number.isFinite(live.nextEpisode) ? live.nextEpisode : live.mainFinished ? null : series.nextEpisode;
  const episodeBatchSize =
    overwriteSchedule && Number.isFinite(live.nextEpisode)
      ? live.episodeBatchSize
      : live.episodeBatchSize > 1
        ? live.episodeBatchSize
        : series.episodeBatchSize;
  const episodeCount = Number.isFinite(live.episodeCount) ? live.episodeCount : series.episodeCount;
  const hasMainEpisode = Number.isFinite(nextEpisode);
  const hasLanguageEpisode = languageTracks.some((track) => track.enabled && Number.isFinite(track.nextEpisode));
  const completedAfterSync = (live.mainFinished || series.status === "finished") && !hasMainEpisode && !hasLanguageEpisode;
  const reactivated = series.status === "finished" && !series.enabled && (hasMainEpisode || hasLanguageEpisode);
  const patch = {
    ...series,
    service: overwriteSchedule && live.service ? live.service : series.service || live.service,
    status: live.mainFinished ? "finished" : reactivated && hasMainEpisode ? "airing" : series.status,
    enabled: completedAfterSync ? false : reactivated ? true : series.enabled,
    nextEpisode,
    episodeBatchSize,
    episodeCount,
    releaseDay: liveMainSchedule.releaseDay || series.releaseDay,
    releaseTime: liveMainSchedule.releaseTime || series.releaseTime,
    nextDate: live.mainFinished && overwriteSchedule ? "" : liveMainSchedule.nextDate || series.nextDate,
    imageUrl: overwriteSchedule && live.imageUrl ? live.imageUrl : series.imageUrl || live.imageUrl,
    languageTracks,
    lastLiveChartCheckedAt: DateTime.now().toISO()
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
    .filter((series) => isLiveChartLink(series.scheduleLink) && (series.enabled || series.status === "finished"));

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

  for (const series of seriesList) {
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
        source: options.source || "livechart-sync"
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
      if (error.status === 429) {
        result.rateLimited = true;
        break;
      }
    }

    if (delayMs > 0) await sleep(delayMs);
  }

  if (!result.rateLimited) {
    for (const series of [...store.listSeries()]) {
      if (failedIds.has(series.id)) continue;
      if (!shouldDeleteFinishedSeries(series, settings)) continue;

      await store.deleteSeries(series.id, { source: "livechart-cleanup" });
      result.deleted += 1;
      result.deletions.push({
        id: series.id,
        title: series.title,
        episodeCount: series.episodeCount,
        episodeCountUpdatedAt: series.episodeCountUpdatedAt
      });
    }
  }

  const summary = `${result.checked} checked, ${result.updated} updated, ${result.deleted} deleted, ${result.failed} failed${
    result.rateLimited ? ", rate-limited" : ""
  }`;
  await store.markLiveChartSync({ summary });
  return { ...result, summary };
}

export function shouldRunDailyLiveChartSync(settings, base = DateTime.now()) {
  if (!settings.liveChartSyncEnabled) return false;

  const zone = settings.timeZone || "Europe/Berlin";
  const now = base.setZone(zone);
  const hour = Math.min(23, Math.max(0, Number(settings.liveChartSyncHour ?? 5)));
  if (now.hour < hour) return false;

  if (!settings.lastLiveChartSyncAt) return true;

  const last = DateTime.fromISO(settings.lastLiveChartSyncAt, { zone });
  if (!last.isValid) return true;
  return last.toISODate() !== now.toISODate();
}

export function startLiveChartDailySync(store) {
  let running = false;

  const runIfDue = async () => {
    if (running) return;
    if (!shouldRunDailyLiveChartSync(store.getSettings())) return;

    running = true;
    try {
      const result = await syncAllLiveChart(store);
      console.log(`LiveChart daily sync: ${result.summary}`);
    } catch (error) {
      console.error(`LiveChart daily sync failed: ${error.stack || error.message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runIfDue, 15 * 60 * 1000);
  runIfDue();
  return timer;
}
