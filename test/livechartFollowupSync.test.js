import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createStore } from '../src/store.js';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { syncOneSeriesFromLiveChart } from '../src/livechartSync.js';
import { getNextRelease, listUpcoming } from '../src/schedule.js';

const now = DateTime.fromISO('2026-10-31T16:12:00', { zone: 'Europe/Berlin' });
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'] };
const examples = [
  { id: '13548', title: "So What's Wrong with Getting Reborn as a Goblin?", episode: 6,
    at: '2026-11-02T14:00:00', service: 'Crunchyroll', ignored: ['Streaming (Japan)'] },
  { id: '13733', title: 'Zi Jin: Yu Miao Fang', episode: 8,
    at: '2026-11-04T15:30:00', service: 'Crunchyroll', ignored: ['Streaming (China)'], combined: true },
  { id: '13093', title: 'Girls und Panzer: Motto Love Love Sakusen Desu!', episode: 5,
    at: '2026-11-05T18:00:00', service: 'aniverse Channel',
    ignored: ['Theaters (Japan)', 'Digital Rental (Japan)', 'Blu-ray (Japan)'] },
  { id: '13790', title: "My Girlfriend's Friend Mini Anime", episode: 5,
    at: '2026-11-01T17:05:00', service: 'Animation Digital Network', ignored: ['Streaming (Japan)'] }
];

function languageList(role, language) {
  return `<span data-release-schedule-info-target="${role}" data-tracklist-data='{"${language}":[["${language}"],["Language"]]}'>${language}</span>`;
}

function knownLocalRow(type, index, { regional = true } = {}) {
  const at = now.plus({ hours: 1 });
  return `<article data-controller="release-schedule"><a href="/anime/123/schedules/${index}"></a>
    <div><time data-label="EP1" data-timestamp="${at.toSeconds()}">EP1</time>
    ${regional ? '<div>This schedule might not apply to your region.</div>' : ''}</div>
    <div title="${type}">${type}</div>${languageList('auralTracklist', type.includes('China') ? 'zh' : 'ja')}</article>`;
}

function validGermanRow(example) {
  const at = DateTime.fromISO(example.at, { zone: settings.timeZone });
  const type = example.combined ? 'Streaming: Dubbed, Subbed' : 'Simulcast: Subbed';
  return `<article data-controller="release-schedule"><a href="/anime/${example.id}/schedules/90000"></a>
    <div><time data-label="EP${example.episode}" data-timestamp="${at.toSeconds()}">EP${example.episode}</time></div>
    <div title="${type}">${type}</div><span class="lc-text-contextual-accent">${example.service}</span>
    ${languageList('auralTracklist', example.combined ? 'zh' : 'ja')}
    ${languageList('textualTracklist', 'de')}</article>`;
}

async function setup(t, series) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-followup-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'isolated-db.json'));
  await store.init();
  await store.replaceData({ ...store.snapshot(), settings: { ...store.getSettings(), ...settings }, series: [series] });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  return store;
}

for (const example of examples) {
  test(`a fresh sync returns ${example.title} to upcoming releases`, async (t) => {
    const store = await setup(t, {
      id: example.id, title: example.title, scheduleLink: `https://www.livechart.me/anime/${example.id}/schedules`,
      scheduleMode: 'livechart', liveChartLanguageStrict: true, liveChartImportLanguage: 'de',
      enabled: true, status: 'airing', nextEpisode: null, nextDate: '', releaseTime: '', releaseDay: '',
      languageTracks: [], episodeCount: null, lastPostedKey: 'KEEP-HISTORY', lastPostedAt: '2026-10-20T18:00:00+02:00'
    });
    assert.equal(listUpcoming(store.listSeries(), store.getSettings(), 14, now).length, 0);
    const html = example.ignored.map((type, index) => knownLocalRow(type, index + 1,
      { regional: index % 2 === 0 })).join('') + validGermanRow(example);
    await syncOneSeriesFromLiveChart(store, store.getSeries(example.id), {
      now, overwriteSchedule: true,
      fetchEpisodes: async (_, options) => parseLiveChartEpisodes(html, options)
    });
    const series = store.getSeries(example.id);
    const expected = DateTime.fromISO(example.at, { zone: settings.timeZone });
    assert.equal(series.nextEpisode, example.episode);
    assert.equal(series.nextDate, expected.toISODate());
    assert.equal(series.releaseTime, expected.toFormat('HH:mm'));
    assert.equal(series.lastPostedKey, 'KEEP-HISTORY');
    assert.equal(series.lastPostedAt, '2026-10-20T18:00:00+02:00');
    assert.equal(getNextRelease(series, store.getSettings(), now).episode, example.episode);
    const upcoming = listUpcoming(store.listSeries(), store.getSettings(), 14, now);
    assert.equal(upcoming.length, 1);
    assert.equal(upcoming[0].series.id, example.id);
    assert.equal(upcoming[0].release.dateTime.toISO(), expected.toISO());
  });
}

test('a truly unknown release category preserves previously saved dates', async (t) => {
  const example = examples[0];
  const store = await setup(t, { id: example.id, title: example.title,
    scheduleLink: `https://www.livechart.me/anime/${example.id}/schedules`, scheduleMode: 'livechart',
    enabled: true, status: 'airing', nextEpisode: 6, nextDate: '2026-11-02', releaseTime: '14:00',
    liveChartLanguageStrict: true, languageTracks: [] });
  const before = structuredClone(store.getSeries(example.id));
  const html = knownLocalRow('A new unrecognized schedule kind', 1) + validGermanRow(example);
  await assert.rejects(syncOneSeriesFromLiveChart(store, before, {
    now, overwriteSchedule: true, fetchEpisodes: async (_, options) => parseLiveChartEpisodes(html, options)
  }), /schedule format could not be read/);
  assert.deepEqual(store.getSeries(example.id), before);
});

for (const [title, badTotal] of [['Black Clover', 1], ['Ranma', 161]]) {
  test(`an explicitly unknown own total clears the polluted ${title} count without finishing or advancing it`, async (t) => {
    const store = await setup(t, { id: 'polluted-total', title,
      scheduleLink: 'https://www.livechart.me/anime/123/schedules', scheduleMode: 'livechart',
      enabled: true, status: 'airing', nextEpisode: 5, nextDate: '2026-11-01', releaseTime: '18:00',
      episodeCount: badTotal, languageTracks: [], lastPostedKey: 'KEEP-POST', lastPostedAt: '2026-10-20T18:00:00+02:00' });
    const releaseAt = now.plus({ days: 1 }).set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
    await syncOneSeriesFromLiveChart(store, store.getSeries('polluted-total'), {
      now, overwriteSchedule: true, fetchEpisodes: async () => ({
        episodeCount: null, episodeCountKnown: true, nextEpisode: 5,
        mainReleaseTimestamp: releaseAt.toSeconds(), mainScheduleKnown: true, mainFinished: false, languageTracks: []
      })
    });
    const saved = store.getSeries('polluted-total');
    assert.equal(saved.episodeCount, null);
    assert.equal(saved.nextEpisode, 5);
    assert.equal(saved.enabled, true);
    assert.equal(saved.status, 'airing');
    assert.equal(saved.lastPostedKey, 'KEEP-POST');
    assert.equal(saved.lastPostedAt, '2026-10-20T18:00:00+02:00');
    assert.equal(getNextRelease(saved, store.getSettings(), now).episodeEnd, 5);
  });
}

test('a missing metadata response does not erase an existing manually entered total', async (t) => {
  const store = await setup(t, { id: 'known-total', title: 'Known total',
    scheduleLink: 'https://www.livechart.me/anime/123/schedules', scheduleMode: 'livechart',
    enabled: true, status: 'airing', nextEpisode: 5, nextDate: '2026-11-01', releaseTime: '18:00',
    episodeCount: 24, languageTracks: [] });
  await syncOneSeriesFromLiveChart(store, store.getSeries('known-total'), {
    now, overwriteSchedule: true,
    fetchEpisodes: async () => ({ episodeCount: null, nextEpisode: 5, mainFinished: false, languageTracks: [] })
  });
  assert.equal(store.getSeries('known-total').episodeCount, 24);
});
