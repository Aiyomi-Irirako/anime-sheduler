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

const now = DateTime.fromISO('2026-10-31T17:46:00', { zone: 'Europe/Berlin' });
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de',
  enabledLanguageCodes: ['de'], automaticDiscordPostsEnabled: true, reminderMinutes: 0 };
const id = 'finished-original-pending-dub';

function row({ dub = false, code = 'de', header = 'Released' } = {}) {
  return `<article data-controller="release-schedule"><a href="/anime/123/schedules/${dub ? '2' : '1'}"></a>
    <div><time>${header}</time></div><div title="Simulcast: ${dub ? 'Dubbed' : 'Subbed'}">Simulcast</div>
    <span data-release-schedule-info-target="${dub ? 'auralTracklist' : 'textualTracklist'}"
      data-tracklist-data='{"${code}":[["${code}"],["Language"]]}'>${code}</span>
    <span class="lc-text-contextual-accent">Crunchyroll</span></article>`;
}

async function setup(t, { total = 24, next = 24, posted = 23, track = {}, ...overrides } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-explicit-dub-completion-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'isolated-db.json'));
  await store.init();
  await store.replaceData({ ...store.snapshot(), settings: { ...store.getSettings(), ...settings }, series: [{
    id, title: 'Original complete with a pending German dub',
    scheduleLink: 'https://www.livechart.me/anime/123/schedules', scheduleMode: 'livechart',
    status: 'finished', enabled: true, episodeCount: total, nextEpisode: null,
    nextDate: '', releaseTime: '', releaseDay: '',
    lastPostedKey: `${id}:main:${total || 24}:release-time:2026-09-30T16:00:00.000+02:00`,
    lastPostedAt: '2026-09-30T16:00:30+02:00',
    languageTracks: [{ code: 'de', enabled: true, available: true,
      nextEpisode: next, nextDate: '', releaseTime: '', releaseDay: '', weekly: true,
      lastPostedKey: `${id}:language:de:${posted}:release-time:2026-10-24T11:30:00.000+02:00`,
      lastPostedAt: '2026-10-24T11:30:30+02:00', ...track }], ...overrides
  }] });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  const sync = (html, at = now) => syncOneSeriesFromLiveChart(store, store.getSeries(id), {
    now: at, overwriteSchedule: true,
    fetchEpisodes: async (_, options) => parseLiveChartEpisodes(html, options)
  });
  return { store, sync, series: () => store.getSeries(id), dub: () => store.getSeries(id).languageTracks.find(track => track.code === 'de') };
}

for (const example of [
  { title: 'the Bookworm backup shape', total: 24, next: 24, posted: 23, missingStart: 24 },
  { title: 'the Re:ZERO backup shape', total: 19, next: 18, posted: 14, missingStart: 15 }
]) {
  test(`explicit Released closes ${example.title} and retains a truthful catch-up range`, async (t) => {
    const { store, sync, series, dub } = await setup(t, example);
    const before = structuredClone(series());
    await sync(row() + row({ dub: true }));
    assert.equal(dub().enabled, false);
    assert.equal(dub().nextEpisode, null);
    assert.equal(dub().nextDate, '');
    assert.equal(series().enabled, false);
    assert.equal(isSeriesComplete(series()), true);
    assert.ok(series().finishedAt);
    assert.equal(series().lastPostedKey, before.lastPostedKey);
    assert.equal(dub().lastPostedKey, before.languageTracks[0].lastPostedKey);
    assert.equal(dub().lastPostedAt, before.languageTracks[0].lastPostedAt);
    const notices = series().releaseCompletionNotices;
    assert.equal(notices.length, 1);
    assert.equal(notices[0].episodeStart, example.missingStart);
    assert.equal(notices[0].episodeEnd, example.total);
    assert.equal(notices[0].languageCode, 'de');
    assert.equal(notices[0].notifiedAt, '');
    const first = structuredClone(notices);
    await sync(row() + row({ dub: true }), now.plus({ minutes: 1 }));
    assert.deepEqual(series().releaseCompletionNotices, first);
    assert.equal(isSeriesComplete(series()), true);
    assert.equal(store.snapshot().posts.length, 0);
  });
}

test('an explicit completed dub with unknown episode total still completes without guessing a range', async (t) => {
  const { sync, series, dub } = await setup(t, { total: null, next: 18, posted: 14 });
  await sync(row() + row({ dub: true }));
  assert.equal(dub().nextEpisode, null);
  assert.equal(isSeriesComplete(series()), true);
  assert.equal(series().releaseCompletionNotices.length, 1);
  assert.equal(series().releaseCompletionNotices[0].episodeStart, null);
  assert.equal(series().releaseCompletionNotices[0].episodeEnd, null);
});

test('a due finale inside six hours remains pending for its normal episode announcement', async (t) => {
  const releaseAt = now.minus({ seconds: 20 });
  const { store, sync, series, dub } = await setup(t, { track: {
    nextDate: releaseAt.toISODate(), releaseTime: releaseAt.toFormat('HH:mm')
  } });
  // Match the exact minute boundary used by the saved release time.
  const at = releaseAt.startOf('minute').plus({ seconds: 20 });
  await sync(row() + row({ dub: true }), at);
  assert.equal(dub().nextEpisode, 24);
  assert.ok(dub().nextDate);
  assert.equal(isSeriesComplete(series()), false);
  assert.deepEqual(series().releaseCompletionNotices, []);
  const messages = [];
  const discord = { enabled: true, ready: true, async post(message) {
    messages.push(message.embeds[0].toJSON());
    return { sent: [{ channelId: '111111111111111111' }], failed: [] };
  } };
  const result = await checkDueAnnouncements(store, discord, { now: at,
    syncSeries: async () => ({ changed: false, live: parseLiveChartEpisodes(row() + row({ dub: true }), {
      nowTimestamp: at.toSeconds(), preferredLanguageCodes: ['de'], pendingLanguageTracks: series().languageTracks
    }), updated: series() }) });
  assert.equal(result.posted, 1);
  assert.equal(messages.length, 1);
  assert.equal(isSeriesComplete(series()), true);
  assert.deepEqual(series().releaseCompletionNotices, []);
});

test('an expired final episode closes only when the language has an explicit Released source', async (t) => {
  const releaseAt = now.minus({ hours: 7 });
  const { sync, series, dub } = await setup(t, { track: {
    nextDate: releaseAt.toISODate(), releaseTime: releaseAt.toFormat('HH:mm')
  } });
  await sync(row() + row({ dub: true }));
  assert.equal(dub().nextEpisode, null);
  assert.equal(isSeriesComplete(series()), true);
  assert.equal(series().releaseCompletionNotices[0].episodeStart, 24);
});

for (const source of ['missing', 'undated', 'expired']) {
  test(`a ${source} dub source remains paused rather than falsely complete`, async (t) => {
    const { sync, series, dub } = await setup(t, { total: 19, next: 18, posted: 14 });
    const header = source === 'expired'
      ? `<span data-label="EP18" data-timestamp="${now.minus({ days: 2 }).toSeconds()}">EP18</span>`
      : '<span data-label="EP18">EP18: Time TBD</span>';
    await sync(row() + (source === 'missing' ? '' : row({ dub: true, header })));
    assert.equal(dub().nextEpisode, 18);
    assert.equal(dub().nextDate, '');
    assert.equal(isSeriesComplete(series()), false);
    assert.deepEqual(series().releaseCompletionNotices, []);
  });
}

test('a released foreign dub does not close a pending German version', async (t) => {
  const { sync, series, dub } = await setup(t, { total: 19, next: 18, posted: 14 });
  await sync(row() + row({ dub: true, code: 'en' }));
  assert.equal(dub().nextEpisode, 18);
  assert.equal(isSeriesComplete(series()), false);
  assert.deepEqual(series().releaseCompletionNotices, []);
});

test('a dub preview ending early does not prove the entire language version is complete', async (t) => {
  const { sync, series, dub } = await setup(t, { total: 19, next: 18, posted: 14 });
  await sync(row() + row({ dub: true, header: 'Release ended with EP17' }));
  assert.equal(dub().nextEpisode, 18);
  assert.equal(isSeriesComplete(series()), false);
  assert.deepEqual(series().releaseCompletionNotices, []);
});
