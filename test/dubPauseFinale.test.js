import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import { createStore } from '../src/store.js';
import { parseLiveChartEpisodes } from '../src/livechart.js';
import { syncOneSeriesFromLiveChart } from '../src/livechartSync.js';
import { checkDueAnnouncements } from '../src/scheduler.js';
import { isSeriesComplete } from '../src/schedule.js';

const releaseAt = DateTime.fromISO('2026-09-26T14:00:00', { zone: 'Europe/Berlin' });
const id = 'dub-finale';
const finalKey = `${id}:language:de:24:release-time:${releaseAt.toISO()}`;
const priorKey = `${id}:language:de:23:release-time:${releaseAt.minus({ days: 7 }).toISO()}`;
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de',
  enabledLanguageCodes: ['de'], reminderMinutes: 0 };

function row({ dub = false, released = true } = {}) {
  const scheduleId = dub ? '2' : '1';
  const header = released ? 'Released' :
    `<time data-timestamp="${releaseAt.toSeconds()}" data-label="EP24">EP24</time>`;
  return `<article data-release-schedule-release-schedule-id="${scheduleId}">
    <a href="/anime/123/schedules/${scheduleId}">${header}</a>
    <a title="Simulcast: ${dub ? 'Dubbed' : 'Subbed'}">Simulcast</a>
    <span><svg><use href="#icon:${dub ? 'audio' : 'subtitles'}"></use></svg></span>
    <span data-tracklist-json="{&quot;de&quot;:[&quot;DE&quot;]}"></span>
    <span class="lc-text-contextual-accent">Crunchyroll</span></article>`;
}

async function setup(t, { completed = false, reminderMinutes = 0, lastPostedAt } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-dub-pause-finale-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('anime-dub-pause-finale-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = createStore(path.join(directory, 'db.json'));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), ...settings, reminderMinutes });
  await store.upsertSeries({ id, title: 'Dub finale', service: 'Crunchyroll',
    scheduleLink: 'https://www.livechart.me/anime/123/schedules', scheduleMode: 'livechart',
    enabled: !completed, status: 'finished', nextEpisode: null, episodeCount: 24,
    nextDate: '', releaseTime: '', releaseDay: '',
    languageTracks: [{ code: 'de', enabled: !completed, nextEpisode: completed ? null : 24,
      nextDate: '2026-09-26', releaseDay: 'saturday', releaseTime: '14:00', weekly: true,
      lastPostedKey: completed ? finalKey : priorKey,
      lastPostedAt: lastPostedAt || releaseAt.minus({ days: 7 }).plus({ seconds: 10 }).toISO() }] });
  const messages = [];
  const discord = { enabled: true, ready: true, async post(message) { messages.push(message.embeds[0].toJSON()); } };
  const sync = (html) => (targetStore, series, options) => syncOneSeriesFromLiveChart(targetStore, series, {
    ...options, fetchEpisodes: async (_, parseOptions) => parseLiveChartEpisodes(html, parseOptions)
  });
  return { store, discord, messages, sync, getSeries: () => store.getSeries(id) };
}

test('a Released dub row preserves its due unposted finale and completes after exactly one post', async t => {
  const { store, discord, messages, sync, getSeries } = await setup(t);
  const syncSeries = sync(row() + row({ dub: true }));
  const now = releaseAt.plus({ seconds: 20 });
  assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries })).posted, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].fields.find(field => field.name.startsWith('Episode')).value, 'Episode 24/24 (German)');
  assert.equal(getSeries().languageTracks.find(track => track.code === 'de').lastPostedKey, finalKey);
  assert.equal(isSeriesComplete(getSeries()), true);
  await syncSeries(store, getSeries(), { now: now.plus({ minutes: 1 }), overwriteSchedule: true });
  assert.equal((await checkDueAnnouncements(store, discord, { now: now.plus({ minutes: 1 }), syncSeries })).posted, 0);
  assert.equal(messages.length, 1);
  assert.equal(isSeriesComplete(getSeries()), true);
});

test('a finale posted by an early reminder stays complete when LiveChart still shows its release timestamp', async t => {
  const { store, discord, messages, sync, getSeries } = await setup(t, { completed: true, reminderMinutes: 5,
    lastPostedAt: releaseAt.minus({ minutes: 5 }).toISO() });
  assert.equal(isSeriesComplete(getSeries()), true);
  const syncSeries = sync(row() + row({ dub: true, released: false }));
  const now = releaseAt.minus({ minutes: 4 });
  await syncSeries(store, getSeries(), { now, overwriteSchedule: true });
  const track = getSeries().languageTracks.find(item => item.code === 'de');
  assert.equal(track.nextEpisode, null);
  assert.equal(getSeries().enabled, false);
  assert.equal(isSeriesComplete(getSeries()), true);
  assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries })).posted, 0);
  assert.equal(messages.length, 0);
});

test('an absent dub row does not preserve an extrapolated finale', async t => {
  const { store, discord, messages, sync, getSeries } = await setup(t);
  const now = releaseAt.plus({ seconds: 20 });
  assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries: sync(row()) })).posted, 0);
  const track = getSeries().languageTracks.find(item => item.code === 'de');
  assert.equal(track.nextEpisode, 24);
  assert.equal(track.nextDate, '');
  assert.equal(track.releaseDay, '');
  assert.equal(messages.length, 0);
  assert.equal(isSeriesComplete(getSeries()), false);
});

test('a Released dub row does not recover a finale after its posting window expires', async t => {
  const { store, discord, messages, sync, getSeries } = await setup(t);
  const syncSeries = sync(row() + row({ dub: true }));
  const now = releaseAt.plus({ hours: 6, seconds: 1 });
  await syncSeries(store, getSeries(), { now, overwriteSchedule: true });
  assert.equal(getSeries().languageTracks.find(item => item.code === 'de').nextDate, '');
  assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries })).posted, 0);
  assert.equal(messages.length, 0);
});

test('an already posted finale is not reactivated by a Released dub row', async t => {
  const { store, discord, messages, sync, getSeries } = await setup(t, { completed: true,
    lastPostedAt: releaseAt.plus({ seconds: 10 }).toISO() });
  const syncSeries = sync(row() + row({ dub: true }));
  const now = releaseAt.plus({ minutes: 1 });
  await syncSeries(store, getSeries(), { now, overwriteSchedule: true });
  assert.equal(getSeries().languageTracks.find(item => item.code === 'de').nextEpisode, null);
  assert.equal(isSeriesComplete(getSeries()), true);
  assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries })).posted, 0);
  assert.equal(messages.length, 0);
});
