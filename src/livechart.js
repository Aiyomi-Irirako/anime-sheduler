import { languageLabel, normalizeLanguageCode } from "./languages.js";
import { normalizeServiceName, normalizeServiceList } from "./services.js";

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
  try {
    const url = new URL(scheduleLink);
    url.pathname = url.pathname.replace(/\/schedules\/?$/i, "");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
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

function articleTitle(article) {
  const match = article.match(/title="([^"]+)"/i);
  return decodeHtml(match?.[1] || "");
}

function articleText(article) {
  return decodeHtml(article.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function articleEpisodeRange(article) {
  const label = decodeHtml(article.match(/data-label="([^"]+)"/i)?.[1] || "");
  const match = label.match(/^EP\s*(\d+)(?:\s*(?:-|[\u2013\u2014])\s*(\d+))?/i);
  if (!match) return { episode: null, episodeEnd: null };

  const episode = Number.parseInt(match[1], 10);
  const parsedEnd = Number.parseInt(match[2], 10);
  const episodeEnd = Number.isFinite(parsedEnd) && parsedEnd >= episode ? Math.min(parsedEnd, episode + 49) : episode;
  return { episode, episodeEnd };
}

function articleTimestamp(article) {
  const match = article.match(/data-timestamp="(\d+)"/i);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function articleLanguageCodes(article) {
  const codes = new Set();
  const matches = article.matchAll(/data-tracklist-json="([^"]+)"/gi);

  for (const match of matches) {
    try {
      const decoded = decodeHtml(match[1]);
      const parsed = JSON.parse(decoded);
      for (const code of Object.keys(parsed || {})) {
        const normalized = normalizeLanguageCode(code);
        if (normalized) codes.add(normalized);
      }
    } catch {
      // Ignore malformed embedded track metadata and fall back to visible labels below.
    }
  }

  const visibleCodes = article.matchAll(/<li>([A-Z]{2}(?:-[A-Z0-9]+)?)<\/li>/g);
  for (const match of visibleCodes) {
    const normalized = normalizeLanguageCode(match[1]);
    if (normalized) codes.add(normalized);
  }

  return [...codes];
}

const SERVICE_PATTERNS = [
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

function preferredLanguageCodes(values = []) {
  const codes = Array.isArray(values) ? values : [values];
  return [...new Set(codes.map(normalizeLanguageCode).filter((code) => code && code !== "ja"))];
}

function matchesPreferredLanguage(item, codes) {
  return codes.some((code) => item.languageCodes.includes(code));
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
  const articles = html.match(/<article\b[\s\S]*?<\/article>/gi) || [];
  const rows = articles
    .map((article) => {
      const text = articleText(article);
      const title = articleTitle(article);
      const episodeRange = articleEpisodeRange(article);
      const isDub = /dubbed|dub/i.test(title);
      const isSubbed = /simulcast:\s*sub(?:bed|titled)|\bsub(?:bed|titled)\b/i.test(title);
      const isBroadcastJapan = /broadcast\s*\(japan\)/i.test(title);
      const isMain = isSubbed || isBroadcastJapan;

      return {
        title,
        text,
        ...episodeRange,
        timestamp: articleTimestamp(article),
        languageCodes: articleLanguageCodes(article),
        services: articleServices(text),
        isReleased: /\bReleased\b/i.test(text),
        isDub,
        isSubbed,
        isBroadcastJapan,
        isMain
      };
    })
    .filter(Boolean);
  const parsed = rows.filter((row) => Number.isFinite(row.episode));

  const mainItems = parsed.filter((item) => item.isMain);
  const allMainRows = rows.filter((item) => item.isMain);
  const preferredMainRows = preferredCodes.length
    ? allMainRows.filter((item) => item.isSubbed && matchesPreferredLanguage(item, preferredCodes))
    : [];
  const lockToPreferred = preferredMainRows.length > 0;
  const selectedMainItems = selectMainItems(mainItems, preferredCodes, lockToPreferred);
  const main = pickMainRelease(selectedMainItems, nowTimestamp);
  const mainEpisodeBatchSize = episodeBatchSize(upcomingItems(selectedMainItems, nowTimestamp), main);
  const mainRows = lockToPreferred ? preferredMainRows : selectMainItems(allMainRows, preferredCodes);
  const hasUpcomingMain = upcomingItems(selectedMainItems, nowTimestamp).length > 0;
  const mainFinished = !main && mainRows.some((item) => item.isReleased) && !hasUpcomingMain;
  const preferredReleaseFinished =
    lockToPreferred &&
    preferredMainRows.some((item) => item.isReleased) &&
    !mainItems.some((item) => item.isSubbed && matchesPreferredLanguage(item, preferredCodes));
  const languageByCode = new Map();

  for (const item of upcomingItems(parsed.filter((entry) => entry.isDub), nowTimestamp)) {
    for (const code of item.languageCodes) {
      if (code === "ja") continue;
      const existing = languageByCode.get(code);
      if (existing && existing.timestamp <= item.timestamp) continue;
      languageByCode.set(code, {
        code,
        label: languageLabel(code),
        enabled: false,
        available: true,
        nextEpisode: item.episode,
        episodeBatchSize: episodeBatchSize(upcomingItems(parsed.filter((entry) => entry.isDub), nowTimestamp), item, (entry) =>
          entry.languageCodes.includes(code)
        ),
        releaseTimestamp: item.timestamp,
        source: item.title || "livechart",
        timestamp: item.timestamp,
        updatedAt: new Date().toISOString()
      });
    }
  }

  const languageTracks = [...languageByCode.values()].map(({ timestamp, ...track }) => track);
  const germanDub = languageTracks.find((track) => track.code === "de");
  const preferredServiceRows = preferredCodes.length
    ? rows.filter((item) => (item.isMain || item.isDub) && matchesPreferredLanguage(item, preferredCodes))
    : [];
  const serviceRows = preferredServiceRows.length ? preferredServiceRows : main ? [main] : [];

  return {
    nextEpisode: main?.episode ?? null,
    episodeBatchSize: mainEpisodeBatchSize,
    mainReleaseTimestamp: main?.timestamp ?? null,
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

  const response = await fetch(animeUrl, {
    headers: {
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) return { imageUrl: "", episodeCount: null };

  const html = await response.text();
  return {
    imageUrl: parseLiveChartImage(html, animeUrl),
    episodeCount: parseLiveChartEpisodeCount(html)
  };
}

export async function fetchLiveChartEpisodes(scheduleLink, options = {}) {
  if (!scheduleLink) throw new Error("No LiveChart link is set.");

  const response = await fetch(scheduleLink, {
    headers: {
      "user-agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    const error = new Error(`LiveChart responded with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  const live = parseLiveChartEpisodes(await response.text(), options);
  const details = await fetchLiveChartDetails(scheduleLink).catch(() => ({ imageUrl: "", episodeCount: null }));
  return { ...live, ...details };
}
