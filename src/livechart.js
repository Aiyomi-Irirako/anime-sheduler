import { languageLabel, normalizeLanguageCode } from "./languages.js";

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

function articleTitle(article) {
  const match = article.match(/title="([^"]+)"/i);
  return decodeHtml(match?.[1] || "");
}

function articleEpisode(article) {
  const match = article.match(/data-label="EP(\d+)"/i);
  return match ? Number.parseInt(match[1], 10) : null;
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

function pickMainRelease(items, nowTimestamp) {
  const upcoming = upcomingItems(items, nowTimestamp);
  const subbed = upcoming.filter((item) => item.isSubbed);
  return pickLowestTimestamp(subbed.length ? subbed : upcoming);
}

export function parseLiveChartEpisodes(html, options = {}) {
  const nowTimestamp = Number.isFinite(options.nowTimestamp)
    ? options.nowTimestamp
    : Math.floor(Date.now() / 1000);
  const articles = html.match(/<article\b[\s\S]*?<\/article>/gi) || [];
  const parsed = articles
    .map((article) => {
      const episode = articleEpisode(article);
      if (!episode) return null;

      const title = articleTitle(article);
      const languageCodes = articleLanguageCodes(article);
      const isDub = /dubbed|dub/i.test(title);
      const isSubbed = /simulcast:\s*sub(?:bed|titled)|\bsub(?:bed|titled)\b/i.test(title);
      const isBroadcastJapan = /broadcast\s*\(japan\)/i.test(title);
      const isMain = isSubbed || isBroadcastJapan;

      return {
        episode,
        title,
        timestamp: articleTimestamp(article),
        languageCodes,
        isDub,
        isSubbed,
        isBroadcastJapan,
        isMain
      };
    })
    .filter(Boolean);

  const main = pickMainRelease(parsed.filter((item) => item.isMain), nowTimestamp);
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
        releaseTimestamp: item.timestamp,
        source: item.title || "livechart",
        timestamp: item.timestamp,
        updatedAt: new Date().toISOString()
      });
    }
  }

  const languageTracks = [...languageByCode.values()].map(({ timestamp, ...track }) => track);
  const germanDub = languageTracks.find((track) => track.code === "de");

  return {
    nextEpisode: main?.episode ?? null,
    dubNextEpisode: germanDub?.nextEpisode ?? null,
    languageTracks
  };
}

async function fetchLiveChartImage(scheduleLink) {
  const animeUrl = liveChartAnimeUrl(scheduleLink);
  if (!animeUrl) return "";

  const response = await fetch(animeUrl, {
    headers: {
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!response.ok) return "";

  return parseLiveChartImage(await response.text(), animeUrl);
}

export async function fetchLiveChartEpisodes(scheduleLink) {
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

  const live = parseLiveChartEpisodes(await response.text());
  const imageUrl = await fetchLiveChartImage(scheduleLink).catch(() => "");
  return { ...live, imageUrl };
}
