import { DateTime } from 'luxon';
import { cleanString } from './utils.js';
import { isSupportedLanguage, normalizeLanguageCode } from './languages.js';

const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const iso = value => {
  const date = DateTime.fromISO(cleanString(value), { setZone: true });
  return date.isValid ? date.toUTC().toISO() : '';
};

export function normalizeReleaseCompletionNotices(input = []) {
  const notices = new Map();
  for (const value of Array.isArray(input) ? input : []) {
    if (!value || typeof value !== 'object') continue;
    const languageCode = normalizeLanguageCode(value.languageCode);
    const detectedAt = iso(value.detectedAt);
    if (!isSupportedLanguage(languageCode) || !detectedAt) continue;
    const episodeStart = positive(value.episodeStart);
    const episodeEnd = positive(value.episodeEnd);
    if ((episodeStart !== null || episodeEnd !== null) &&
        (episodeStart === null || episodeEnd === null || episodeEnd < episodeStart)) continue;
    const previousEpisode = Number.isSafeInteger(value.previousEpisode) && value.previousEpisode >= 0
      ? value.previousEpisode : null;
    const key = `${languageCode}:completed:${episodeStart ?? 'unknown'}-${episodeEnd ?? 'unknown'}`;
    if (notices.has(key)) continue;
    notices.set(key, { key, languageCode, episodeStart, episodeEnd, previousEpisode, detectedAt,
      notifiedAt: iso(value.notifiedAt),
      sentChannelIds: [...new Set((Array.isArray(value.sentChannelIds) ? value.sentChannelIds : [])
        .map(cleanString).filter(id => /^\d{10,30}$/.test(id)))] });
  }
  return [...notices.values()].slice(-100);
}

export function planReleaseCompletionNotices(before, after, finishedCodes, settings = {}, now = DateTime.now()) {
  const notices = normalizeReleaseCompletionNotices(after?.releaseCompletionNotices ?? before?.releaseCompletionNotices);
  if (!before?.enabled || !now.isValid) return notices;
  for (const code of new Set((finishedCodes || []).map(normalizeLanguageCode))) {
    if (!isSupportedLanguage(code) || (before.liveChartImportLanguage && before.liveChartImportLanguage !== code)) continue;
    const previous = before.languageTracks?.find(track => track.code === code);
    const current = after.languageTracks?.find(track => track.code === code);
    if (!previous?.enabled || !Number.isFinite(previous.nextEpisode) ||
        !current || Number.isFinite(current.nextEpisode)) continue;
    const match = cleanString(previous.lastPostedKey).match(/:language:[^:]+:(\d+)(?:-(\d+))?:/);
    let previousEpisode = match ? Number(match[2] || match[1]) :
      !previous.lastPostedKey && !previous.lastPostedAt ? 0 : null;
    const alreadyNotified = notices.filter(notice => notice.languageCode === code && notice.notifiedAt && notice.episodeEnd)
      .map(notice => notice.episodeEnd);
    if (alreadyNotified.length && previousEpisode !== null) previousEpisode = Math.max(previousEpisode, ...alreadyNotified);
    const total = positive(after.episodeCount);
    if (total !== null && previousEpisode !== null && previousEpisode >= total) continue;
    notices.push({ languageCode: code, previousEpisode,
      episodeStart: total !== null && previousEpisode !== null ? previousEpisode + 1 : null,
      episodeEnd: total !== null && previousEpisode !== null ? total : null,
      detectedAt: now.toISO() });
  }
  return normalizeReleaseCompletionNotices(notices);
}
