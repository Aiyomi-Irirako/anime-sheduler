import { WEEKDAYS } from "./constants.js";
import { cleanString, normalizeDate, normalizeEpisodeBatchSize, normalizeTime, parseBoolean, parseInteger } from "./utils.js";

export const LANGUAGE_OPTIONS = [
  { code: "de", label: "German", short: "DE" },
  { code: "en", label: "English", short: "EN" },
  { code: "fr", label: "French", short: "FR" },
  { code: "es", label: "Spanish", short: "ES" },
  { code: "es-419", label: "Spanish (Latin America)", short: "ES-LA" },
  { code: "it", label: "Italian", short: "IT" },
  { code: "pt-br", label: "Portuguese (Brazil)", short: "PT-BR" },
  { code: "pt-pt", label: "Portuguese (Portugal)", short: "PT-PT" },
  { code: "tr", label: "Turkish", short: "TR" },
  { code: "ar", label: "Arabic", short: "AR" },
  { code: "ru", label: "Russian", short: "RU" },
  { code: "hi", label: "Hindi", short: "HI" },
  { code: "id", label: "Indonesian", short: "ID" },
  { code: "th", label: "Thai", short: "TH" },
  { code: "ko", label: "Korean", short: "KO" },
  { code: "zh-hans", label: "Chinese (Simplified)", short: "ZH-Hans" },
  { code: "zh-hant", label: "Chinese (Traditional)", short: "ZH-Hant" }
];

const LANGUAGE_BY_CODE = new Map(LANGUAGE_OPTIONS.map((language) => [language.code, language]));
const WEEKDAY_BY_KEY = new Map(WEEKDAYS.map((day) => [day.key, day]));
const WEEKDAY_BY_LABEL = new Map(WEEKDAYS.map((day) => [day.label.toLowerCase(), day]));

export function normalizeLanguageCode(value) {
  const code = cleanString(value).toLowerCase().replaceAll("_", "-");
  if (!code) return "";
  if (code === "pt") return "pt-br";
  if (code === "zh-cn") return "zh-hans";
  if (code === "zh-tw") return "zh-hant";
  return code;
}

function normalizeTrackReleaseDay(value) {
  const text = cleanString(value).toLowerCase();
  if (!text) return "";
  return WEEKDAY_BY_KEY.get(text)?.key || WEEKDAY_BY_LABEL.get(text)?.key || "";
}

export function languageLabel(code) {
  const normalized = normalizeLanguageCode(code);
  return LANGUAGE_BY_CODE.get(normalized)?.label || normalized.toUpperCase();
}

export function languageShortLabel(code) {
  const normalized = normalizeLanguageCode(code);
  return LANGUAGE_BY_CODE.get(normalized)?.short || normalized.toUpperCase();
}

export function isSupportedLanguage(code) {
  return LANGUAGE_BY_CODE.has(normalizeLanguageCode(code));
}

export function normalizeEnabledLanguageCodes(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set();
  const codes = [];

  for (const item of raw) {
    const code = normalizeLanguageCode(item);
    if (!isSupportedLanguage(code) || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }

  return codes;
}

export function normalizeLanguageTrack(input = {}, existing = {}) {
  const code = normalizeLanguageCode(input.code || existing.code);
  if (!code) return null;

  const nextEpisode =
    input.nextEpisode === undefined && existing.nextEpisode !== undefined
      ? parseInteger(existing.nextEpisode)
      : parseInteger(input.nextEpisode);
  const episodeBatchSize =
    input.episodeBatchSize === undefined && existing.episodeBatchSize !== undefined
      ? normalizeEpisodeBatchSize(existing.episodeBatchSize)
      : normalizeEpisodeBatchSize(input.episodeBatchSize);

  return {
    code,
    label: languageLabel(code),
    enabled: input.enabled === undefined ? parseBoolean(existing.enabled) : parseBoolean(input.enabled),
    available:
      input.available === undefined
        ? existing.available === undefined
          ? true
          : parseBoolean(existing.available)
        : parseBoolean(input.available),
    nextEpisode,
    episodeBatchSize,
    releaseDay:
      input.releaseDay === undefined && existing.releaseDay !== undefined
        ? normalizeTrackReleaseDay(existing.releaseDay)
        : normalizeTrackReleaseDay(input.releaseDay),
    releaseTime:
      input.releaseTime === undefined && existing.releaseTime !== undefined
        ? normalizeTime(existing.releaseTime)
        : normalizeTime(input.releaseTime),
    nextDate:
      input.nextDate === undefined && existing.nextDate !== undefined
        ? normalizeDate(existing.nextDate)
        : normalizeDate(input.nextDate),
    weekly: input.weekly === undefined ? existing.weekly !== false : parseBoolean(input.weekly),
    lastPostedKey: cleanString(input.lastPostedKey || existing.lastPostedKey),
    lastPostedAt: cleanString(input.lastPostedAt || existing.lastPostedAt),
    source: cleanString(input.source || existing.source),
    updatedAt: cleanString(input.updatedAt || existing.updatedAt)
  };
}

export function normalizeLanguageTracks(inputTracks = [], existingTracks = []) {
  const existingByCode = new Map(
    (Array.isArray(existingTracks) ? existingTracks : [])
      .map((track) => normalizeLanguageTrack(track))
      .filter(Boolean)
      .map((track) => [track.code, track])
  );

  const nextByCode = new Map(existingByCode);
  for (const input of Array.isArray(inputTracks) ? inputTracks : []) {
    const code = normalizeLanguageCode(input.code);
    if (!code) continue;
    const normalized = normalizeLanguageTrack(input, existingByCode.get(code) || {});
    if (normalized) nextByCode.set(code, normalized);
  }

  return [...nextByCode.values()].sort((a, b) => {
    const aIndex = LANGUAGE_OPTIONS.findIndex((language) => language.code === a.code);
    const bIndex = LANGUAGE_OPTIONS.findIndex((language) => language.code === b.code);
    if (aIndex === -1 && bIndex === -1) return a.label.localeCompare(b.label);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });
}

export function mergeLanguageTracks(existingTracks, incomingTracks, enabledLanguageCodes = []) {
  const enabledSet = new Set(normalizeEnabledLanguageCodes(enabledLanguageCodes));
  const existingByCode = new Map(
    normalizeLanguageTracks(existingTracks).map((track) => [track.code, track])
  );
  const incomingByCode = new Map(
    normalizeLanguageTracks(incomingTracks).map((track) => [track.code, track])
  );
  const codes = new Set([...existingByCode.keys(), ...incomingByCode.keys()]);

  return [...codes].map((code) => {
    const existing = existingByCode.get(code);
    const incoming = incomingByCode.get(code);
    return normalizeLanguageTrack(
      {
        code,
        enabled: existing?.enabled || enabledSet.has(code),
        available: incoming?.available ?? existing?.available ?? true,
        nextEpisode: incoming?.nextEpisode ?? existing?.nextEpisode,
        episodeBatchSize: incoming ? incoming.episodeBatchSize : existing?.episodeBatchSize,
        releaseDay: incoming?.releaseDay || existing?.releaseDay,
        releaseTime: incoming?.releaseTime || existing?.releaseTime,
        nextDate: incoming?.nextDate || existing?.nextDate,
        weekly: existing?.weekly ?? incoming?.weekly ?? true,
        lastPostedKey: existing?.lastPostedKey,
        lastPostedAt: existing?.lastPostedAt,
        source: incoming?.source || existing?.source,
        updatedAt: incoming?.updatedAt || existing?.updatedAt
      },
      existing || {}
    );
  }).filter(Boolean);
}

export function enabledLanguageTracks(series) {
  return normalizeLanguageTracks(series?.languageTracks || []).filter(
    (track) => track.enabled && Number.isFinite(track.nextEpisode)
  );
}
