import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { DateTime } from 'luxon';
import { parseSeasonCatalog, parseScheduleRows, selectScheduleRows, scheduleDateFields,
  buildDiscoveredSeries, hasUpcomingGermanRelease } from '../src/livechartCatalog.js';
import { parseLiveChartEpisodes } from '../src/livechart.js';

const fixture = await fs.readFile(new URL('./fixtures/livechart-schedules-20261031.html', import.meta.url), 'utf8');
const now = DateTime.fromISO('2026-10-31T15:07:00', { zone: 'Europe/Berlin' });
const options = { timeZone: 'Europe/Berlin', preferredLanguageCodes: ['de'],
  requirePreferredLanguage: true, nowTimestamp: now.toSeconds() };
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'] };
const candidate = { title: 'Example Season 3', scheduleLink: 'https://www.livechart.me/anime/12991/schedules' };

function currentRow({ label = 'EP2', timestamp = '1793545200', heading = '', title = 'Streaming: Dubbed',
  track = '<span data-release-schedule-info-target="auralTracklist" data-tracklist-data=\'{"de":[["DE"],["German"]]}\'>DE</span>',
  warning = '', menu = '' } = {}) {
  return `<article data-controller="release-schedule"><a href="/anime/12991/schedules/19978"></a>
    <div>${heading || `<time data-label="${label}"${timestamp ? ` data-timestamp="${timestamp}"` : ''}>${label}</time>`}</div>
    <div>${warning}</div><div><div title="${title}">${title}</div><span class="lc-text-contextual-accent">Crunchyroll</span>${track}</div>
    ${menu}</article>`;
}

test('October markup reads separate type headings, exact countdowns and typed language lists', () => {
  const rows = selectScheduleRows(fixture);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.scheduleId), ['14636', '19981', '19978']);
  assert.deepEqual(rows[1].audioCodes, ['ja']);
  assert.deepEqual(rows[1].subtitleCodes, ['de', 'en']);
  assert.equal(rows[1].isReleased, false, 'a menu mentioning released must not finish a release');
  assert.equal(rows[2].isDub, true);
  assert.deepEqual(rows[2].audioCodes, ['de']);
  const live = parseLiveChartEpisodes(fixture, options);
  assert.equal(live.nextEpisode, 6);
  assert.equal(live.mainReleaseTimestamp, 1793545200);
  assert.equal(live.mainUnavailable, false);
  assert.equal(live.languageTracks.find(track => track.code === 'de').nextEpisode, 3);
  assert.equal(live.service, 'Crunchyroll');
  assert.deepEqual(scheduleDateFields(rows[1], settings.timeZone), {
    nextDate: '2026-11-01', releaseTime: '16:00', releaseDay: 'sunday'
  });
});

test('new hashed audio/subtitle icons also classify track lists when role targets are absent', () => {
  const html = currentRow({ title: 'Simulcast: Subbed', track: `<svg><use href="#ic-volume_up--abc"></use></svg>
    <span data-tracklist-data='{"ja":[["JA"],["Japanese"]]}'>JA</span>
    <svg><use href="#ic-subtitles--def"></use></svg>
    <span data-tracklist-data='{"de":[["DE"],["German"]]}'>DE</span>` });
  const [row] = selectScheduleRows(html);
  assert.deepEqual(row.audioCodes, ['ja']);
  assert.deepEqual(row.subtitleCodes, ['de']);
  assert.equal(hasUpcomingGermanRelease(html, settings, now), true);
});

test('new warnings outside the empty interaction link retain confirmation and regional safeguards', () => {
  const confirmation = currentRow({ warning: 'This release requires confirmation.' });
  assert.equal(selectScheduleRows(confirmation)[0].requiresConfirmation, true);
  assert.equal(parseLiveChartEpisodes(confirmation, options).languageTracks[0].releaseTimestamp, 1793545200);
  const regional = currentRow({ warning: 'This might not apply to your region.' });
  assert.equal(selectScheduleRows(regional)[0].regionWarning, true);
  assert.equal(hasUpcomingGermanRelease(regional, settings, now), false);
  assert.deepEqual(parseLiveChartEpisodes(regional, options).languageTracks, []);
});

test('Released belongs to the release heading and never to a notification menu', () => {
  const released = currentRow({ heading: 'Released' });
  assert.equal(selectScheduleRows(released)[0].isReleased, true);
  assert.equal(hasUpcomingGermanRelease(released, settings, now), false);
  const menu = currentRow({ menu: '<div popover="auto"><span>Released</span>This release requires confirmation. This might not apply to your region.</div>' });
  const row = selectScheduleRows(menu)[0];
  assert.equal(row.isReleased, false);
  assert.equal(row.requiresConfirmation, false);
  assert.equal(row.regionWarning, false);
});

test('new partial and unknown schedule headings do not invent an exact date or episode', () => {
  for (const modern of [false, true]) {
    for (const [date, precision, expectedDate] of [['2027-01-01', 1, ''], ['2027-01-01', 2, ''], ['2027-01-04', 3, '2027-01-04']]) {
      const attributes = modern ? `datetime="${date}" data-formatted-temporal-precision="${precision}" data-controller="formatted-temporal"` :
        `data-intl-time-datetime="${date}" data-intl-time-precision="${precision}"`;
      const html = currentRow({ timestamp: '', heading: `<time>EP1: <time ${attributes}>${date}</time></time>` });
      const [row] = selectScheduleRows(html);
      const schedule = scheduleDateFields(row, settings.timeZone);
      assert.equal(schedule.nextDate, expectedDate);
      assert.equal(schedule.releaseTime, '');
      const live = parseLiveChartEpisodes(html, options);
      assert.equal(live.languageTracks[0].nextEpisode, 1);
      assert.equal(row.precision, precision);
      assert.equal(row.approximateDate, date);
    }
  }
  const unknown = currentRow({ timestamp: '', label: 'Upcoming' });
  assert.equal(parseLiveChartEpisodes(unknown, options).languageTracks[0].nextEpisode, null);
});

test('unrelated articles and unrecognized schedule kinds fail closed', () => {
  const news = '<article><a href="/news">Upcoming release news</a></article>';
  assert.deepEqual(parseScheduleRows(news), []);
  assert.throws(() => parseLiveChartEpisodes(news, options), /No LiveChart schedules/);
  assert.throws(() => selectScheduleRows(currentRow({ title: 'A new unrecognized schedule kind' })), /schedule format could not be read/);
  assert.equal(selectScheduleRows(news + fixture).length, 3);
});

test('malformed, empty or missing language markup is an error while valid foreign lists remain readable', () => {
  for (const track of ['', '<span data-tracklist-data="broken"></span>',
    '<span data-tracklist-data="[]"></span>', '<span data-tracklist-data="{}"></span>',
    '<span data-release-schedule-info-target="auralTracklist">DE</span>']) {
    assert.throws(() => parseLiveChartEpisodes(currentRow({ track }), options), /schedule languages could not be read/);
  }
  const foreign = currentRow({ title: 'Simulcast: Subbed', track: '<span data-release-schedule-info-target="textualTracklist" data-tracklist-data=\'{"en":[["EN"],["English"]]}\'>EN</span>' });
  assert.equal(parseLiveChartEpisodes(foreign, options).mainUnavailable, true);
  const onlyAudio = currentRow({ title: 'Simulcast: Subbed', track: '<span data-release-schedule-info-target="auralTracklist" data-tracklist-data=\'{"ja":[["JA"],["Japanese"]]}\'>JA</span>' });
  const onlySubtitles = currentRow({ title: 'Streaming: Dubbed', track: '<span data-release-schedule-info-target="textualTracklist" data-tracklist-data=\'{"de":[["DE"],["German"]]}\'>DE</span>' });
  assert.throws(() => parseLiveChartEpisodes(onlyAudio, options), /schedule languages could not be read/);
  assert.throws(() => parseLiveChartEpisodes(onlySubtitles, options), /schedule languages could not be read/);
});

test('new catalogue attributes preserve titles, episode counts, premiere labels and metadata', () => {
  const catalogue = `<article data-anime-item-id="13226" data-anime-item-english-title="The Apothecary Diaries Season 3 Cour 1"
    data-anime-item-romanized-native-title="Kusuriya no Hitorigoto 3rd Season Cour 1">
    <a data-anime-item-target="preferredTitle" href="/anime/13226">Preferred title</a>
    <img src="https://u.livechart.me/anime/13226/poster_image/example/small.jpg">
    <a href="https://myanimelist.net/anime/12345">MAL</a>
    <div class="lc-anime-details-card__metadata"><div>Light Novel</div><div>12 eps × 24m</div></div>
    <div class="lc-anime-details-card__premiere">Oct 2, 2026, 4:00 PM</div></article>`;
  const [item] = parseSeasonCatalog(catalogue, 'fall-2026');
  assert.equal(item.id, '13226');
  assert.equal(item.title, 'The Apothecary Diaries Season 3 Cour 1');
  assert.equal(item.episodeCount, 12);
  assert.equal(item.malId, '12345');
  assert.equal(item.premiereLabel, 'Oct 2, 2026, 4:00 PM');
  assert.equal(item.imageUrl, 'https://u.livechart.me/anime/13226/poster_image/example/small.jpg');
  assert.equal(parseSeasonCatalog(catalogue.replace('data-anime-item-english-title=', 'data-unused='), 'fall-2026')[0].title,
    'Kusuriya no Hitorigoto 3rd Season Cour 1');
  assert.equal(parseSeasonCatalog(catalogue.replace(/ data-anime-item-(?:english-title|romanized-native-title)="[^"]*"/g, ''), 'fall-2026')[0].title,
    'Preferred title');
});

test('current detail premiere datetime is used without guessing from the subtitle schedule', () => {
  const detail = '<div><div>Premiere</div><time datetime="2026-09-27T15:00:00Z" data-controller="formatted-temporal">September 27, 2026</time></div>';
  const draft = buildDiscoveredSeries(candidate, fixture, detail, settings, now);
  assert.equal(draft.premiereDate, '2026-09-27');
  assert.equal(draft.nextDate, '2026-11-01');
  assert.equal(draft.nextEpisode, 6);
});
