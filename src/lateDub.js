import { DateTime } from "luxon";
import { MAX_EPISODE_BATCH_SIZE } from "./constants.js";
import { cleanString, normalizeTime } from "./utils.js";
import { isSupportedLanguage, normalizeEnabledLanguageCodes, normalizeLanguageCode } from "./languages.js";
import { RELEASE_POST_EXPIRY_HOURS } from "./schedule.js";

export const LATE_DUB_LOOKBACK_DAYS = 14;

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function iso(value) {
  const date = DateTime.fromISO(cleanString(value), { setZone: true });
  return date.isValid ? date.toUTC().toISO() : "";
}

export function normalizeLateDubNotices(input = []) {
  const notices = new Map();
  for (const value of Array.isArray(input) ? input : []) {
    if (!value || typeof value !== "object") continue;
    const languageCode = normalizeLanguageCode(value.languageCode);
    if (!isSupportedLanguage(languageCode) || notices.has(languageCode)) continue;
    const kind = value.kind === "release" ? "release" : value.kind === "schedule" ? "schedule" : "";
    const episode = kind === "release" ? positiveInteger(value.episode) : null;
    const episodeEnd = episode === null ? null : Math.min(Math.max(positiveInteger(value.episodeEnd) || episode, episode),
      episode + MAX_EPISODE_BATCH_SIZE - 1);
    const releaseAt = kind === "release" ? iso(value.releaseAt) : "";
    const nextEpisode = positiveInteger(value.nextEpisode);
    const nextReleaseAt = iso(value.nextReleaseAt);
    if (!kind || (kind === "release" ? !episode || !releaseAt : !nextEpisode || nextEpisode < 2 || !nextReleaseAt)) continue;
    const sourceKey = kind === "release" ? `${episode}-${episodeEnd}:${releaseAt}` : `${nextEpisode}:${nextReleaseAt}`;
    notices.set(languageCode, {
      key: `${languageCode}:${kind}:${sourceKey}`,
      languageCode,
      kind,
      episode,
      episodeEnd,
      releaseAt,
      nextEpisode,
      nextReleaseAt,
      detectedAt: iso(value.detectedAt),
      notifiedAt: iso(value.notifiedAt),
      ...(value.suppressed === true ? { suppressed: true } : {}),
      sentChannelIds: [...new Set((Array.isArray(value.sentChannelIds) ? value.sentChannelIds : [])
        .map(cleanString).filter((channelId) => /^\d{10,30}$/.test(channelId)))]
    });
  }
  return [...notices.values()];
}

function trackDate(track, zone) {
  const timestamp = Number(track?.releaseTimestamp);
  if (Number.isFinite(timestamp) && timestamp > 0 && timestamp !== Number.MAX_SAFE_INTEGER) {
    return DateTime.fromSeconds(timestamp, { zone });
  }
  const time = normalizeTime(track?.releaseTime);
  if (!time || !/^\d{4}-\d{2}-\d{2}$/.test(cleanString(track?.nextDate))) return null;
  const date = DateTime.fromISO(`${track.nextDate}T${time}`, { zone });
  return date.isValid ? date : null;
}

export function planLateDubNotices(series, live = {}, settings = {}, now = DateTime.now()) {
  const existing = normalizeLateDubNotices(series?.lateDubNotices);
  if (!series?.enabled || !now?.isValid) return existing;
  const zone = settings.timeZone || "Europe/Berlin";
  const enabledCodes = new Set(normalizeEnabledLanguageCodes(settings.enabledLanguageCodes));
  const savedTracks = Array.isArray(series.languageTracks) ? series.languageTracks : [];
  const incomingTracks = Array.isArray(live.languageTracks) ? live.languageTracks : [];
  const previousTracks = Array.isArray(live.previousLanguageTracks) ? live.previousLanguageTracks : [];
  const evidence = Array.isArray(live.lateDubReleases) ? [...live.lateDubReleases] : [];
  // Manual dates are explicit user input; stale saved LiveChart dates are not new source evidence.
  if (series.scheduleMode === "manual") {
    for (const track of savedTracks) {
      const date = trackDate(track, zone);
      if (track.nextEpisode === 1 && date) evidence.push({ languageCode: track.code, episode: 1,
        episodeEnd: track.episodeBatchSize, releaseAt: date.toISO() });
    }
  }
  const codes = new Set([...savedTracks.map((track) => track.code), ...incomingTracks.map((track) => track.code),
    ...evidence.map((entry) => entry.languageCode || entry.code)].map(normalizeLanguageCode));
  const queuedCodes = new Set(existing.map((notice) => notice.languageCode));
  const result = [...existing];
  for (const code of codes) {
    if (!isSupportedLanguage(code) || queuedCodes.has(code) ||
        (series.liveChartImportLanguage && normalizeLanguageCode(series.liveChartImportLanguage) !== code)) continue;
    const saved = savedTracks.find((track) => normalizeLanguageCode(track.code) === code);
    const incoming = incomingTracks.find((track) => normalizeLanguageCode(track.code) === code);
    const track = saved || incoming;
    if ((saved ? !saved.enabled : !enabledCodes.has(code)) || track?.available === false ||
        cleanString(track?.lastPostedKey) || cleanString(track?.lastPostedAt)) continue;
    const date = trackDate(track, zone);
    const nextEpisode = positiveInteger(track?.nextEpisode);
    const previous = previousTracks.find((entry) => normalizeLanguageCode(entry.code) === code);
    const previousDate = trackDate(previous, zone);
    // Changing the date of an already known episode is rescheduling, not a newly found dub.
    const rescheduled = nextEpisode !== null && positiveInteger(previous?.nextEpisode) === nextEpisode &&
      previousDate?.isValid && date?.isValid && date.toMillis() !== previousDate.toMillis();
    const past = evidence.filter((entry) => normalizeLanguageCode(entry.languageCode || entry.code) === code &&
      !entry.isReleased && !entry.requiresConfirmation && !entry.regionWarning && Number(entry.episode) === 1)
      .map((entry) => ({ entry, date: DateTime.fromISO(iso(entry.releaseAt)) }))
      .filter((entry) => entry.date.isValid && entry.date < now.minus({ hours: RELEASE_POST_EXPIRY_HOURS }) &&
        entry.date >= now.minus({ days: LATE_DUB_LOOKBACK_DAYS }))
      .sort((a, b) => b.date.toMillis() - a.date.toMillis())[0];
    if (past) {
      result.push({ languageCode: code, kind: "release", episode: 1,
        episodeEnd: past.entry.episodeEnd || 1, releaseAt: past.date.toISO(),
        nextEpisode, nextReleaseAt: date?.isValid && date > now ? date.toISO() : "",
        detectedAt: now.toISO() });
    } else if (nextEpisode > 1 && date?.isValid && date > now) {
      result.push({ languageCode: code, kind: "schedule", nextEpisode,
        nextReleaseAt: date.toISO(), detectedAt: now.toISO(),
        // Persist that this was already known so a later unchanged sync cannot introduce it.
        ...(rescheduled ? { suppressed: true } : {}) });
    }
  }
  return normalizeLateDubNotices(result);
}
