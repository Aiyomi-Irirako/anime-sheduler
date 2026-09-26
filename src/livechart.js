import { languageLabel, normalizeLanguageCode } from "./languages.js";
import { normalizeServiceName, normalizeServiceList } from "./services.js";
import { parseScheduleRows, isUpcomingSchedule } from "./livechartCatalog.js";
import { fetchLiveChartHtml, liveChartId } from "./livechartHttp.js";
import { RELEASE_POST_EXPIRY_HOURS } from "./schedule.js";
import { DateTime } from "luxon";
import { load } from "cheerio";

function decodeHtml(value) {
  return String(value || "")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function absoluteUrl(value, baseUrl) {
  try {
    return new URL(decodeHtml(value), baseUrl).toString();
  } catch {
    return "";
  }
}

function liveChartAnimeUrl(scheduleLink) {
  const id = liveChartId(scheduleLink);
  return id ? `https://www.livechart.me/anime/${id}` : "";
}

export function parseLiveChartTitle(html) {
  const $ = load(html);
  const title = $('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text();
  return String(title || '').replace(/\s*\|\s*LiveChart\.me\s*$/i, '')
    .replace(/\s+-\s+Release Schedules\s*$/i, '').replace(/\s+/g, ' ').trim();
}

export async function fetchLiveChartTitle(scheduleLink, { fetchHtml = fetchLiveChartHtml } = {}) {
  const url = liveChartAnimeUrl(scheduleLink);
  if (!url) throw new Error("Enter a valid LiveChart anime link.");
  const title = parseLiveChartTitle(await fetchHtml(url, { ttlMs: 24 * 3600000 }));
  if (!title || /^LiveChart\.me$/i.test(title)) throw new Error("No series title could be read from LiveChart. Enter it manually or try again later.");
  return title;
}

function parseLiveChartImage(html, baseUrl) {
  const candidates = [];
  const metaMatches = html.matchAll(/<(?:meta|link)\b[^>]+(?:property|name|rel)=["'][^"']*(?:og:image|twitter:image|image_src)[^"']*["'][^>]+>/gi);
  for (const match of metaMatches) {
    const content = match[0].match(/\b(?:content|href)=["']([^"']+)["']/i);
    if (content?.[1]) candidates.push(absoluteUrl(content[1], baseUrl));
  }

  const posterMatches = html.matchAll(/["']([^"']*\/poster_image\/[^"']+)["']/gi);
  for (const match of posterMatches) {
    candidates.push(absoluteUrl(match[1], baseUrl));
  }

  const poster = candidates.find((url) => /\/poster_image\//i.test(url)) || "";
  return poster.replace(/\/large\.(jpg|jpeg|png|webp)$/i, "/small.$1");
}

function pageText(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim();
}

function parseLiveChartEpisodeCount(html) {
  const text = pageText(html);
  const match = text.match(/\bEpisodes\s+(?:\d+\s*\/\s*)?(\d{1,4})\b/i);
  if (!match) return null;

  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}

const SERVICE_PATTERNS = [
  [/\bAKIBA PASS TV\b/i, "AKIBA PASS TV"],
  [/animation digital network|\bADN\b/i, "ADN"],
  [/\bCrunchyroll\b/i, "Crunchyroll"],
  [/\bNetflix\b/i, "Netflix"],
  [/\bAmazon Prime Video\b|\bPrime Video\b/i, "Prime Video"],
  [/\bYouTube\b/i, "YouTube"],
  [/\bAniverse Channel\b|\bAniverse\b/i, "Aniverse"],
  [/\bHIDIVE\b/i, "HIDIVE"],
  [/\bDisney\+/i, "Disney+"],
  [/\bHulu\b/i, "Hulu"],
  [/\bBilibili\b/i, "Bilibili"],
  [/\bAnimeBox\b/i, "AnimeBox"],
  [/\bAni-One(?:\s+Asia)?\b/i, "Ani-One"],
  [/\bApple TV\+/i, "Apple TV+"],
  [/\bMax\b/i, "Max"]
];

const LIVECHART_PAST_GRACE_SECONDS = 5 * 60;

function pickLowestTimestamp(items) {
  return [...items].sort((a, b) => a.timestamp - b.timestamp)[0] || null;
}

function isUpcomingTimestamp(timestamp, nowTimestamp) {
  return timestamp === Number.MAX_SAFE_INTEGER || timestamp >= nowTimestamp - LIVECHART_PAST_GRACE_SECONDS;
}

function upcomingItems(items, nowTimestamp) {
  return items.filter((item) => isUpcomingTimestamp(item.timestamp, nowTimestamp));
}

function dubAlreadyPosted(item, track) {
  if (!track || !Number.isFinite(item.episode)) return false;
  const posted = String(track.lastPostedKey || '').match(/:language:[^:]+:(\d+)(?:-(\d+))?:/);
  if (posted && Number(posted[2] || posted[1]) >= (item.episodeEnd || item.episode)) return true;
  const postedAt = DateTime.fromISO(track.lastPostedAt || '');
  return postedAt.isValid && postedAt.toSeconds() >= item.timestamp;
}

function isRecoverablePendingDub(item, code, tracks, nowTimestamp) {
  if (item.isReleased || !Number.isFinite(item.episode) || item.timestamp === Number.MAX_SAFE_INTEGER ||
      item.timestamp > nowTimestamp || item.timestamp < nowTimestamp - RELEASE_POST_EXPIRY_HOURS * 3600) return false;
  const track = tracks.find((entry) => entry.code === code && entry.enabled && entry.nextEpisode === item.episode);
  return Boolean(track && !dubAlreadyPosted(item, track));
}

function preferredLanguageCodes(values = []) {
  const codes = Array.isArray(values) ? values : [values];
  return [...new Set(codes.map(normalizeLanguageCode).filter((code) => code && code !== "ja"))];
}

function matchesPreferredLanguage(item, codes) {
  return codes.some((code) => item.subtitleCodes.includes(code));
}

function selectMainItems(items, preferredCodes, lockToPreferred = false) {
  const subbed = items.filter((item) => item.isSubbed);
  if (preferredCodes.length) {
    const preferred = subbed.filter((item) => matchesPreferredLanguage(item, preferredCodes));
    if (preferred.length || lockToPreferred) return preferred;
  }
  return subbed.length ? subbed : items;
}

function pickMainRelease(items, nowTimestamp) {
  return pickLowestTimestamp(upcomingItems(items, nowTimestamp));
}

function articleServices(text) {
  const services = [];
  for (const [pattern, service] of SERVICE_PATTERNS) {
    if (pattern.test(text)) services.push(normalizeServiceName(service));
  }
  return services;
}

function mergeServices(items) {
  const services = [];
  const seen = new Set();
  for (const item of items) {
    for (const service of item.services || []) {
      const key = service.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      services.push(service);
    }
  }
  return normalizeServiceList(services.join(","));
}

function servicesOverlap(left = [], right = []) {
  if (!left.length || !right.length) return true;
  const rightSet = new Set(right.map((service) => service.toLowerCase()));
  return left.some((service) => rightSet.has(service.toLowerCase()));
}

function sameReleaseBatch(left, right) {
  return (
    left &&
    right &&
    left.timestamp === right.timestamp &&
    left.partialDate === right.partialDate &&
    left.title === right.title &&
    servicesOverlap(left.services, right.services)
  );
}

function episodeBatchSize(items, release, filter = () => true) {
  if (!release || !Number.isFinite(release.episode)) return 1;

  const episodes = new Set();
  for (const item of items.filter((entry) => sameReleaseBatch(entry, release) && filter(entry))) {
    if (!Number.isFinite(item.episode)) continue;
    const end = Number.isFinite(item.episodeEnd) ? Math.min(item.episodeEnd, item.episode + 49) : item.episode;
    for (let episode = item.episode; episode <= end; episode += 1) episodes.add(episode);
  }

  let size = 0;
  while (episodes.has(release.episode + size)) size += 1;
  return Math.max(1, size);
}

export function parseLiveChartEpisodes(html, options = {}) {
  const nowTimestamp = Number.isFinite(options.nowTimestamp)
    ? options.nowTimestamp
    : Math.floor(Date.now() / 1000);
  const preferredCodes = preferredLanguageCodes(options.preferredLanguageCodes);
  const today = DateTime.fromSeconds(nowTimestamp, { zone: options.timeZone || 'Europe/Berlin' }).toISODate();
  const rows = parseScheduleRows(html).filter((row) => !row.regionWarning)
    .map((row) => ({ ...row, services: row.services.length ? row.services : articleServices(row.text) }));
  const parsed = rows.filter((row) => Number.isFinite(row.episode) && !row.isReleased &&
    (!row.partialDate || row.partialDate >= today));

  const mainItems = parsed.filter((item) => item.isMain);
  const allMainRows = rows.filter((item) => item.isMain);
  const preferredMainRows = preferredCodes.length
    ? allMainRows.filter((item) => item.isSubbed && matchesPreferredLanguage(item, preferredCodes))
    : [];
  const lockToPreferred = preferredMainRows.length > 0 || (preferredCodes.length > 0 && options.requirePreferredLanguage);
  const selectedMainItems = selectMainItems(mainItems, preferredCodes, lockToPreferred);
  const main = pickMainRelease(selectedMainItems, nowTimestamp);
  const pendingMain = !main && options.requirePreferredLanguage
    ? preferredMainRows.find((row) => isUpcomingSchedule(row, options, DateTime.fromSeconds(nowTimestamp))) : null;
  const mainEpisodeBatchSize = episodeBatchSize(upcomingItems(selectedMainItems, nowTimestamp), main);
  const mainRows = lockToPreferred ? preferredMainRows : selectMainItems(allMainRows, preferredCodes);
  const hasUpcomingMain = upcomingItems(selectedMainItems, nowTimestamp).length > 0;
  const mainFinished = !main && mainRows.some((item) => item.isReleased) && !hasUpcomingMain;
  const preferredReleaseFinished =
    lockToPreferred &&
    preferredMainRows.some((item) => item.isReleased) &&
    !mainItems.some((item) => item.isSubbed && matchesPreferredLanguage(item, preferredCodes));
  const languageByCode = new Map();

  const upcomingDubItems = options.requirePreferredLanguage
    ? rows.filter((row) => row.isDub && isUpcomingSchedule(row, options, DateTime.fromSeconds(nowTimestamp)))
    : upcomingItems(parsed.filter((entry) => entry.isDub), nowTimestamp);
  const pendingTracks = options.pendingLanguageTracks || [];
  // A sync may repair a cleared date after the countdown passed. Recover only an
  // already tracked, unposted episode within the scheduler's normal posting window.
  const recentDubItems = parsed.filter((row) => row.isDub &&
    row.audioCodes.some((code) => isRecoverablePendingDub(row, code, pendingTracks, nowTimestamp)));
  const dubItems = [...new Set([...upcomingDubItems, ...recentDubItems])];
  for (const item of dubItems) {
    for (const code of item.audioCodes) {
      if (code === "ja") continue;
      if (dubAlreadyPosted(item, pendingTracks.find((track) => track.code === code))) continue;
      if (!upcomingDubItems.includes(item) && !isRecoverablePendingDub(item, code, pendingTracks, nowTimestamp)) continue;
      const existing = languageByCode.get(code);
      if (existing && existing.timestamp <= item.timestamp) continue;
      languageByCode.set(code, {
        code,
        label: languageLabel(code),
        enabled: false,
        available: true,
        nextEpisode: item.episode,
        episodeBatchSize: episodeBatchSize(dubItems, item, (entry) =>
          entry.audioCodes.includes(code)
        ),
        releaseTimestamp: Number.isFinite(item.episode) ? item.timestamp : Number.MAX_SAFE_INTEGER,
        releaseDate: Number.isFinite(item.episode) ? item.partialDate : '',
        schedulePrecision: item.precision,
        requiresConfirmation: item.requiresConfirmation,
        source: item.title || "livechart",
        timestamp: item.timestamp,
        updatedAt: new Date().toISOString()
      });
    }
  }

  const languageTracks = [...languageByCode.values()].map(({ timestamp, ...track }) => track);
  const germanDub = languageTracks.find((track) => track.code === "de");
  const preferredServiceRows = preferredCodes.length
    ? rows.filter((item) => (item.isMain && matchesPreferredLanguage(item, preferredCodes)) ||
      (item.isDub && preferredCodes.some((code) => item.audioCodes.includes(code))))
    : [];
  const serviceRows = preferredServiceRows.length ? preferredServiceRows : main ? [main] : [];

  return {
    nextEpisode: main?.episode ?? null,
    episodeBatchSize: mainEpisodeBatchSize,
    mainReleaseTimestamp: main?.timestamp ?? null,
    mainReleaseDate: main?.partialDate || '',
    mainScheduleKnown: Boolean(main || pendingMain),
    mainEpisodeUnknown: Boolean(pendingMain),
    mainReleaseUnconfirmed: Boolean(main?.requiresConfirmation),
    mainSchedulePrecision: main?.precision ?? null,
    mainUnavailable: Boolean(options.requirePreferredLanguage && preferredCodes.length && !preferredMainRows.length),
    dubNextEpisode: germanDub?.nextEpisode ?? null,
    languageTracks,
    service: mergeServices(serviceRows),
    mainFinished,
    preferredReleaseFinished
  };
}

async function fetchLiveChartDetails(scheduleLink) {
  const animeUrl = liveChartAnimeUrl(scheduleLink);
  if (!animeUrl) return { imageUrl: "", episodeCount: null };

  const html = await fetchLiveChartHtml(animeUrl, { ttlMs: 24 * 3600000 });
  return {
    imageUrl: parseLiveChartImage(html, animeUrl),
    episodeCount: parseLiveChartEpisodeCount(html)
  };
}

export async function fetchLiveChartEpisodes(scheduleLink, options = {}) {
  if (!scheduleLink) throw new Error("No LiveChart link is set.");

  const live = parseLiveChartEpisodes(await fetchLiveChartHtml(scheduleLink), options);
  const details = await fetchLiveChartDetails(scheduleLink).catch((error) => {
    if ([403, 429].includes(error.status)) throw error;
    return { imageUrl: "", episodeCount: null };
  });
  return { ...live, ...details };
}
