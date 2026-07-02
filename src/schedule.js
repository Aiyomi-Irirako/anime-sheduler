import { DateTime } from "luxon";
import { WEEKDAYS } from "./constants.js";
import { cleanString, normalizeDate, normalizeTime, padEpisode } from "./utils.js";
import { enabledLanguageTracks, languageLabel } from "./languages.js";
import { pickPreferredService } from "./services.js";

const WEEKDAY_BY_KEY = new Map(WEEKDAYS.map((day) => [day.key, day]));
const WEEKDAY_BY_LABEL = new Map(WEEKDAYS.map((day) => [day.label.toLowerCase(), day]));
const DEFAULT_MISSING_TIME_POST_TIME = "18:00";
const FINISHED_SERIES_RETENTION_MONTHS = 1;

export function normalizeReleaseDay(value) {
  const text = cleanString(value).toLowerCase();
  if (!text) return "";
  const match = WEEKDAY_BY_LABEL.get(text) || WEEKDAY_BY_KEY.get(text);
  return match?.key || "";
}

export function parseReleasePattern(value) {
  const text = cleanString(value);
  if (!text) return {};

  if (/^finished$/i.test(text)) return { status: "finished", enabled: false };
  if (/^released$/i.test(text)) return { status: "released" };

  const match = text.match(
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\s*@\s*(\d{1,2}:\d{2}))?$/i
  );

  if (!match) return { status: "unknown", rawRelease: text };

  return {
    status: "airing",
    releaseDay: normalizeReleaseDay(match[1]),
    releaseTime: normalizeTime(match[2] || "")
  };
}

export function getReleaseDayLabel(key, locale = "en") {
  const day = WEEKDAY_BY_KEY.get(normalizeReleaseDay(key));
  if (!day) return "";
  return locale === "de" ? day.de : day.label;
}

export function hasPendingMainRelease(series) {
  return Number.isFinite(series?.nextEpisode);
}

export function hasPendingLanguageRelease(series) {
  return (series?.languageTracks || []).some((track) => track.enabled && Number.isFinite(track.nextEpisode));
}

export function isSeriesComplete(series) {
  return cleanString(series?.status).toLowerCase() === "finished" && !hasPendingMainRelease(series) && !hasPendingLanguageRelease(series);
}

export function getFinishedDeletionDate(series, settings = {}) {
  if (!isSeriesComplete(series)) return null;

  const zone = settings.timeZone || "Europe/Berlin";
  const referenceAt = Number.isFinite(series?.episodeCount)
    ? cleanString(series.episodeCountUpdatedAt)
    : cleanString(series.finishedAt || series.lastLiveChartCheckedAt || series.updatedAt || series.createdAt);
  if (!referenceAt) return null;

  const since = DateTime.fromISO(referenceAt, { zone });
  if (!since.isValid) return null;
  return since.setZone(zone).plus({ months: FINISHED_SERIES_RETENTION_MONTHS });
}

export function shouldDeleteFinishedSeries(series, settings = {}, base = DateTime.now()) {
  const deletionDate = getFinishedDeletionDate(series, settings);
  if (!deletionDate) return false;

  const zone = settings.timeZone || "Europe/Berlin";
  return base.setZone(zone) >= deletionDate;
}

export function parseTimeParts(value) {
  const time = normalizeTime(value);
  if (!time) return null;
  const [hour, minute] = time.split(":").map((part) => Number.parseInt(part, 10));
  return { hour, minute };
}

function combineDateTime(dateText, timeText, zone) {
  const date = DateTime.fromISO(dateText, { zone });
  const time = parseTimeParts(timeText);
  if (!date.isValid) return null;
  if (!time) return { date, missingTime: true };
  return { dateTime: date.set(time), missingTime: false };
}

function nextWeekdayDate(dayKey, base) {
  const day = WEEKDAY_BY_KEY.get(normalizeReleaseDay(dayKey));
  if (!day) return null;
  const daysUntil = (day.luxon - base.weekday + 7) % 7;
  return base.startOf("day").plus({ days: daysUntil });
}

function weeklyBaseDate(series, now, zone) {
  const premiereDate = normalizeDate(series?.premiereDate);
  if (!premiereDate) return now;

  const premiere = DateTime.fromISO(premiereDate, { zone });
  if (!premiere.isValid) return now;
  return premiere.startOf("day") > now.startOf("day") ? premiere : now;
}

export function getNextRelease(series, settings, base = DateTime.now()) {
  const zone = settings.timeZone || "Europe/Berlin";
  const now = base.setZone(zone);
  if (!series?.enabled || series.status === "finished") return null;

  const episode = Number.isFinite(series.nextEpisode) ? series.nextEpisode : null;
  const releaseTime = normalizeTime(series.releaseTime);
  const nextDate = normalizeDate(series.nextDate);

  if (nextDate) {
    const combined = combineDateTime(nextDate, releaseTime, zone);
    if (!combined) return null;
    return {
      kind: "main",
      type: "date",
      episode,
      date: combined.date,
      dateTime: combined.dateTime,
      missingTime: combined.missingTime
    };
  }

  const releaseDay = normalizeReleaseDay(series.releaseDay);
  if (!releaseDay) return null;

  let date = nextWeekdayDate(releaseDay, weeklyBaseDate(series, now, zone));
  if (!date) return null;

  const time = parseTimeParts(releaseTime);
  if (!time) {
    return { kind: "main", type: "weekly", episode, date, dateTime: null, missingTime: true };
  }

  let dateTime = date.set(time);
  if (dateTime < now.minus({ minutes: 1 })) {
    date = date.plus({ days: 7 });
    dateTime = date.set(time);
  }

  return { kind: "main", type: "weekly", episode, date, dateTime, missingTime: false };
}

export function getNextLanguageRelease(series, track, settings, base = DateTime.now()) {
  const zone = settings.timeZone || "Europe/Berlin";
  const now = base.setZone(zone);
  if (!series?.enabled || !track?.enabled || !Number.isFinite(track.nextEpisode)) return null;

  const nextDate = normalizeDate(track.nextDate);
  const releaseTime = normalizeTime(track.releaseTime);

  if (nextDate) {
    const combined = combineDateTime(nextDate, releaseTime, zone);
    if (!combined) return null;
    return {
      kind: "language",
      type: "language-date",
      languageCode: track.code,
      languageLabel: track.label || languageLabel(track.code),
      episode: track.nextEpisode,
      date: combined.date,
      dateTime: combined.dateTime,
      missingTime: combined.missingTime
    };
  }

  const releaseDay = normalizeReleaseDay(track.releaseDay);
  if (!releaseDay) return null;

  let date = nextWeekdayDate(releaseDay, weeklyBaseDate(series, now, zone));
  if (!date) return null;

  const time = parseTimeParts(releaseTime);
  if (!time) {
    return {
      kind: "language",
      type: "language-weekly",
      languageCode: track.code,
      languageLabel: track.label || languageLabel(track.code),
      episode: track.nextEpisode,
      date,
      dateTime: null,
      missingTime: true
    };
  }

  let dateTime = date.set(time);
  if (dateTime < now.minus({ minutes: 1 })) {
    date = date.plus({ days: 7 });
    dateTime = date.set(time);
  }

  return {
    kind: "language",
    type: "language-weekly",
    languageCode: track.code,
    languageLabel: track.label || languageLabel(track.code),
    episode: track.nextEpisode,
    date,
    dateTime,
    missingTime: false
  };
}

export function listUpcoming(seriesList, settings, days = 14, base = DateTime.now()) {
  const zone = settings.timeZone || "Europe/Berlin";
  const now = base.setZone(zone);
  const end = now.plus({ days });

  return seriesList
    .flatMap((series) => [
      { series, release: getNextRelease(series, settings, now) },
      ...enabledLanguageTracks(series).map((track) => ({ series, track, release: getNextLanguageRelease(series, track, settings, now) }))
    ])
    .filter(({ release }) => {
      if (!release) return false;
      if (release.dateTime) return release.dateTime <= end;
      return release.date <= end.endOf("day");
    })
    .sort((a, b) => {
      const aTime = a.release.dateTime || a.release.date;
      const bTime = b.release.dateTime || b.release.date;
      return aTime.toMillis() - bTime.toMillis();
    });
}

function releaseSortTime(release) {
  return release.dateTime || release.date;
}

function allCalculatedReleases(seriesList, settings, base = DateTime.now()) {
  return seriesList
    .flatMap((series) => [
      { series, release: getNextRelease(series, settings, base) },
      ...enabledLanguageTracks(series).map((track) => ({ series, track, release: getNextLanguageRelease(series, track, settings, base) }))
    ])
    .filter(({ release }) => release);
}

export function listUpcomingTodayTomorrow(seriesList, settings, base = DateTime.now()) {
  const zone = settings.timeZone || "Europe/Berlin";
  const now = base.setZone(zone);
  const today = now.toISODate();
  const tomorrow = now.plus({ days: 1 }).toISODate();

  return allCalculatedReleases(seriesList, settings, now)
    .filter(({ release }) => {
      const date = releaseSortTime(release)?.setZone(zone).toISODate();
      return date === today || date === tomorrow;
    })
    .sort((a, b) => releaseSortTime(a.release).toMillis() - releaseSortTime(b.release).toMillis());
}

export function listReleasesForWeekday(seriesList, settings, weekdayKey, base = DateTime.now()) {
  const zone = settings.timeZone || "Europe/Berlin";
  const now = base.setZone(zone);
  const day = WEEKDAY_BY_KEY.get(normalizeReleaseDay(weekdayKey));
  if (!day) return [];

  const daysUntil = (day.luxon - now.weekday + 7) % 7;
  const targetDate = now.startOf("day").plus({ days: daysUntil }).toISODate();

  return allCalculatedReleases(seriesList, settings, now)
    .filter(({ release }) => {
      const releaseAt = releaseSortTime(release)?.setZone(zone);
      return releaseAt?.isValid && releaseAt.toISODate() === targetDate;
    })
    .sort((a, b) => releaseSortTime(a.release).toMillis() - releaseSortTime(b.release).toMillis());
}

export function formatReleaseDate(release, settings, includeWeekday = true) {
  if (!release) return "No release date";
  const localeDate = release.dateTime || release.date;
  if (!localeDate) return "No release date";
  const withLocale = localeDate.setZone(settings.timeZone || "Europe/Berlin").setLocale("en");

  if (release.missingTime) {
    return includeWeekday
      ? `${withLocale.toFormat("cccc, dd LLL yyyy")} - time missing`
      : `${withLocale.toFormat("dd LLL yyyy")} - time missing`;
  }

  return includeWeekday
    ? withLocale.toFormat("cccc, dd LLL yyyy HH:mm")
    : withLocale.toFormat("dd LLL yyyy HH:mm");
}

export function formatEpisodeEntries(series, release) {
  const entries = [];
  if (release?.kind === "language") {
    return Number.isFinite(release.episode)
      ? [{ text: `Episode ${padEpisode(release.episode)} (${release.languageLabel || languageLabel(release.languageCode)})`, kind: "language", code: release.languageCode }]
      : [{ text: `Next episode (${release.languageLabel || languageLabel(release.languageCode)})`, kind: "language", code: release.languageCode }];
  }

  if (Number.isFinite(release?.episode)) {
    entries.push({ text: `Episode ${padEpisode(release.episode)}`, kind: "main" });
  }

  return entries.length ? entries : [{ text: "Next episode", kind: "empty" }];
}

export function formatEpisodeLabel(series, release, separator = " / ") {
  return formatEpisodeEntries(series, release)
    .map((entry) => entry.text)
    .join(separator);
}

export function formatEpisodeLine(series, release, settings) {
  const episode = formatEpisodeLabel(series, release);
  const postService = pickPreferredService(series.service, series.preferredService);
  const service = postService ? ` (${postService})` : "";
  return `${formatReleaseDate(release, settings)} - ${series.title} - ${episode}${service}`;
}

export function getMissingTimePostTime(settings = {}) {
  return normalizeTime(settings.missingTimePostTime || process.env.MISSING_TIME_POST_TIME) || DEFAULT_MISSING_TIME_POST_TIME;
}

export function getReleasePostDateTime(release, settings = {}) {
  if (!release) return null;
  const zone = settings.timeZone || "Europe/Berlin";
  if (release.dateTime && !release.missingTime) return release.dateTime.setZone(zone);
  if (!release.missingTime || !release.date) return null;

  const time = parseTimeParts(getMissingTimePostTime(settings));
  if (!time) return null;
  return release.date.setZone(zone).set(time);
}

export function shouldPostRelease(release, settings, base = DateTime.now()) {
  const postDateTime = getReleasePostDateTime(release, settings);
  if (!postDateTime) return false;

  const zone = settings.timeZone || "Europe/Berlin";
  const now = base.setZone(zone);
  const reminderMinutes = Number(settings.reminderMinutes || 0);
  const startsAt = release.missingTime ? postDateTime : postDateTime.minus({ minutes: reminderMinutes });
  const expiresAt = postDateTime.plus({ hours: 6 });
  return now >= startsAt && now <= expiresAt;
}

export function releasePostKey(series, release, settings = {}) {
  const postDateTime = getReleasePostDateTime(release, settings);
  if (!postDateTime) return "";
  const timeKind = release.missingTime ? "missing-time" : "release-time";
  const releaseKind = release.kind === "language" ? `language:${release.languageCode}` : "main";
  const episodePart = release.missingTime ? "day" : release.episode || "next";
  return `${series.id}:${releaseKind}:${episodePart}:${timeKind}:${postDateTime.toISO()}`;
}

export function advanceAfterPost(series, release) {
  const next = { ...series };
  const hadNextDate = Boolean(next.nextDate);
  const currentEpisode = Number.isFinite(next.nextEpisode) ? next.nextEpisode : null;
  const episodeCount = Number.isFinite(next.episodeCount) ? next.episodeCount : null;

  if (currentEpisode !== null) {
    if (episodeCount !== null && currentEpisode >= episodeCount) {
      next.nextEpisode = null;
    } else {
      next.nextEpisode = currentEpisode + 1;
    }
  }

  const germanTrack = next.languageTracks.find((track) => track.code === "de");
  next.dubbed = Boolean(germanTrack?.enabled);
  next.dubNextEpisode = germanTrack?.nextEpisode ?? null;

  const hasMainEpisode = Number.isFinite(next.nextEpisode);
  const hasLanguageEpisode = next.languageTracks.some((track) => track.enabled && Number.isFinite(track.nextEpisode));
  if (!hasMainEpisode && !hasLanguageEpisode && episodeCount !== null) {
    next.status = "finished";
    next.enabled = false;
  } else if (!hasMainEpisode && episodeCount !== null) {
    next.status = "finished";
  }

  if (hadNextDate && next.nextDate && next.weekly !== false) {
    const zone = "UTC";
    const date = DateTime.fromISO(next.nextDate, { zone });
    if (date.isValid) next.nextDate = date.plus({ days: 7 }).toISODate();
  } else if (release?.missingTime && release?.type === "weekly" && next.weekly !== false && release.date?.isValid) {
    next.nextDate = release.date.plus({ days: 7 }).toISODate();
  }

  next.updatedAt = DateTime.now().toISO();
  return next;
}

export function advanceLanguageAfterPost(series, release, postKey, postedAt = DateTime.now()) {
  const next = { ...series };
  const episodeCount = Number.isFinite(next.episodeCount) ? next.episodeCount : null;

  next.languageTracks = (next.languageTracks || []).map((track) => {
    if (track.code !== release.languageCode) return track;

    const trackEpisode = Number.isFinite(track.nextEpisode) ? track.nextEpisode : null;
    const updated = {
      ...track,
      lastPostedKey: postKey,
      lastPostedAt: postedAt.toISO()
    };

    if (trackEpisode === null) return updated;
    if (episodeCount !== null && trackEpisode >= episodeCount) {
      return { ...updated, enabled: false, nextEpisode: null };
    }

    const nextTrack = { ...updated, nextEpisode: trackEpisode + 1 };
    const hadNextDate = Boolean(nextTrack.nextDate);
    if (hadNextDate && nextTrack.nextDate && nextTrack.weekly !== false) {
      const date = DateTime.fromISO(nextTrack.nextDate, { zone: "UTC" });
      if (date.isValid) nextTrack.nextDate = date.plus({ days: 7 }).toISODate();
    } else if (release?.missingTime && release?.type === "language-weekly" && nextTrack.weekly !== false && release.date?.isValid) {
      nextTrack.nextDate = release.date.plus({ days: 7 }).toISODate();
    }
    return nextTrack;
  });

  const germanTrack = next.languageTracks.find((track) => track.code === "de");
  next.dubbed = Boolean(germanTrack?.enabled);
  next.dubNextEpisode = germanTrack?.nextEpisode ?? null;

  const hasMainEpisode = Number.isFinite(next.nextEpisode);
  const hasLanguageEpisode = next.languageTracks.some((track) => track.enabled && Number.isFinite(track.nextEpisode));
  if (!hasMainEpisode && !hasLanguageEpisode && episodeCount !== null) {
    next.status = "finished";
    next.enabled = false;
  }

  next.updatedAt = DateTime.now().toISO();
  return next;
}
