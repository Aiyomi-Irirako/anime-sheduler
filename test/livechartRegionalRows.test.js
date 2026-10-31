import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { hasUpcomingGermanRelease, selectScheduleRows } from '../src/livechartCatalog.js';

const now = DateTime.fromISO('2026-10-31T17:46:00', { zone: 'Europe/Berlin' });
const options = { preferredLanguageCodes: ['de'], requirePreferredLanguage: true,
  timeZone: 'Europe/Berlin', nowTimestamp: now.toSeconds() };
const row = (type, language, regional) => `<article data-controller="release-schedule">
  <a href="/anime/13839/schedules/1"></a><div><time>Released</time>
  ${regional ? '<div>This schedule might not apply to your region.</div>' : ''}</div>
  <div title="${type}">${type}</div>${language}</article>`;
const audio = '<span data-release-schedule-info-target="auralTracklist" data-tracklist-data=\'{"ja":[["JA"],["Japanese"]]}\'>JA</span>';
const subtitles = '<span data-release-schedule-info-target="textualTracklist" data-tracklist-data=\'{"de":[["DE"],["German"]]}\'>DE</span>';

test('inapplicable cinema rows with missing subtitles cannot block a valid German release', () => {
  const html = row('Theaters (Japan): Dubbed, Subbed', audio, true) + row('Streaming: Subbed', subtitles, false);
  assert.equal(selectScheduleRows(html).length, 2);
  const live = parseLiveChartEpisodes(html, options);
  assert.equal(live.mainFinished, true);
  assert.equal(live.mainUnavailable, false);
  assert.equal(hasUpcomingGermanRelease(html, {}, now), false);
});

test('Blu-ray/DVD and home-video categories are recognized as local distribution rows', () => {
  for (const type of ['Blu-ray/DVD (Japan)', 'Home Video (North America)']) {
    assert.equal(selectScheduleRows(row(type, audio, false))[0].isOtherSchedule, true);
  }
});

test('regional Unknown Format rows are skipped without admitting an unrecognized local source', () => {
  const regional = row('Unknown Format (Japan)', audio, true);
  assert.equal(selectScheduleRows(regional).length, 1);
  assert.equal(hasUpcomingGermanRelease(regional, {}, now), false);
  assert.equal(parseLiveChartEpisodes(regional, options).nextEpisode, null);
  assert.throws(() => selectScheduleRows(row('Unknown Format (Japan)', audio, false)), /format could not be read/);
});

test('incomplete applicable language lists still fail instead of clearing stored data', () => {
  assert.throws(() => selectScheduleRows(row('Streaming: Subbed', audio, false)), /languages could not be read/);
});
