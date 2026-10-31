import { languageLabel, normalizeLanguageCode } from "./languages.js";
import { normalizeServiceName, normalizeServiceList } from "./services.js";
import { selectScheduleRows, isUpcomingSchedule } from "./livechartCatalog.js";
import { fetchLiveChartHtml, liveChartId } from "./livechartHttp.js";
import { RELEASE_POST_EXPIRY_HOURS } from "./schedule.js";
import { MAX_EPISODE_BATCH_SIZE } from "./constants.js";
import { LATE_DUB_LOOKBACK_DAYS } from "./lateDub.js";
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

export function liveChartScheduleTarget(value) {
  const animeId = liveChartId(value);
  if (!animeId) throw new Error('Enter a valid LiveChart anime or schedule link.');
  const url = new URL(value);
  const match = url.pathname.match(/^\/anime\/\d+(?:\/schedules(?:\/(\d+))?)?\/?$/);
  if (!match || (match[1] && Number(match[1]) < 1)) {
    throw new Error('Enter a LiveChart anime link or a link to one of its release schedules.');
  }
  const scheduleId = match[1]?.replace(/^0+(?=\d)/, '') || '';
  const animeUrl = `https://www.livechart.me/anime/${animeId}`;
  const schedulesUrl = `${animeUrl}/schedules`;
  return { animeId, scheduleId, animeUrl, schedulesUrl,
    scheduleLink: scheduleId ? `${schedulesUrl}/${scheduleId}` : schedulesUrl };
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

function parseLiveChartEpisodeCount(html, animeUrl) {
  const $ = load(html);
  const animeId = liveChartId(animeUrl);
  const positiveCount = (value) => /^\d+$/.test(value || '') && Number(value) > 0 &&
    Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const ownWidget = $('[data-anime-details-target~="viewingProgression"], [data-viewing-progression-anime-id]')
    .filter((_, element) => {
      const node = $(element);
      const id = node.attr('data-viewing-progression-anime-id');
      const detailId = node.closest('[data-controller~="anime-details"]').attr('data-anime-details-id');
      if (animeId && detailId && detailId !== animeId) return false;
      return id ? id === animeId : node.is('[data-anime-details-target~="viewingProgression"]');
    }).first();
  if (ownWidget.length) {
    const total = ownWidget.attr('data-viewing-progression-total-count-value');
    const episodeCount = positiveCount(total);
    // An absent total on the detail widget means LiveChart has not announced it.
    // Related titles can still have their own totals elsewhere on the same page.
    return { episodeCount, episodeCountKnown: episodeCount !== null || total === undefined };
  }

  // Older pages expose an Episodes field without a progression component.
  // Read that field alone; never search recommendation cards or the whole page.
  const detail = $('[data-controller~="anime-details"]').filter((_, element) =>
    !animeId || $(element).attr('data-anime-details-id') === animeId).first();
  const scope = detail.length ? detail : $.root();
  const fields = scope.find('*').filter((_, element) => {
    const node = $(element);
    const detailId = node.closest('[data-controller~="anime-details"]').attr('data-anime-details-id');
    return (!animeId || !detailId || detailId === animeId) && !node.children().length &&
      !node.closest('script, style, article[data-anime-id], article[data-anime-item-id]').length &&
      /^Episodes(?:\s|$)/i.test(node.text().trim());
  });
  for (const element of fields) {
    const field = $(element);
    const container = /^Episodes$/i.test(field.text().trim()) ? field.parent() : field;
    const widget = container.find('[data-viewing-progression-total-count-value]').filter((_, element) =>
      !$(element).attr('data-viewing-progression-anime-id') ||
      $(element).attr('data-viewing-progression-anime-id') === animeId).first();
    if (widget.length) {
      const episodeCount = positiveCount(widget.attr('data-viewing-progression-total-count-value'));
      return { episodeCount, episodeCountKnown: episodeCount !== null };
    }
    const value = pageText($.html(container));
    const match = value.match(/^Episodes\s+(?:\d+\s*\/\s*)?(\d+)(?![\d.])\b/i);
    const episodeCount = positiveCount(match?.[1]);
    if (episodeCount !== null) return { episodeCount, episodeCountKnown: true };
  }
  return { episodeCount: null, episodeCountKnown: false };
}

export function parseLiveChartMetadata(html, animeUrl) {
  const $ = load(html);
  const malLink = $('a[href*="myanimelist.net/anime/"]').first().attr('href') || '';
  const premiereLabel = $('*').filter((_, element) => $(element).children().length === 0 &&
    $(element).text().trim() === 'Premiere').first();
  const premiereText = premiereLabel.parent().text().replace(/^\s*Premiere\s*/, '').trim();
  const premiereTime = premiereLabel.parent().find('time[datetime]').first().attr('datetime') || '';
  const isoPremiere = DateTime.fromISO(premiereTime, { zone: 'utc' });
  const premiere = isoPremiere.isValid ? isoPremiere
    : DateTime.fromFormat(premiereText, 'MMM d, yyyy', { locale: 'en' });
  return { title: parseLiveChartTitle(html), imageUrl: parseLiveChartImage(html, animeUrl),
    ...parseLiveChartEpisodeCount(html, animeUrl), malId: malLink.match(/\/anime\/(\d+)/)?.[1] || '',
    premiereDate: premiere.isValid ? premiere.toISODate() : '' };
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

function dubAlreadyPosted(item, track, timeZone = 'Europe/Berlin') {
  if (!track || !Number.isFinite(item.episode)) return false;
  // Episode counters may have advanced during a delay. A later source date is
  // still pending even when its episode is below an earlier (incorrect) post.
  const exact = item.timestamp !== Number.MAX_SAFE_INTEGER;
  const releaseAt = exact ? DateTime.fromSeconds(item.timestamp) :
    DateTime.fromISO(item.partialDate || '', { zone: timeZone });
  if (!releaseAt.isValid) return false;
  const postedDates = [track.lastPostedAt,
    String(track.lastPostedKey || '').match(/:(?:release-time|missing-time):(.+)$/)?.[1]]
    .map(value => DateTime.fromISO(value || '')).filter(value => value.isValid);
  if (postedDates.length) {
    // Reminders can be sent before the actual release, so also compare the
    // scheduled date in the post key instead of only its send time.
    return postedDates.some(postedAt => exact ? postedAt >= releaseAt :
      postedAt.setZone(timeZone).toISODate() >= releaseAt.toISODate());
  }
  const posted = String(track.lastPostedKey || '').match(/:language:[^:]+:(\d+)(?:-(\d+))?:/);
  return Boolean(posted && Number(posted[2] || posted[1]) >= (item.episodeEnd || item.episode));
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

  const ranges = items.filter(entry => sameReleaseBatch(entry, release) && filter(entry) && Number.isFinite(entry.episode))
    .sort((left, right) => left.episode - right.episode);
  const limit = release.episode + MAX_EPISODE_BATCH_SIZE - 1;
  let end = release.episode - 1;
  for (const item of ranges) {
    if (item.episode > end + 1) break;
    end = Math.max(end, Math.min(Number.isFinite(item.episodeEnd) ? item.episodeEnd : item.episode, limit));
    if (end === limit) break;
  }
  return Math.max(1, end - release.episode + 1);
}

export function parseLiveChartEpisodes(html, options = {}) {
  const nowTimestamp = Number.isFinite(options.nowTimestamp)
    ? options.nowTimestamp
    : Math.floor(Date.now() / 1000);
  const preferredCodes = preferredLanguageCodes(options.preferredLanguageCodes);
  const today = DateTime.fromSeconds(nowTimestamp, { zone: options.timeZone || 'Europe/Berlin' }).toISODate();
  const rows = selectScheduleRows(html, options.scheduleId).filter((row) => !row.regionWarning)
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

  const upcomingDubItems = rows.filter((row) => row.isDub &&
    isUpcomingSchedule(row, options, DateTime.fromSeconds(nowTimestamp)));
  const pendingTracks = options.pendingLanguageTracks || [];
  // A sync may repair a cleared date after the countdown passed. Recover only an
  // already tracked, unposted episode within the scheduler's normal posting window.
  const recentDubItems = parsed.filter((row) => row.isDub &&
    row.audioCodes.some((code) => isRecoverablePendingDub(row, code, pendingTracks, nowTimestamp)));
  const dubItems = [...new Set([...upcomingDubItems, ...recentDubItems])];
  for (const item of dubItems) {
    for (const code of item.audioCodes) {
      if (code === "ja") continue;
      if (dubAlreadyPosted(item, pendingTracks.find((track) => track.code === code), options.timeZone)) continue;
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
  // Keep explicit late premiere evidence separate from the next release schedule.
  // It must never revive an expired weekly dub date or overwrite a future episode.
  const lateDubReleases = rows.filter((row) => row.isDub && !row.isReleased && !row.requiresConfirmation &&
    row.episode === 1 && row.timestamp !== Number.MAX_SAFE_INTEGER &&
    row.timestamp < nowTimestamp - RELEASE_POST_EXPIRY_HOURS * 3600 &&
    row.timestamp >= nowTimestamp - LATE_DUB_LOOKBACK_DAYS * 24 * 3600)
    .flatMap((row) => row.audioCodes.filter((code) => code !== "ja").map((languageCode) => ({
      languageCode, episode: 1,
      episodeEnd: episodeBatchSize(rows, row, (entry) => entry.isDub && !entry.isReleased &&
        !entry.requiresConfirmation && entry.audioCodes.includes(languageCode)),
      releaseAt: DateTime.fromSeconds(row.timestamp, { zone: "utc" }).toISO()
    })));
  const finishedLanguageCodes = [...new Set(rows.filter(row => row.isDub && row.isReleased && !/^Release ended\b/i.test(row.dateLabel))
    .flatMap(row => row.audioCodes))].filter(code => !rows.some(row =>
      row.isDub && !row.isReleased && row.audioCodes.includes(code)));
  // A successful source read with no usable next dub must cancel a locally
  // extrapolated weekly date. Keep pending episodes so a pause is not a finale.
  const unscheduledLanguageTracks = pendingTracks.filter(track =>
    Number.isFinite(track.nextEpisode) && !languageByCode.has(track.code)).map(track => {
    const pendingRows = rows.filter(row => row.isDub && !row.isReleased && row.audioCodes.includes(track.code));
    const source = [...pendingRows].sort((a, b) => b.timestamp - a.timestamp)[0];
    const posted = String(track.lastPostedKey || '').match(/:language:[^:]+:(\d+)(?:-(\d+))?:/);
    const inflated = source && posted && Number.isFinite(source.episode) &&
      source.episode < Number(posted[2] || posted[1]);
    return { code: track.code, nextEpisode: inflated ? source.episode : track.nextEpisode,
      episodeBatchSize: inflated ? episodeBatchSize(pendingRows, source, row => row.audioCodes.includes(track.code)) : track.episodeBatchSize,
      nextDate: '', releaseDay: '', releaseTime: '' };
  });
  const germanDub = languageTracks.find((track) => track.code === "de");
  const preferredServiceRows = preferredCodes.length
    ? rows.filter((item) => (item.isMain && matchesPreferredLanguage(item, preferredCodes)) ||
      (item.isDub && preferredCodes.some((code) => item.audioCodes.includes(code))))
    : [];
  const upcomingServiceRows = preferredServiceRows.filter(item =>
    isUpcomingSchedule(item, options, DateTime.fromSeconds(nowTimestamp)));
  const serviceRows = upcomingServiceRows.length ? upcomingServiceRows
    : preferredServiceRows.length ? preferredServiceRows : main ? [main] : [];

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
    lateDubReleases,
    unscheduledLanguageTracks,
    finishedLanguageCodes,
    service: mergeServices(serviceRows),
    mainFinished,
    preferredReleaseFinished
  };
}

async function fetchLiveChartDetails(scheduleLink, fetchHtml = fetchLiveChartHtml) {
  const animeUrl = liveChartAnimeUrl(scheduleLink);
  if (!animeUrl) return { imageUrl: "", episodeCount: null };

  const html = await fetchHtml(animeUrl, { ttlMs: 24 * 3600000 });
  return {
    imageUrl: parseLiveChartImage(html, animeUrl),
    ...parseLiveChartEpisodeCount(html, animeUrl)
  };
}

export async function fetchLiveChartEpisodes(scheduleLink, options = {}) {
  if (!scheduleLink) throw new Error("No LiveChart link is set.");

  const target = liveChartScheduleTarget(scheduleLink);
  const fetchHtml = options.fetchHtml || fetchLiveChartHtml;
  const live = parseLiveChartEpisodes(await fetchHtml(target.schedulesUrl), { ...options, scheduleId: target.scheduleId });
  const details = await fetchLiveChartDetails(scheduleLink, fetchHtml).catch((error) => {
    if ([403, 429].includes(error.status)) throw error;
    return { imageUrl: "", episodeCount: null };
  });
  return { ...live, ...details };
}
