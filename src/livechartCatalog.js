import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeLanguageCode, languageLabel } from './languages.js';
import { normalizeServiceList, normalizeServiceName } from './services.js';
import { MAX_EPISODE_BATCH_SIZE, WEEKDAYS } from './constants.js';

const text = (node) => node.text().replace(/\s+/g, ' ').trim();
const unique = (values) => [...new Set(values.filter(Boolean))];
const positive = (value) => /^\d+$/.test(String(value || '')) && Number(value) > 0 ? Number(value) : null;
const SCHEDULE_CATEGORY = /^(?:Broadcast|Streaming|Simulcast|Theaters|Digital Rental|Blu-ray|DVD|Event Screening)(?:\s*\([^)]*\))?(?::\s*.+)?$/i;

export function parseSeasonCatalog(html, season) {
  const $ = load(html);
  const items = new Map();
  $('article[data-anime-id], article[data-anime-item-id]').each((_, element) => {
    const item = $(element);
    const id = item.attr('data-anime-id') || item.attr('data-anime-item-id');
    const title = item.attr('data-english') || item.attr('data-anime-item-english-title') ||
      item.attr('data-romaji') || item.attr('data-anime-item-romanized-native-title') ||
      text(item.find('[data-anime-item-target~="preferredTitle"]').first());
    if (!/^\d+$/.test(id || '') || !title) return;
    const metadata = item.find('.anime-episodes, .lc-anime-details-card__metadata').map((_, e) => {
      const node = $(e);
      return node.children().length ? node.children().map((_, child) => text($(child))).get().join(' ') : text(node);
    }).get().join(' ');
    const count = metadata.match(/\b(\d+)\s+eps?\b/i);
    const malLink = item.find('a[href*="myanimelist.net/anime/"]').first().attr('href') || '';
    const poster = item.find('img').map((_, e) => $(e).attr('src') || $(e).attr('data-src')).get()
      .find((url) => url?.includes('/poster_image/')) || '';
    items.set(id, {
      id, title, seasons: [season], episodeCount: count ? positive(count[1]) : null,
      malId: malLink.match(/\/anime\/(\d+)/)?.[1] || '', imageUrl: poster.startsWith('https://') ? poster : '',
      premiereLabel: text(item.find('.anime-date, .lc-anime-details-card__premiere')), services: [],
      scheduleLink: `https://www.livechart.me/anime/${id}/schedules`
    });
  });
  if (!items.size) throw new Error(`No titles found for ${season}; previous results were kept.`);
  if (items.size > 600) throw new Error('LiveChart season exceeds the 600-title limit.');
  return [...items.values()];
}

export function parseScheduleRows(html) {
  const $ = load(html);
  return $('article').map((_, element) => {
    const article = $(element);
    const header = article.children('a').first();
    const type = article.find('[title]').filter((_, e) => {
      const value = $(e).attr('title') || '';
      return SCHEDULE_CATEGORY.test(value) || /\b(?:dub(?:bed)?|sub(?:bed|titled))\b|broadcast\s*\(japan\)/i.test(value);
    }).first();
    const title = type.attr('title') || '';
    const hasScheduleIdentity = article.is('[data-release-schedule-release-schedule-id], [data-controller~="release-schedule"]') ||
      /\/schedules\/\d+(?:\/|$|[?#])/.test(header.attr('href') || '');
    if (!title && !hasScheduleIdentity) return null;
    const visible = article.clone();
    visible.find('[popover], [hidden], menu, script, style').remove();
    const content = text(visible);
    const directText = visible.contents().filter((_, node) => node.type === 'text').text().trim();
    const countdown = article.find('[data-label], [data-timestamp], [data-intl-time-datetime], [data-formatted-temporal-precision]').first();
    let heading = countdown;
    while (heading.length && heading.parent().length && heading.parent()[0] !== element) heading = heading.parent();
    // Current cards use an empty interaction link followed by a separate heading.
    const releaseText = text(header) || text(heading) || text(article.children('div').first()) || content;
    const label = article.find('[data-label]').first().attr('data-label') || releaseText;
    const batch = label.match(/\bAll\s*(\d+)\s*EPs\b/i);
    const range = label.match(/\bEP\s*(\d+)(?:\s*[-~\u2013\u2014]\s*(\d+))?/i);
    const episode = batch ? 1 : range ? positive(range[1]) : null;
    const end = batch ? positive(batch[1]) : range ? positive(range[2]) || episode : null;
    const timestamp = positive(article.find('[data-timestamp]').first().attr('data-timestamp'));
    const partial = article.find('[data-intl-time-datetime], [data-formatted-temporal-precision]').first();
    const precision = timestamp ? 4 : Number(partial.attr('data-intl-time-precision') || partial.attr('data-formatted-temporal-precision')) || null;
    const date = partial.attr('data-intl-time-datetime') || partial.attr('datetime') || '';
    const audio = [], subtitles = [], legacy = [];
    const tracklists = article.find('[data-tracklist-json], [data-tracklist-data], [data-release-schedule-info-target~="auralTracklist"], [data-release-schedule-info-target~="textualTracklist"]');
    let languageDataReadable = tracklists.length > 0;
    tracklists.each((_, e) => {
      try {
        const node = $(e);
        const icons = node.prev().find('use').map((_, icon) => $(icon).attr('href') || $(icon).attr('xlink:href')).get();
        const role = (node.attr('data-release-schedule-info-target') || '').split(/\s+/);
        const target = role.includes('auralTracklist') || icons.some(icon => icon === '#icon:audio' || /^#ic-volume_up(?:--|$)/.test(icon)) ? audio :
          role.includes('textualTracklist') || icons.some(icon => icon === '#icon:subtitles' || /^#ic-subtitles(?:--|$)/.test(icon)) ? subtitles : legacy;
        const tracks = JSON.parse(node.attr('data-tracklist-json') || node.attr('data-tracklist-data'));
        if (!tracks || typeof tracks !== 'object' || Array.isArray(tracks)) { languageDataReadable = false; return; }
        target.push(...Object.keys(tracks).map(normalizeLanguageCode));
      } catch { languageDataReadable = false; }
    });
    const isDub = /\bdub(?:bed)?\b/i.test(title);
    const isSubbed = /\bsub(?:bed|titled)\b/i.test(title);
    const isBroadcastJapan = /broadcast\s*\(japan\)/i.test(title);
    const isOtherSchedule = SCHEDULE_CATEGORY.test(title) && !isDub && !isSubbed && !isBroadcastJapan;
    if (isOtherSchedule && !hasScheduleIdentity) return null;
    languageDataReadable = languageDataReadable &&
      (!isSubbed || unique([...subtitles, ...legacy]).length > 0) &&
      (!isDub || unique([...audio, ...legacy]).length > 0);
    const services = unique(article.find('.lc-text-contextual-accent').map((_, e) => normalizeServiceName(text($(e)))).get());
    return {
      scheduleId: String(positive(article.attr('data-release-schedule-release-schedule-id')) ||
        positive(header.attr('href')?.match(/\/schedules\/(\d+)(?:\/|$|[?#])/)?.[1]) || ''),
      title, text: content, episode, episodeEnd: end && episode ? Math.min(Math.max(episode, end), episode + MAX_EPISODE_BATCH_SIZE - 1) : episode,
      batchEpisodeCount: batch ? positive(batch[1]) : null,
      batch: Boolean(batch), timestamp: timestamp || Number.MAX_SAFE_INTEGER, precision,
      partialDate: precision === 3 && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      approximateDate: date,
      dateLabel: releaseText, requiresConfirmation: /requires confirmation/i.test(content),
      regionWarning: /might not apply to your region/i.test(content),
      audioCodes: unique(audio.length ? audio : isDub ? legacy : []),
      subtitleCodes: unique(subtitles.length ? subtitles : isSubbed ? legacy : []),
      languageCodes: unique([...audio, ...subtitles, ...legacy]), languageDataReadable, services,
      isDub, isSubbed, isBroadcastJapan, isOtherSchedule, isMain: isSubbed || isBroadcastJapan,
      isReleased: /^(?:Released\b|Release ended\b)/i.test(releaseText) || (!hasScheduleIdentity &&
        (/^Released$/i.test(directText) || visible.find('*').filter((_, e) => !$(e).children().length && /^Released$/i.test(text($(e)))).length > 0))
    };
  }).get();
}

export function selectScheduleRows(html, scheduleId = '') {
  const rows = parseScheduleRows(html);
  if (!rows.length) throw new Error('No LiveChart schedules could be read.');
  if (rows.some(row => !row.isDub && !row.isMain && !row.isOtherSchedule)) {
    throw new Error('The LiveChart schedule format could not be read; previous data was kept.');
  }
  if (rows.some(row => (row.isSubbed || row.isDub) && !row.languageDataReadable)) {
    throw new Error('The LiveChart schedule languages could not be read; previous data was kept.');
  }
  if (!scheduleId) return rows;
  const selected = rows.filter(row => row.scheduleId === String(scheduleId));
  if (!selected.length) throw new Error('The selected LiveChart schedule could not be found. Check the schedule link.');
  return selected;
}

export function scheduleDateFields(row, timeZone = 'Europe/Berlin') {
  if (!row) return { nextDate: '', releaseTime: '', releaseDay: '' };
  const exact = row.timestamp !== Number.MAX_SAFE_INTEGER && Number.isFinite(row.timestamp) && row.timestamp > 0;
  const date = exact ? DateTime.fromSeconds(row.timestamp, { zone: timeZone }) :
    row.partialDate ? DateTime.fromISO(row.partialDate, { zone: timeZone }) : null;
  return date?.isValid ? {
    nextDate: date.toISODate(), releaseTime: exact ? date.toFormat('HH:mm') : '',
    releaseDay: WEEKDAYS[date.weekday - 1].key
  } : { nextDate: '', releaseTime: '', releaseDay: '' };
}

export function isUpcomingSchedule(row, settings = {}, now = DateTime.now()) {
  if (row.isReleased || row.regionWarning) return false;
  if (row.timestamp !== Number.MAX_SAFE_INTEGER) return row.timestamp >= now.toSeconds() - 300;
  const date = DateTime.fromISO(row.approximateDate || '', { zone: settings.timeZone || 'Europe/Berlin' });
  if (!date.isValid) return true;
  const period = row.precision === 1 ? 'year' : row.precision === 2 ? 'month' : 'day';
  return date.endOf(period) >= now;
}

export function hasUpcomingGermanRelease(html, settings = {}, now = DateTime.now(), { scheduleId = '' } = {}) {
  const rows = selectScheduleRows(html, scheduleId);
  return rows.some((row) => isUpcomingSchedule(row, settings, now) &&
    ((row.isSubbed && row.subtitleCodes.includes('de')) || (row.isDub && row.audioCodes.includes('de'))));
}

export function buildDiscoveredSeries(candidate, scheduleHtml, detailHtml, settings, now = DateTime.now(), { scheduleId = '' } = {}) {
  const zone = settings.timeZone || 'Europe/Berlin';
  const language = settings.preferredScheduleLanguage || '';
  const parsed = selectScheduleRows(scheduleHtml, scheduleId);
  const rows = parsed.filter((row) => isUpcomingSchedule(row, settings, now));
  const order = (a, b) => (a.timestamp - b.timestamp) || (a.partialDate || '9999').localeCompare(b.partialDate || '9999');
  const sub = rows.filter((row) => row.isSubbed && (!language || row.subtitleCodes.includes(language)));
  const main = sub.sort(order)[0];
  const enabledCodes = settings.enabledLanguageCodes || [];
  const selectedDubs = [];
  const languageTracks = enabledCodes.map((code) => {
    const row = rows.filter((r) => r.isDub && r.audioCodes.includes(code)).sort(order)[0];
    if (row) selectedDubs.push(row);
    return row ? {
      code, label: languageLabel(code), enabled: true, available: true,
      nextEpisode: row.episode, episodeBatchSize: row.episode ? row.episodeEnd - row.episode + 1 : 1,
      ...scheduleDateFields(row.episode ? row : null, zone), weekly: !row.batch, source: 'livechart'
    } : null;
  }).filter(Boolean);
  const services = unique([...sub, ...rows.filter((row) => row.isDub && row.audioCodes.some((code) => enabledCodes.includes(code)))]
    .flatMap((row) => row.services));
  const $ = load(detailHtml);
  const premiereLabel = $('*').filter((_, e) => $(e).children().length === 0 && text($(e)) === 'Premiere').first();
  const premiereText = text(premiereLabel.parent()).replace(/^Premiere\s*/, '');
  const premiereIso = premiereLabel.parent().find('time[datetime]').first().attr('datetime');
  const premiere = premiereIso ? DateTime.fromISO(premiereIso, { zone }) :
    DateTime.fromFormat(premiereText, 'MMM d, yyyy', { locale: 'en' });
  const dateFields = scheduleDateFields(main?.episode ? main : null, zone);
  return {
    title: candidate.title, service: normalizeServiceList(services.join(',')), scheduleLink: candidate.scheduleLink,
    malId: candidate.malId, imageUrl: candidate.imageUrl,
    episodeCount: candidate.episodeCount ?? main?.batchEpisodeCount ?? selectedDubs.find(row => row.batchEpisodeCount)?.batchEpisodeCount ?? null,
    premiereDate: premiere.isValid ? premiere.toISODate() : '',
    ...dateFields, nextEpisode: main?.episode ?? null,
    episodeBatchSize: main?.episode ? main.episodeEnd - main.episode + 1 : 1,
    rawRelease: main?.dateLabel || 'No matching subtitle schedule', languageTracks,
    liveChartLanguageStrict: true,
    weekly: !main?.batch, enabled: true, status: main?.episode > 1 ? 'airing' : 'planned'
  };
}
