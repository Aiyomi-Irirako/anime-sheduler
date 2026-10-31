import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createStore } from '../src/store.js';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { syncAllLiveChart, syncOneSeriesFromLiveChart } from '../src/livechartSync.js';
import { checkLateDubAnnouncements } from '../src/scheduler.js';

const now = DateTime.fromISO('2026-10-31T15:07:00', { zone: 'Europe/Berlin' });
const id = 'appraisal-skill';
const mainPostKey = `${id}:main:5:release-time:2026-10-25T16:00:00.000+01:00`;
const dubPostKey = `${id}:language:de:2:release-time:2026-10-25T16:00:00.000+01:00`;
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de',
  enabledLanguageCodes: ['de'], automaticDiscordPostsEnabled: true };
const unknownPage = '<html><article class="notice"><h1>Schedule information</h1><p>The layout has changed.</p></article></html>';

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-markup-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'isolated-db.json'));
  await store.init();
  // Minimal reproduction of the cleared schedules in the supplied backup.
  // Restoring data must not create new late-dub notifications.
  await store.replaceData({ ...store.snapshot(), settings: { ...store.getSettings(), ...settings }, series: [{
    id, title: "As a Reincarnated Aristocrat, I'll Use My Appraisal Skill to Rise in the World Season 3",
    scheduleLink: 'https://www.livechart.me/anime/12991/schedules',
    scheduleMode: 'livechart', liveChartLanguageStrict: true, liveChartImportLanguage: 'de',
    status: 'planned', enabled: true, nextEpisode: null, nextDate: '', releaseTime: '', releaseDay: '',
    episodeCount: null, lastPostedKey: mainPostKey, lastPostedAt: '2026-10-25T16:00:56+01:00',
    languageTracks: [{ code: 'de', enabled: true, available: true, nextEpisode: 3,
      nextDate: '', releaseTime: '', releaseDay: '', weekly: true,
      lastPostedKey: dubPostKey, lastPostedAt: '2026-10-25T16:00:56+01:00', source: 'Streaming: Dubbed' }],
    ...overrides
  }] });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  return store;
}

function parseFetcher(html) {
  return async (_, options) => parseLiveChartEpisodes(html, options);
}

function germanTrack(store) {
  return store.getSeries(id).languageTracks.find(track => track.code === 'de');
}

test('current LiveChart markup repairs cleared original and German dub schedules without resetting post history', async (t) => {
  const store = await setup(t);
  const html = await fs.readFile(new URL('./fixtures/livechart-schedules-20261031.html', import.meta.url), 'utf8');
  const beforeMainAt = store.getSeries(id).lastPostedAt;
  const beforeDubAt = germanTrack(store).lastPostedAt;
  const synced = await syncOneSeriesFromLiveChart(store, store.getSeries(id), {
    now, overwriteSchedule: true, fetchEpisodes: parseFetcher(html)
  });
  assert.equal(synced.changed, true);
  const series = store.getSeries(id);
  assert.equal(series.nextEpisode, 6);
  assert.equal(series.nextDate, '2026-11-01');
  assert.equal(series.releaseTime, '16:00');
  assert.equal(series.releaseDay, 'sunday');
  assert.equal(series.service, 'Crunchyroll');
  assert.equal(series.lastPostedKey, mainPostKey);
  assert.equal(series.lastPostedAt, beforeMainAt);
  const track = germanTrack(store);
  assert.equal(track.nextEpisode, 3);
  assert.equal(track.nextDate, '2026-11-01');
  assert.equal(track.releaseTime, '16:00');
  assert.equal(track.lastPostedKey, dubPostKey);
  assert.equal(track.lastPostedAt, beforeDubAt);
  assert.deepEqual(series.lateDubNotices, []);
  let posts = 0;
  const discord = { enabled: true, ready: true, async post() { posts += 1; throw new Error('Unexpected Discord post'); } };
  assert.deepEqual(await checkLateDubAnnouncements(store, discord, { now }), { posted: 0, failed: 0 });
  assert.equal(posts, 0);
  await syncOneSeriesFromLiveChart(store, store.getSeries(id), {
    now: now.plus({ minutes: 1 }), overwriteSchedule: true, fetchEpisodes: parseFetcher(html)
  });
  assert.equal(store.getSeries(id).nextEpisode, 6);
  assert.equal(germanTrack(store).nextEpisode, 3);
  assert.equal(germanTrack(store).nextDate, '2026-11-01');
  assert.deepEqual(store.getSeries(id).lateDubNotices, []);
});

test('unrecognized schedule articles fail a single sync without erasing saved release data', async (t) => {
  const store = await setup(t, { nextEpisode: 6, nextDate: '2026-11-01', releaseTime: '16:00', releaseDay: 'sunday' });
  const before = structuredClone(store.getSeries(id));
  await assert.rejects(syncOneSeriesFromLiveChart(store, store.getSeries(id), {
    now, overwriteSchedule: true, fetchEpisodes: parseFetcher(unknownPage)
  }), /schedule|read/i);
  assert.deepEqual(store.getSeries(id), before);
});

test('a full sync reports unrecognized source markup as failed and retains the stored series', async (t) => {
  const store = await setup(t, { nextEpisode: 6, nextDate: '2026-11-01', releaseTime: '16:00', releaseDay: 'sunday' });
  const before = structuredClone(store.getSeries(id));
  const result = await syncAllLiveChart(store, { now, delayMs: 0, fetchEpisodes: parseFetcher(unknownPage) });
  assert.equal(result.checked, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.summary, /1 failed/);
  assert.deepEqual(store.getSeries(id), before);
});
