import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createStore } from '../src/store.js';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { prepareLiveLanguageTracks, prepareLiveMainSchedule, syncOneSeriesFromLiveChart } from '../src/livechartSync.js';
import { getNextRelease, getNextLanguageRelease } from '../src/schedule.js';

const zone = 'Europe/Berlin';
const date = value => DateTime.fromISO(value, { zone });
const now = date('2026-11-08T15:35:00');
const future = date('2026-11-14T18:00:00');
const settings = { timeZone: zone, preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'] };
const row = ({ episode = 'EP7', at = future, dub = false, language = 'de', released = false } = {}) =>
  `<article data-controller="release-schedule"><a href="/anime/13150/schedules/${dub ? 2 : 1}"></a>
  <div>${released ? 'Released' : `<time data-label="${episode}" data-timestamp="${at.toSeconds()}">${episode}</time>`}</div>
  <div title="Streaming: ${dub ? 'Dubbed' : 'Subbed'}">Streaming</div>
  <span data-release-schedule-info-target="${dub ? 'auralTracklist' : 'textualTracklist'}"
  data-tracklist-data='{"${language}":[["${language}"],["Language"]]}'>${language}</span>
  <span class="lc-text-contextual-accent">Disney+</span></article>`;

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-livechart-release-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'isolated-db.json'));
  await store.init();
  await store.replaceData({ ...store.snapshot(), settings: { ...store.getSettings(), ...settings }, series: [{
    id: 'restored-release', title: 'Restored release', scheduleMode: 'livechart',
    scheduleLink: 'https://www.livechart.me/anime/13150/schedules',
    liveChartLanguageStrict: true, liveChartImportLanguage: 'de',
    status: 'planned', enabled: true, nextEpisode: null, nextDate: '', releaseDay: '', releaseTime: '',
    episodeCount: 12, languageTracks: [],
    lastPostedKey: 'restored-release:main:5:release-time:2026-10-31T18:00:00.000+01:00',
    lastPostedAt: '2026-10-31T18:00:10+01:00', ...overrides
  }] });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  const current = () => store.getSeries('restored-release');
  const sync = html => syncOneSeriesFromLiveChart(store, current(), { now, overwriteSchedule: true,
    fetchEpisodes: async (_, options) => parseLiveChartEpisodes(html, options) });
  return { store, current, sync };
}

test('exact dub timestamps derive local weekdays consistently with main releases across UTC midnight', () => {
  const timestamp = DateTime.fromISO('2026-11-08T23:30:00Z').toSeconds();
  const main = prepareLiveMainSchedule({ mainReleaseTimestamp: timestamp }, settings);
  const [dub] = prepareLiveLanguageTracks([{ code: 'de', releaseTimestamp: timestamp, releaseDay: 'sunday' }], settings);
  assert.equal(main.releaseDay, 'monday');
  for (const field of ['nextDate', 'releaseTime', 'releaseDay']) assert.equal(dub[field], main[field]);
  assert.equal(dub.nextDate, '2026-11-09');
  assert.equal(dub.releaseTime, '00:30');
});

test('derived dub weekdays retain explicit incoming date and time values', () => {
  const [dub] = prepareLiveLanguageTracks([{ code: 'de', releaseTimestamp: date('2026-11-23T17:30:00').toSeconds(),
    nextDate: '2026-11-23', releaseTime: '20:15', releaseDay: '' }], settings);
  assert.equal(dub.nextDate, '2026-11-23');
  assert.equal(dub.releaseTime, '20:15');
  assert.equal(dub.releaseDay, 'monday');
});

test('date-only dub sources derive their weekday while month/year and unknown sources clear stale dates', () => {
  for (const precision of [1, 2, null]) {
    const [dub] = prepareLiveLanguageTracks([{ code: 'de', releaseTimestamp: Number.MAX_SAFE_INTEGER,
      schedulePrecision: precision, releaseDate: '', nextDate: '2026-11-09', releaseDay: 'monday', releaseTime: '18:00' }], settings);
    assert.equal(dub.nextDate, '');
    assert.equal(dub.releaseDay, '');
    assert.equal(dub.releaseTime, '');
  }
  const [dub] = prepareLiveLanguageTracks([{ code: 'de', releaseTimestamp: Number.MAX_SAFE_INTEGER,
    schedulePrecision: 3, releaseDate: '2026-11-23', releaseTime: '18:00' }], settings);
  assert.equal(dub.nextDate, '2026-11-23');
  assert.equal(dub.releaseDay, 'monday');
  assert.equal(dub.releaseTime, '');
});

for (const status of ['planned', 'unknown']) {
  test(`a restored later source episode corrects ${status} to airing without changing post history`, async t => {
    const { current, sync } = await setup(t, { status });
    const before = structuredClone(current());
    await sync(row());
    assert.equal(current().status, 'airing');
    assert.equal(current().nextEpisode, 7);
    assert.equal(current().nextDate, '2026-11-14');
    assert.equal(current().releaseDay, 'saturday');
    assert.equal(current().lastPostedKey, before.lastPostedKey);
    assert.equal(current().lastPostedAt, before.lastPostedAt);
  });
}

for (const episode of ['EP1', 'All12EPs']) {
  test(`a future ${episode} remains planned despite an old premiere or early reminder`, async t => {
    const { current, sync } = await setup(t, { premiereDate: '2020-01-01', nextEpisode: 1,
      lastPostedKey: `restored-release:main:1:release-time:${future.toISO()}`, lastPostedAt: now.toISO() });
    await sync(row({ episode }));
    assert.equal(current().status, 'planned');
    assert.equal(current().nextEpisode, 1);
  });
}

test('a first episode changes to airing at its source time', async t => {
  const { current, sync } = await setup(t, { nextEpisode: 1 });
  await sync(row({ episode: 'EP1', at: now }));
  assert.equal(current().status, 'airing');
});

for (const missing of [row({ language: 'en' }), row({ episode: 'Upcoming' })]) {
  test(`an ${missing.includes('Upcoming') ? 'unspecified' : 'absent'} main source does not promote a stale planned counter`, async t => {
    const { current, sync } = await setup(t, { nextEpisode: 7, premiereDate: '2020-01-01' });
    await sync(missing);
    assert.equal(current().status, 'planned');
    assert.equal(current().nextDate, '');
    assert.equal(current().releaseDay, '');
  });
}

for (const [episode, expectedStatus] of [['EP1', 'planned'], ['EP7', 'airing']]) {
  test(`a finished original reactivated by a future ${episode} has status ${expectedStatus}`, async t => {
    const { store, current, sync } = await setup(t, { status: 'finished', enabled: false,
      nextEpisode: null, lastPostedKey: 'restored-release:main:12:release-time:2026-09-01T18:00:00+02:00' });
    await sync(row({ episode }));
    assert.equal(current().status, expectedStatus);
    assert.equal(current().enabled, true);
    assert.equal(getNextRelease(current(), store.getSettings(), now).episode, Number(episode.slice(2)));
  });
}

test('a finished original retains its status while its German dub gets the exact local date, time and weekday', async t => {
  const { store, current, sync } = await setup(t, { status: 'finished', nextEpisode: null,
    languageTracks: [{ code: 'de', enabled: true, available: true, nextEpisode: 9,
      nextDate: '', releaseDay: '', releaseTime: '', lastPostedKey: 'restored-release:language:de:8:release-time:2026-10-17T16:30:00+02:00' }] });
  await sync(row({ released: true }) + row({ dub: true, episode: 'EP9', at: date('2026-11-23T17:30:00') }));
  assert.equal(current().status, 'finished');
  const dub = current().languageTracks.find(track => track.code === 'de');
  assert.equal(dub.nextDate, '2026-11-23');
  assert.equal(dub.releaseTime, '17:30');
  assert.equal(dub.releaseDay, 'monday');
  assert.equal(getNextLanguageRelease(current(), dub, store.getSettings(), now).episode, 9);
});

test('manually scheduled release state is untouched and never queries the source', async t => {
  const { store, current } = await setup(t, { scheduleMode: 'manual', nextEpisode: 7, releaseDay: 'thursday' });
  const before = structuredClone(current());
  const result = await syncOneSeriesFromLiveChart(store, current(), { now, overwriteSchedule: true,
    fetchEpisodes: async () => { throw new Error('Manual schedule must not fetch'); } });
  assert.equal(result.skipped, true);
  assert.deepEqual(current(), before);
});
