import { DateTime } from "luxon";
import { normalizeEnabledLanguageCodes, normalizeLanguageCode, normalizePreferredScheduleLanguage } from "./languages.js";
import { cleanString } from "./utils.js";

const releaseStatuses = new Set([
  "no-subtitle-match", "no-upcoming-release", "finished", "episode-unknown",
  "date-unknown", "time-unknown", "scheduled"
]);

export function liveChartCheckSource(series, settings) {
  return JSON.stringify([
    series.scheduleLink || "",
    normalizePreferredScheduleLanguage(series.liveChartImportLanguage || settings.preferredScheduleLanguage),
    Boolean(series.liveChartLanguageStrict),
    settings.timeZone,
    series.liveChartImportLanguage ? [series.liveChartImportLanguage] : normalizeEnabledLanguageCodes(settings.enabledLanguageCodes)
  ]);
}

function releaseStatus(episode, schedule) {
  if (!Number.isFinite(episode)) return "episode-unknown";
  if (!schedule.nextDate) return "date-unknown";
  if (!schedule.releaseTime) return "time-unknown";
  return "scheduled";
}

export function describeLiveChartReleases(live, mainSchedule, dubSchedules, before, after) {
  const mainStatus = live.mainUnavailable ? "no-subtitle-match"
    : live.mainEpisodeUnknown || live.mainScheduleEpisodeUnspecified ? "episode-unknown"
    : live.mainFinished ? "finished"
    : live.mainScheduleKnown || Number.isFinite(live.nextEpisode)
      ? releaseStatus(live.nextEpisode, mainSchedule)
      : "no-upcoming-release";
  const dubCodes = new Set([...before, ...after].filter((track) => track.enabled).map((track) => track.code));
  const schedules = new Map(dubSchedules.map((track) => [track.code, track]));
  const finished = new Set(live.finishedLanguageCodes || []);
  const dubs = [...dubCodes].map((code) => {
    const schedule = schedules.get(code);
    const status = schedule ? releaseStatus(schedule.nextEpisode, schedule)
      : finished.has(code) ? "finished" : "no-upcoming-release";
    return { code, status, service: schedule?.scheduleService || "" };
  });
  return [{ code: "", status: mainStatus, service: live.mainScheduleService || "" }, ...dubs];
}

export function normalizeLiveChartCheck(value) {
  const attemptedAt = cleanString(value?.attemptedAt);
  if (!DateTime.fromISO(attemptedAt).isValid) return null;
  const successfulAt = cleanString(value.successfulAt);
  const releases = Array.isArray(value.releases) ? value.releases : [];
  return {
    source: cleanString(value.source),
    attemptedAt,
    successfulAt: DateTime.fromISO(successfulAt).isValid ? successfulAt : "",
    error: cleanString(value.error).slice(0, 350),
    releases: releases.filter((release) => releaseStatuses.has(release?.status)).slice(0, 25).map((release) => ({
      code: normalizeLanguageCode(release.code).slice(0, 35),
      status: release.status,
      service: cleanString(release.service).slice(0, 250)
    }))
  };
}
