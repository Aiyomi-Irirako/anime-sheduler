import { DateTime } from "luxon";
import {
  advanceLanguageAfterPost,
  advanceAfterPost,
  getNextLanguageRelease,
  getNextRelease,
  getReleasePostDateTime,
  releasePostKey,
  shouldPostRelease
} from "./schedule.js";
import { buildAnnouncement, releaseMentionRoleIds } from "./discordBot.js";
import { enabledLanguageTracks } from "./languages.js";
import { isLiveChartLink, syncOneSeriesFromLiveChart } from "./livechartSync.js";
import { cleanString } from "./utils.js";

function releaseDedupeKey(series, release, settings) {
  const releaseAt = getReleasePostDateTime(release, settings);
  if (!releaseAt) return "";

  const source = cleanString(series.scheduleLink || series.title).toLowerCase().replace(/\/+$/, "");
  const kind = release.kind === "language" ? `language:${release.languageCode}` : "main";
  const episodeEnd = Number.isFinite(release.episodeEnd) && release.episodeEnd > release.episode ? `-${release.episodeEnd}` : "";
  const episode = Number.isFinite(release.episode) ? `${release.episode}${episodeEnd}` : "next";
  return `${source}:${kind}:${episode}:${releaseAt.toISO()}`;
}

function releaseGroupKey(release, settings) {
  const releaseAt = getReleasePostDateTime(release, settings);
  if (!releaseAt) return "";

  const timeKind = release.missingTime ? "missing-time" : "release-time";
  return `${timeKind}:${releaseAt.toISO()}`;
}

function buildAnnouncementRelease(group) {
  const releases = group.map(({ release }) => release);
  if (releases.length === 1) return releases[0];

  const primary = releases.find((release) => release.kind !== "language") || releases[0];
  return {
    ...primary,
    kind: "combined",
    releases
  };
}

function collectDueGroups(series, settings, now, postedReleaseKeys) {
  const releases = [
    { release: getNextRelease(series, settings, now), track: null },
    ...enabledLanguageTracks(series).map((track) => ({
      release: getNextLanguageRelease(series, track, settings, now),
      track
    }))
  ];

  const dueGroups = new Map();

  for (const { release, track } of releases) {
    if (!shouldPostRelease(release, settings, now)) continue;

    const postKey = releasePostKey(series, release, settings);
    if (!postKey) continue;
    if (release.kind === "language" && track?.lastPostedKey === postKey) continue;
    if (release.kind !== "language" && series.lastPostedKey === postKey) continue;
    const dedupeKey = releaseDedupeKey(series, release, settings);
    if (dedupeKey && postedReleaseKeys.has(dedupeKey)) continue;

    const releaseAt = getReleasePostDateTime(release, settings);
    const groupKey = releaseGroupKey(release, settings);
    if (!groupKey || !releaseAt) continue;

    if (!dueGroups.has(groupKey)) dueGroups.set(groupKey, []);
    dueGroups.get(groupKey).push({ release, track, postKey, dedupeKey, releaseAt });
  }

  return [...dueGroups.values()].sort((a, b) => a[0].releaseAt.toMillis() - b[0].releaseAt.toMillis());
}

async function refreshLiveChartSeriesBeforePost(store, series) {
  if (!isLiveChartLink(series.scheduleLink)) return { series, refreshed: false };

  const current = store.getSeries(series.id);
  if (!current) return { series: null, refreshed: false };

  try {
    const synced = await syncOneSeriesFromLiveChart(store, current, { overwriteSchedule: true });
    return {
      series: synced.updated || store.getSeries(current.id) || current,
      refreshed: true,
      changed: synced.changed
    };
  } catch (error) {
    console.warn(`Pre-post LiveChart sync failed for "${current.title}": ${error.stack || error.message}`);
    return { series: null, refreshed: true, failed: true };
  }
}

export async function checkDueAnnouncements(store, discord) {
  if (!discord.enabled || !discord.ready) return { posted: 0, skipped: 0, reason: "discord_not_ready" };

  const data = store.snapshot();
  const settings = data.settings;
  const now = DateTime.now().setZone(settings.timeZone || "Europe/Berlin");
  const postedReleaseKeys = new Set();
  let posted = 0;
  let skipped = 0;

  for (const initialSeries of data.series) {
    let series = initialSeries;
    let sortedGroups = collectDueGroups(series, settings, now, postedReleaseKeys);
    if (!sortedGroups.length) continue;

    const refreshed = await refreshLiveChartSeriesBeforePost(store, series);
    if (!refreshed.series) {
      skipped += sortedGroups.length;
      continue;
    }

    if (refreshed.refreshed) {
      series = refreshed.series;
      sortedGroups = collectDueGroups(series, settings, now, postedReleaseKeys);
      if (!sortedGroups.length) continue;
    }

    for (const group of sortedGroups) {
      const announcementRelease = buildAnnouncementRelease(group);
      const message = buildAnnouncement(series, announcementRelease, settings);
      await discord.post(message, undefined, { mentionRoleIds: releaseMentionRoleIds(announcementRelease, settings) });
      for (const item of group) {
        if (item.dedupeKey) postedReleaseKeys.add(item.dedupeKey);
      }

      const current = store.getSeries(series.id);
      if (!current) continue;

      let advanced = current;
      for (const item of group) {
        advanced =
          item.release.kind === "language"
            ? advanceLanguageAfterPost(advanced, item.release, item.postKey, now)
            : advanceAfterPost(
                {
                  ...advanced,
                  lastPostedKey: item.postKey,
                  lastPostedAt: now.toISO()
                },
                item.release
              );
      }

      await store.replaceSeries(current.id, advanced, { source: "scheduler-post" });
      const languageReleases = group.filter((item) => item.release.kind === "language");
      const mainRelease = group.find((item) => item.release.kind !== "language");
      await store.addPostLog({
        type: group.length > 1 ? "auto-combined" : group[0].release.kind === "language" ? "auto-language" : "auto",
        seriesId: current.id,
        title: current.title,
        languageCode: languageReleases.map((item) => item.release.languageCode).filter(Boolean).join(","),
        languageLabel: languageReleases.map((item) => item.release.languageLabel).filter(Boolean).join(", "),
        episode: (mainRelease || group[0]).release.episode,
        releaseAt: group[0].releaseAt.toISO(),
        message
      });
      posted += 1;
    }
  }

  return { posted, skipped };
}

export function startScheduler(store, discord) {
  const run = async () => {
    try {
      const result = await checkDueAnnouncements(store, discord);
      if (result.posted) console.log(`Scheduler posted ${result.posted} announcement(s).`);
      if (Number(result.skipped) > 0) {
        console.log(`Scheduler skipped ${result.skipped} announcement group(s) after failed LiveChart refresh.`);
      }
    } catch (error) {
      console.error(`Scheduler error: ${error.stack || error.message}`);
    }
  };

  const intervalSeconds = Math.max(30, store.getSettings().schedulerIntervalSeconds || 60);
  const timer = setInterval(run, intervalSeconds * 1000);
  run();
  return timer;
}
