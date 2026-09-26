import { load } from 'cheerio';
import { DateTime } from 'luxon';
import { normalizeLanguageCode, languageLabel } from './languages.js';
import { normalizeServiceList, normalizeServiceName } from './services.js';
import { WEEKDAYS } from './constants.js';

const text = (node) => node.text().replace(/\s+/g, ' ').trim();
const unique = (values) => [...new Set(values.filter(Boolean))];
const positive = (value) => /^\d+$/.test(String(value || '')) && Number(value) > 0 ? Number(value) : null;

export function parseSeasonCatalog(html, season) {
  const $ = load(html);
  const items = new Map();
  $('article[data-anime-id]').each((_, element) => {
    const item = $(element);
    const id = item.attr('data-anime-id');
    const title = item.attr('data-english') || item.attr('data-romaji');
    if (!/^\d+$/.test(id || '') || !title) return;
    const count = text(item.find('.anime-episodes')).match(/^(\d+)\s+eps?\b/i);
    const malLink = item.find('a[href*="myanimelist.net/anime/"]').first().attr('href') || '';
    const poster = item.find('img').map((_, e) => $(e).attr('src') || $(e).attr('data-src')).get()
      .find((url) => url?.includes('/poster_image/')) || '';
    items.set(id, {
      id, title, seasons: [season], episodeCount: count ? positive(count[1]) : null,
      malId: malLink.match(/\/anime\/(\d+)/)?.[1] || '', imageUrl: poster.startsWith('https://') ? poster : '',
      premiereLabel: text(item.find('.anime-date')), services: [],
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
    const title = article.find('a[title]').first().attr('title') || '';
    const content = text(article);
    const releaseText = header.length ? text(header) : content;
    const label = article.find('[data-label]').first().attr('data-label') || releaseText;
    const batch = label.match(/\bAll\s+(\d+)\s+EPs\b/i);
    const range = label.match(/\bEP\s*(\d+)(?:\s*[-~\u2013\u2014]\s*(\d+))?/i);
    const episode = batch ? 1 : range ? positive(range[1]) : null;
    const end = batch ? positive(batch[1]) : range ? positive(range[2]) || episode : null;
    const timestamp = positive(article.find('[data-timestamp]').first().attr('data-timestamp'));
    const partial = article.find('[data-intl-time-datetime]').first();
    const precision = timestamp ? 4 : Number(partial.attr('data-intl-time-precision')) || null;
    const date = partial.attr('data-intl-time-datetime') || '';
    const audio = [], subtitles = [], legacy = [];
    article.find('[data-tracklist-json]').each((_, e) => {
      try {
        const node = $(e);
        const icons = node.prev().find('use').map((_, icon) => $(icon).attr('href') || $(icon).attr('xlink:href')).get();
        const target = icons.includes('#icon:audio') ? audio : icons.includes('#icon:subtitles') ? subtitles : legacy;
        target.push(...Object.keys(JSON.parse(node.attr('data-tracklist-json'))).map(normalizeLanguageCode));
      } catch { /* A malformed track list is not evidence of a language being available. */ }
    });
    const isDub = /\bdub(?:bed)?\b/i.test(title);
    const isSubbed = /\bsub(?:bed|titled)\b/i.test(title);
    const isBroadcastJapan = /broadcast\s*\(japan\)/i.test(title);
    const services = unique(article.find('.lc-text-contextual-accent').map((_, e) => normalizeServiceName(text($(e)))).get());
    return {
      title, text: content, episode, episodeEnd: end && episode ? Math.min(Math.max(episode, end), episode + 49) : episode,
      batch: Boolean(batch), timestamp: timestamp || Number.MAX_SAFE_INTEGER, precision,
      partialDate: precision === 3 && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      approximateDate: date,
      dateLabel: releaseText, requiresConfirmation: /requires confirmation/i.test(releaseText),
      regionWarning: /might not apply to your region/i.test(releaseText),
      audioCodes: unique(audio.length ? audio : isDub ? legacy : []),
      subtitleCodes: unique(subtitles.length ? subtitles : isSubbed ? legacy : []),
      languageCodes: unique([...audio, ...subtitles, ...legacy]), services,
      isDub, isSubbed, isBroadcastJapan, isMain: isSubbed || isBroadcastJapan,
      isReleased: /\bReleased/i.test(article.attr('data-release-schedule-release-schedule-id') ? releaseText : content)
    };
  }).get();
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

export function hasUpcomingGermanRelease(html, settings = {}, now = DateTime.now()) {
  const rows = parseScheduleRows(html);
  if (!rows.length) throw new Error('No LiveChart schedules could be read.');
  return rows.some((row) => isUpcomingSchedule(row, settings, now) &&
    ((row.isSubbed && row.subtitleCodes.includes('de')) || (row.isDub && row.audioCodes.includes('de'))));
}

export function buildDiscoveredSeries(candidate, scheduleHtml, detailHtml, settings, now = DateTime.now()) {
  const zone = settings.timeZone || 'Europe/Berlin';
  const language = settings.preferredScheduleLanguage || '';
  const parsed = parseScheduleRows(scheduleHtml);
  if (!parsed.length) throw new Error('No LiveChart schedules could be read.');
  const rows = parsed.filter((row) => isUpcomingSchedule(row, settings, now));
  const order = (a, b) => (a.timestamp - b.timestamp) || (a.partialDate || '9999').localeCompare(b.partialDate || '9999');
  const sub = rows.filter((row) => row.isSubbed && (!language || row.subtitleCodes.includes(language)));
  const main = sub.sort(order)[0];
  const enabledCodes = settings.enabledLanguageCodes || [];
  const languageTracks = enabledCodes.map((code) => {
    const row = rows.filter((r) => r.isDub && r.audioCodes.includes(code)).sort(order)[0];
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
  const premiere = DateTime.fromFormat(premiereText, 'MMM d, yyyy', { locale: 'en' });
  const dateFields = scheduleDateFields(main?.episode ? main : null, zone);
  return {
    title: candidate.title, service: normalizeServiceList(services.join(',')), scheduleLink: candidate.scheduleLink,
    malId: candidate.malId, imageUrl: candidate.imageUrl, episodeCount: candidate.episodeCount,
    premiereDate: premiere.isValid ? premiere.toISODate() : '',
    ...dateFields, nextEpisode: main?.episode ?? null,
    episodeBatchSize: main?.episode ? main.episodeEnd - main.episode + 1 : 1,
    rawRelease: main?.dateLabel || 'No matching subtitle schedule', languageTracks,
    liveChartLanguageStrict: true,
    weekly: !main?.batch, enabled: true, status: main?.episode > 1 ? 'airing' : 'planned'
  };
}
