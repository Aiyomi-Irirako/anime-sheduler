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
import { getNextLanguageRelease, isSeriesComplete } from '../src/schedule.js';

const releaseAt = DateTime.fromISO('2026-09-26T14:00:00', { zone: 'Europe/Berlin' });
const settings = { timeZone: 'Europe/Berlin', preferredScheduleLanguage: 'de', enabledLanguageCodes: ['de'] };
const id = 'iruma';
const lastPostedKey = `${id}:language:de:23:release-time:2026-09-19T14:00:00.000+02:00`;
const mainHtml = `<article data-release-schedule-release-schedule-id="1">
  <a href="/anime/12927/schedules/1">Released</a><a title="Simulcast: Subbed">Simulcast: Subbed</a>
  <span><svg><use href="#icon:subtitles"></use></svg></span><span data-tracklist-json="{&quot;de&quot;:[&quot;DE&quot;]}"></span>
  <span class="lc-text-contextual-accent">Crunchyroll</span></article>`;
const dubHtml = ({ date = releaseAt, episode = 24, code = 'de', confirmation = true } = {}) =>
  `<article data-release-schedule-release-schedule-id="18236">
  <a href="/anime/12927/schedules/18236"><time data-timestamp="${date.toSeconds()}" data-label="EP${episode}">EP${episode}</time>
  ${confirmation ? '<div>This release requires confirmation.</div>' : ''}</a>
  <a title="Simulcast: Dubbed">Simulcast: Dubbed</a>
  <span><svg><use href="#icon:audio"></use></svg></span><span data-tracklist-json="{&quot;${code}&quot;:[&quot;${code.toUpperCase()}&quot;]}"></span>
  <span class="lc-text-contextual-accent">Crunchyroll</span></article>`;

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anime-dub-release-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore(path.join(directory, 'db.json'));
  await store.init();
  await store.updateSettings({ ...store.getSettings(), ...settings });
  // Reproduce the backup: the dub episode survived, but its date and time were cleared.
  await store.upsertSeries({ id, title: 'Welcome to Demon School! Iruma-kun Season 4',
    service: 'Crunchyroll', scheduleLink: 'https://www.livechart.me/anime/12927/schedules',
    enabled: true, status: 'airing', nextEpisode: 24, episodeCount: 24,
    nextDate: '2026-09-26', releaseTime: '14:00', languageTracks: [{
      code: 'de', enabled: true, nextEpisode: 24, nextDate: '', releaseTime: '', releaseDay: '',
      lastPostedKey, lastPostedAt: '2026-09-19T14:00:29.835+02:00'
    }], ...overrides });
  const messages = [];
  const discord = { enabled: true, ready: true, async post(message) { messages.push(message.embeds[0].toJSON()); } };
  const sync = (html = mainHtml + dubHtml()) => (targetStore, series, options) =>
    syncOneSeriesFromLiveChart(targetStore, series, { ...options,
      fetchEpisodes: async (_, parseOptions) => parseLiveChartEpisodes(html, parseOptions) });
  return { store, discord, messages, sync };
}

test('a confirmation warning does not erase the dated German finale from a combined post', async (t) => {
  const { store, discord, messages, sync } = await setup(t);
  const now = releaseAt.plus({ seconds: 13 });
  assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries: sync() })).posted, 1);
  const version = messages[0].fields.find(field => field.name.startsWith('Version')).value;
  assert.match(version, /German/);
  assert.match(version, /Original/);
  assert.equal(messages[0].fields.find(field => field.name === 'Language versions').value, 'Episode 24/24 (German)');
  assert.equal(store.snapshot().posts[0].type, 'auto-combined');
  assert.equal(isSeriesComplete(store.getSeries(id)), true);
  await sync()(store, store.getSeries(id), { now: now.plus({ minutes: 1 }), overwriteSchedule: true });
  assert.equal(isSeriesComplete(store.getSeries(id)), true);
  assert.equal((await checkDueAnnouncements(store, discord, { now: now.plus({ minutes: 1 }), syncSeries: sync() })).posted, 0);
});

test('sync recovers the missing German finale within the posting window without repeating the original', async (t) => {
  const { store, discord, messages, sync } = await setup(t, { status: 'finished', nextEpisode: null,
    nextDate: '2026-10-03', lastPostedKey: `${id}:main:24:release-time:${releaseAt.toISO()}`,
    lastPostedAt: releaseAt.plus({ seconds: 13 }).toISO() });
  const now = releaseAt.plus({ minutes: 20 });
  await sync()(store, store.getSeries(id), { now, overwriteSchedule: true });
  const track = store.getSeries(id).languageTracks.find(item => item.code === 'de');
  assert.equal(track.nextDate, '2026-09-26');
  assert.equal(track.releaseTime, '14:00');
  assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries: sync() })).posted, 1);
  assert.equal(messages[0].fields.find(field => field.name.startsWith('Version')).value, 'German');
  assert.equal(store.snapshot().posts[0].type, 'auto-language');
  assert.equal(isSeriesComplete(store.getSeries(id)), true);
  await sync()(store, store.getSeries(id), { now: now.plus({ minutes: 1 }), overwriteSchedule: true });
  assert.equal((await checkDueAnnouncements(store, discord, { now: now.plus({ minutes: 1 }), syncSeries: sync() })).posted, 0);
  assert.equal(messages.length, 1);
});

test('a delayed German dub keeps its own date and is not posted at the original time', async (t) => {
  const { store, discord, sync } = await setup(t, { status: 'finished', nextEpisode: null,
    languageTracks: [{ code: 'de', enabled: true, nextEpisode: 24, nextDate: '2026-09-26', releaseTime: '14:00', lastPostedKey }] });
  const now = releaseAt.plus({ seconds: 13 });
  const syncSeries = sync(mainHtml + dubHtml({ date: releaseAt.plus({ days: 2 }) }));
  assert.equal((await checkDueAnnouncements(store, discord, { now, syncSeries })).posted, 0);
  const series = store.getSeries(id);
  const track = series.languageTracks.find(item => item.code === 'de');
  assert.equal(getNextLanguageRelease(series, track, settings, now).dateTime.toISODate(), '2026-09-28');
});

test('recent-release recovery is limited to an enabled, unposted episode and expires after six hours', () => {
  const html = dubHtml() + dubHtml({ code: 'en' });
  const track = { code: 'de', enabled: true, nextEpisode: 24, lastPostedKey };
  const parse = (pendingLanguageTracks, now = releaseAt.plus({ minutes: 20 })) => parseLiveChartEpisodes(html, {
    nowTimestamp: now.toSeconds(), pendingLanguageTracks, preferredLanguageCodes: ['de'], requirePreferredLanguage: true
  }).languageTracks;
  assert.deepEqual(parse([track]).map(item => item.code), ['de']);
  for (const tracks of [[], [{ ...track, enabled: false }], [{ ...track, nextEpisode: 25 }],
    [{ ...track, lastPostedKey: `${id}:language:de:24:release-time:${releaseAt.toISO()}` }],
    [{ ...track, lastPostedKey: `${id}:language:de:day:missing-time:${releaseAt.toISO()}`, lastPostedAt: releaseAt.toISO() }]]) {
    assert.deepEqual(parse(tracks), []);
  }
  assert.equal(parse([track], releaseAt.plus({ hours: 6 })).length, 1);
  assert.deepEqual(parse([track], releaseAt.plus({ hours: 6, seconds: 1 })), []);
});
