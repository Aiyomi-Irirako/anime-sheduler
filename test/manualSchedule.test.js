import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createStore } from '../src/store.js';
import { syncAllLiveChart, syncOneSeriesFromLiveChart } from '../src/livechartSync.js';
import { checkDueAnnouncements } from '../src/scheduler.js';

const releaseAt = DateTime.fromISO('2026-10-01T18:00:00', { zone: 'Europe/Berlin' });
const baseSeries = {
  id: 'kubo', title: "Kubo Won't Let Me Be Invisible", service: 'Prime Video',
  scheduleLink: 'https://www.livechart.me/anime/11218/schedules', scheduleMode: 'manual',
  premiereDate: '2023-01-10', nextDate: '2026-10-01', releaseDay: 'thursday', releaseTime: '',
  nextEpisode: 1, episodeBatchSize: 12, episodeCount: 12, weekly: false,
  enabled: true, status: 'planned', languageTracks: [], streamingServiceId: 'KEEP'
};

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-manual-release-'));
  const filename = path.join(directory, 'db.json');
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('anime-manual-release-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = createStore(filename);
  await store.init();
  await store.updateSettings({ ...store.getSettings(), timeZone: 'Europe/Berlin', reminderMinutes: 0,
    missingTimePostTime: '18:00', automaticDiscordPostsEnabled: true, enabledLanguageCodes: [] });
  await store.upsertSeries({ ...baseSeries, ...overrides });
  const messages = [];
  const discord = { enabled: true, ready: true, async post(message) { messages.push(message.embeds[0].toJSON()); } };
  return { store, filename, messages, discord };
}

const noFetch = async () => { throw new Error('A manual release must not query LiveChart'); };
const noSync = async () => { throw new Error('A manual release must not run a pre-post sync'); };

test('manual schedule mode persists through reload and backup while legacy entries follow LiveChart', async (t) => {
  const { store, filename } = await setup(t);
  const restored = createStore(filename);
  await restored.init();
  assert.equal(restored.getSeries('kubo').scheduleMode, 'manual');
  await restored.replaceData(store.snapshot());
  assert.equal(restored.getSeries('kubo').scheduleMode, 'manual');
  const { scheduleMode, ...legacy } = baseSeries;
  await restored.upsertSeries({ ...legacy, id: 'legacy', title: 'Legacy', scheduleLink: '' });
  assert.equal(restored.getSeries('legacy').scheduleMode, 'livechart');
  await restored.upsertSeries({ ...restored.getSeries('kubo'), scheduleMode: 'livechart' });
  assert.equal(restored.getSeries('kubo').scheduleMode, 'livechart');
  assert.ok(restored.snapshot().changeLog.some(entry => entry.changes.some(change => change.field === 'scheduleMode')));
});

test('single and daily sync leave manual dates, service, progress and language tracks untouched without HTTP', async (t) => {
  const { store } = await setup(t, { languageTracks: [{ code: 'de', enabled: true, nextEpisode: 1,
    nextDate: '2026-10-08', releaseTime: '20:00', episodeBatchSize: 1, weekly: true }] });
  const before = store.getSeries('kubo');
  const result = await syncOneSeriesFromLiveChart(store, before, { overwriteSchedule: true, fetchEpisodes: noFetch });
  assert.equal(result.changed, false);
  assert.equal(result.skipped, true);
  assert.deepEqual(store.getSeries('kubo'), before);
  const daily = await syncAllLiveChart(store, { now: releaseAt.minus({ days: 1 }), delayMs: 0, fetchEpisodes: noFetch });
  assert.equal(daily.checked, 0);
  assert.deepEqual(store.getSeries('kubo'), before);
});

test('an old title with a new complete-season release posts one batch at the fallback time and completes', async (t) => {
  const { store, filename, messages, discord } = await setup(t, {
    lastPostedKey: 'kubo:main:1-12:release-time:2023-06-20T18:00:00.000+02:00',
    lastPostedAt: '2023-06-20T18:00:10+02:00'
  });
  assert.equal((await checkDueAnnouncements(store, discord, { now: releaseAt.minus({ seconds: 1 }), syncSeries: noSync })).posted, 0);
  assert.equal((await checkDueAnnouncements(store, discord, { now: releaseAt, syncSeries: noSync })).posted, 1);
  const post = store.snapshot().posts[0];
  assert.equal(post.episode, 1);
  assert.match(messages[0].fields.find(field => field.name.startsWith('Episode')).value, /01-12\/12/);
  assert.match(JSON.stringify(messages[0]), /Prime Video/);
  const finished = store.getSeries('kubo');
  assert.equal(finished.enabled, false);
  assert.equal(finished.status, 'finished');
  assert.equal(finished.nextEpisode, null);
  assert.equal(finished.nextDate, '');
  assert.equal(finished.streamingServiceId, 'KEEP');
  const reloaded = createStore(filename);
  await reloaded.init();
  assert.equal((await checkDueAnnouncements(reloaded, discord, { now: releaseAt.plus({ minutes: 1 }), syncSeries: noSync })).posted, 0);
  assert.equal(messages.length, 1);
});

test('a manual weekly release advances a single episode by seven days and does not repeat on the next tick', async (t) => {
  const { store, messages, discord } = await setup(t, { weekly: true, episodeBatchSize: 1, releaseTime: '18:00' });
  assert.equal((await checkDueAnnouncements(store, discord, { now: releaseAt, syncSeries: noSync })).posted, 1);
  assert.equal(store.getSeries('kubo').nextEpisode, 2);
  assert.equal(store.getSeries('kubo').nextDate, '2026-10-08');
  assert.equal((await checkDueAnnouncements(store, discord, { now: releaseAt.plus({ minutes: 1 }), syncSeries: noSync })).posted, 0);
  assert.equal((await checkDueAnnouncements(store, discord, { now: releaseAt.plus({ days: 7 }), syncSeries: noSync })).posted, 1);
  assert.equal(messages.length, 2);
});

test('a new manual German batch can post after an older original and German release', async (t) => {
  const { store, messages, discord } = await setup(t, { status: 'finished', nextEpisode: null,
    languageTracks: [{ code: 'de', enabled: true, nextEpisode: 1, nextDate: '2026-10-01',
      releaseTime: '', episodeBatchSize: 12, weekly: false,
      lastPostedKey: 'kubo:language:de:1-12:release-time:2023-06-20T18:00:00.000+02:00',
      lastPostedAt: '2023-06-20T18:00:10+02:00' }] });
  assert.equal((await checkDueAnnouncements(store, discord, { now: releaseAt, syncSeries: noSync })).posted, 1);
  assert.equal(store.snapshot().posts[0].type, 'auto-language');
  assert.match(messages[0].fields.find(field => field.name.startsWith('Episode')).value, /01-12\/12 \(German\)/);
  assert.equal(store.getSeries('kubo').enabled, false);
  assert.equal((await checkDueAnnouncements(store, discord, { now: releaseAt.plus({ minutes: 1 }), syncSeries: noSync })).posted, 0);
});

for (const kind of ['main', 'language']) {
  test(`a manual one-off ${kind} batch with unknown total waits for a new date after posting`, async (t) => {
    const { store, messages, discord } = await setup(t, { episodeCount: null, episodeBatchSize: 3,
      ...(kind === 'language' ? { status: 'finished', nextEpisode: null,
        languageTracks: [{ code: 'de', enabled: true, nextEpisode: 1, nextDate: '2026-10-01',
          releaseDay: 'thursday', releaseTime: '', episodeBatchSize: 3, weekly: false }] } : {}) });
    assert.equal((await checkDueAnnouncements(store, discord, { now: releaseAt, syncSeries: noSync })).posted, 1);
    const saved = store.getSeries('kubo');
    const release = kind === 'main' ? saved : saved.languageTracks.find(track => track.code === 'de');
    assert.equal(release.nextEpisode, 4);
    assert.equal(release.nextDate, '');
    assert.equal(release.releaseDay, '');
    assert.equal((await checkDueAnnouncements(store, discord, { now: releaseAt.plus({ minutes: 1 }), syncSeries: noSync })).posted, 0);
    assert.equal(messages.length, 1);
  });
}

test('switching to manual during a LiveChart request preserves the newly saved release and skips the stale post', async (t) => {
  const { store, messages, discord } = await setup(t, { scheduleMode: 'livechart', episodeBatchSize: 1, weekly: true });
  let answer, started;
  const gate = new Promise(resolve => { answer = resolve; });
  const waiting = new Promise(resolve => { started = resolve; });
  const run = checkDueAnnouncements(store, discord, { now: releaseAt,
    syncSeries: (targetStore, series, options) => syncOneSeriesFromLiveChart(targetStore, series, {
      ...options, fetchEpisodes: async () => { started(); return gate; }
    }) });
  await waiting;
  const edited = await store.upsertSeries({ ...store.getSeries('kubo'), scheduleMode: 'manual',
    service: 'Netflix', nextEpisode: 2, nextDate: '2026-10-08', releaseTime: '20:00' });
  answer({ nextEpisode: 2, episodeBatchSize: 1, mainScheduleKnown: true, mainReleaseTimestamp: null,
    service: 'Crunchyroll', languageTracks: [] });
  assert.equal((await run).posted, 0);
  assert.deepEqual(store.getSeries('kubo'), edited);
  assert.equal(messages.length, 0);
});
