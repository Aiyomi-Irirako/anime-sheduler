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

export async function checkDueAnnouncements(store, discord) {
  if (!discord.enabled || !discord.ready) return { posted: 0, skipped: "discord_not_ready" };

  const data = store.snapshot();
  const settings = data.settings;
  const now = DateTime.now().setZone(settings.timeZone || "Europe/Berlin");
  const postedReleaseKeys = new Set();
  let posted = 0;

  for (const series of data.series) {
    const releases = [
      { release: getNextRelease(series, settings, now), track: null },
      ...enabledLanguageTracks(series).map((track) => ({
        release: getNextLanguageRelease(series, track, settings, now),
        track
      }))
    ];

    for (const { release, track } of releases) {
      if (!shouldPostRelease(release, settings, now)) continue;

      const postKey = releasePostKey(series, release, settings);
      if (!postKey) continue;
      if (release.kind === "language" && track?.lastPostedKey === postKey) continue;
      if (release.kind !== "language" && series.lastPostedKey === postKey) continue;
      const dedupeKey = releaseDedupeKey(series, release, settings);
      if (dedupeKey && postedReleaseKeys.has(dedupeKey)) continue;

      const releaseAt = getReleasePostDateTime(release, settings);
      const message = buildAnnouncement(series, release, settings);
      await discord.post(message, undefined, { mentionRoleIds: releaseMentionRoleIds(release, settings) });
      if (dedupeKey) postedReleaseKeys.add(dedupeKey);

      const current = store.getSeries(series.id);
      if (!current) continue;

      const advanced =
        release.kind === "language"
          ? advanceLanguageAfterPost(current, release, postKey, now)
          : advanceAfterPost(
              {
                ...current,
                lastPostedKey: postKey,
                lastPostedAt: now.toISO()
              },
              release
            );

      await store.replaceSeries(current.id, advanced);
      await store.addPostLog({
        type: release.kind === "language" ? "auto-language" : "auto",
        seriesId: current.id,
        title: current.title,
        languageCode: release.languageCode || "",
        languageLabel: release.languageLabel || "",
        episode: release.episode,
        releaseAt: releaseAt?.toISO() || "",
        message
      });
      posted += 1;
    }
  }

  return { posted };
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
