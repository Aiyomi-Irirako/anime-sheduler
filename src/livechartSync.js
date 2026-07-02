import { DateTime } from "luxon";
import { fetchLiveChartEpisodes } from "./livechart.js";
import { mergeLanguageTracks, normalizeLanguageTracks } from "./languages.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLiveChartLink(value) {
  return typeof value === "string" && value.includes("livechart.me/anime/");
}

export function prepareLiveLanguageTracks(liveTracks = [], settings = {}) {
  const zone = settings.timeZone || "Europe/Berlin";
  return (Array.isArray(liveTracks) ? liveTracks : []).map((track) => {
    const timestamp = Number(track.releaseTimestamp);
    if (!Number.isFinite(timestamp) || timestamp === Number.MAX_SAFE_INTEGER) return track;

    const releaseAt = DateTime.fromMillis(timestamp * 1000, { zone: "utc" }).setZone(zone);
    if (!releaseAt.isValid) return track;

    return {
      ...track,
      nextDate: track.nextDate || releaseAt.toISODate(),
      releaseTime: track.releaseTime || releaseAt.toFormat("HH:mm")
    };
  });
}

function hasChanged(series, live) {
  if (Number.isFinite(live.nextEpisode) && live.nextEpisode !== series.nextEpisode) return true;
  if (Number.isFinite(live.dubNextEpisode) && live.dubNextEpisode !== series.dubNextEpisode) return true;
  if (Number.isFinite(live.dubNextEpisode) && !series.dubbed) return true;
  if (live.imageUrl && !series.imageUrl) return true;
  const before = new Map(normalizeLanguageTracks(series.languageTracks || []).map((track) => [track.code, track]));
  const after = normalizeLanguageTracks(live.languageTracks || []);
  for (const track of after) {
    const current = before.get(track.code);
    if (!current) return true;
    if (
      current.nextEpisode !== track.nextEpisode ||
      current.available !== track.available ||
      current.enabled !== track.enabled ||
      current.releaseDay !== track.releaseDay ||
      current.releaseTime !== track.releaseTime ||
      current.nextDate !== track.nextDate
    ) {
      return true;
    }
  }
  return false;
}

export async function syncOneSeriesFromLiveChart(store, series) {
  const live = await fetchLiveChartEpisodes(series.scheduleLink);
  const settings = store.getSettings();
  const liveLanguageTracks = prepareLiveLanguageTracks(live.languageTracks || [], settings);
  const languageTracks = mergeLanguageTracks(
    series.languageTracks || [],
    liveLanguageTracks,
    settings.enabledLanguageCodes || []
  );
  const patch = {
    ...series,
    nextEpisode: Number.isFinite(live.nextEpisode) ? live.nextEpisode : series.nextEpisode,
    imageUrl: series.imageUrl || live.imageUrl,
    languageTracks
  };

  if (!hasChanged(series, { ...live, languageTracks })) {
    return { changed: false, live };
  }

  const updated = await store.upsertSeries(patch);
  return { changed: true, live, updated };
}

export async function syncAllLiveChart(store, options = {}) {
  const delayMs = options.delayMs ?? 6500;
  const seriesList = store
    .listSeries()
    .filter((series) => series.enabled && isLiveChartLink(series.scheduleLink));

  const result = {
    checked: 0,
    updated: 0,
    failed: 0,
    rateLimited: false,
    changes: [],
    errors: []
  };

  for (const series of seriesList) {
    result.checked += 1;
    try {
      const current = store.getSeries(series.id);
      if (!current) continue;

      const before = {
        nextEpisode: current.nextEpisode,
        dubNextEpisode: current.dubNextEpisode,
        dubbed: current.dubbed,
        languageTracks: current.languageTracks || []
      };
      const synced = await syncOneSeriesFromLiveChart(store, current);

      if (synced.changed) {
        result.updated += 1;
        result.changes.push({
          id: current.id,
          title: current.title,
          before,
          after: {
            nextEpisode: synced.updated.nextEpisode,
            dubNextEpisode: synced.updated.dubNextEpisode,
            dubbed: synced.updated.dubbed,
            imageUrl: synced.updated.imageUrl,
            languageTracks: synced.updated.languageTracks || []
          }
        });
      }
    } catch (error) {
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

  const summary = `${result.checked} checked, ${result.updated} updated, ${result.failed} failed${
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
