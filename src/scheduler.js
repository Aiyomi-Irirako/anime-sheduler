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
import { isLiveChartLink, syncOneSeriesFromLiveChart } from "./livechartSync.js";
import { enabledLanguageTracks } from "./languages.js";
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

function releaseEntriesForSeries(series, settings, now) {
  return [
    { release: getNextRelease(series, settings, now), track: null },
    ...enabledLanguageTracks(series).map((track) => ({
      release: getNextLanguageRelease(series, track, settings, now),
      track
    }))
  ];
}

function isAlreadyPosted(series, release, track, postKey) {
  if (release.kind === "language") return track?.lastPostedKey === postKey;
  return series.lastPostedKey === postKey;
}

function collectDueGroupsForSeries(series, settings, now, postedReleaseKeys) {
  const dueGroups = new Map();

  for (const { release, track } of releaseEntriesForSeries(series, settings, now)) {
    if (!shouldPostRelease(release, settings, now)) continue;

    const postKey = releasePostKey(series, release, settings);
    if (!postKey) continue;
    if (isAlreadyPosted(series, release, track, postKey)) continue;
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

async function syncSeriesBeforePosting(store, series, settings, options = {}) {
  const shouldSync = options.syncBeforePost ?? settings.liveChartSyncEnabled;
  if (!shouldSync || !isLiveChartLink(series.scheduleLink)) return { synced: false, series };

  const runSyncOneSeriesFromLiveChart = options.syncOneSeriesFromLiveChart || syncOneSeriesFromLiveChart;
  const result = await runSyncOneSeriesFromLiveChart(store, series);
  const freshSeries = store.getSeries(series.id);
  if (!freshSeries) return { synced: true, result, series: null };

  return { synced: true, result, series: freshSeries };
}

export async function checkDueAnnouncements(store, discord, options = {}) {
  if (!discord.enabled || !discord.ready) return { posted: 0, skipped: "discord_not_ready" };

  const data = store.snapshot();
  const settings = data.settings;
  const zone = settings.timeZone || "Europe/Berlin";
  const now = DateTime.now().setZone(zone);

  const postedReleaseKeys = new Set();
  let posted = 0;
  let skipped = 0;

  for (const initialSeries of data.series) {
    let series = initialSeries;
    let seriesSettings = settings;
    let seriesNow = now;
    let sortedGroups = collectDueGroupsForSeries(series, seriesSettings, seriesNow, postedReleaseKeys);
    if (!sortedGroups.length) continue;

    try {
      const sync = await syncSeriesBeforePosting(store, series, seriesSettings, options);
      if (sync.synced) {
        console.log(`LiveChart pre-post check: ${series.title}`);
        if (!sync.series) continue;
        series = sync.series;
        seriesSettings = store.getSettings();
        seriesNow = DateTime.now().setZone(seriesSettings.timeZone || zone);
        sortedGroups = collectDueGroupsForSeries(series, seriesSettings, seriesNow, postedReleaseKeys);
        if (!sortedGroups.length) continue;
      }
    } catch (error) {
      skipped += 1;
      console.error(`LiveChart pre-post check failed for ${series.title}; skipping announcement: ${error.stack || error.message}`);
      continue;
    }

    for (const group of sortedGroups) {
      const announcementRelease = buildAnnouncementRelease(group);
      const message = buildAnnouncement(series, announcementRelease, seriesSettings);
      await discord.post(message, undefined, { mentionRoleIds: releaseMentionRoleIds(announcementRelease, seriesSettings) });
      for (const item of group) {
        if (item.dedupeKey) postedReleaseKeys.add(item.dedupeKey);
      }

      const current = store.getSeries(series.id);
      if (!current) continue;

      let advanced = current;
      for (const item of group) {
        advanced =
          item.release.kind === "language"
            ? advanceLanguageAfterPost(advanced, item.release, item.postKey, seriesNow)
            : advanceAfterPost(
                {
                  ...advanced,
                  lastPostedKey: item.postKey,
                  lastPostedAt: seriesNow.toISO()
                },
                item.release
              );
      }

      await store.replaceSeries(current.id, advanced);
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

  return skipped ? { posted, syncFailures: skipped } : { posted };
}

export function startScheduler(store, discord) {
  const run = async () => {
    try {
      const result = await checkDueAnnouncements(store, discord);
      if (result.posted) console.log(`Scheduler posted ${result.posted} announcement(s).`);
    } catch (error) {
      console.error(`Scheduler error: ${error.stack || error.message}`);
    }
  };

  const intervalSeconds = Math.max(30, store.getSettings().schedulerIntervalSeconds || 60);
  const timer = setInterval(run, intervalSeconds * 1000);
  run();
  return timer;
}
